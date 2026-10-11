-- ==========================================================================
-- CitrusGuard - ONE-PASTE SETUP
-- ==========================================================================
-- GENERATED FILE - do not hand-edit.
-- Regenerate with:  python scripts/generate_model_registration.py
--
-- PART A is the schema (supabase/combined_migration.sql). It is NOT idempotent
-- - it uses bare `create table` / `create type` - so run this file exactly ONCE
-- on a database where the migrations have never been applied. Running it twice
-- will fail on `type ... already exists`, which is the intended signal.
--
-- PART B registers the real, already-trained model and is idempotent.
--
-- How to run:
--   Supabase Dashboard -> your project -> SQL Editor -> New query
--   paste this whole file -> Run.
-- ==========================================================================

-- ##########################################################################
-- PART A - schema
-- ##########################################################################

-- ---- 0001_core_schema.sql ----------------------------------------------
-- =====================================================================
-- CitrusGuard - 0001 core schema
--
-- Tables, constraints, indexes, triggers, RLS and storage policies.
-- Run with:  supabase db push
--       or:  psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_core_schema.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.user_role       as enum ('admin', 'user');
create type public.dataset_status  as enum ('pending', 'downloading', 'validating', 'ready', 'failed');
create type public.model_status     as enum ('candidate', 'production', 'retired', 'failed');
create type public.input_type       as enum ('leaf', 'fruit');
create type public.health_status    as enum ('healthy', 'diseased');
create type public.prediction_state as enum ('ok', 'low_confidence', 'rejected_quality', 'failed');

-- ---------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- profiles
-- One row per authenticated user, created by the signup trigger.
-- =====================================================================
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  role        public.user_role not null default 'user',
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Application user profile. role is the single source of truth for authorization; never trust a role claim from the client.';

create index profiles_role_idx on public.profiles (role);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- is_admin() - SECURITY DEFINER so RLS policies can call it without
-- recursing through profiles' own RLS policy.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- Handle new signups. SECURITY DEFINER because the trigger runs as the
-- auth service, not as the new user.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- dataset_metadata
-- One row per (dataset_name, version). Written only by the service role.
-- =====================================================================
create table public.dataset_metadata (
  id             uuid primary key default gen_random_uuid(),
  dataset_name   text not null,
  version        text not null,
  source_url     text not null,
  landing_page   text,
  license        text,
  license_url    text,
  doi            text,
  attribution    text,
  checksum       text,
  image_count    integer check (image_count is null or image_count >= 0),
  class_count    integer check (class_count is null or class_count >= 0),
  classes        text[] not null default '{}',
  parts          text[] not null default '{}',
  counts_by_part jsonb not null default '{}'::jsonb,
  status         public.dataset_status not null default 'pending',
  storage_path   text,
  downloaded_at  timestamptz,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (dataset_name, version)
);

comment on table public.dataset_metadata is
  'Inventory of the public citrus dataset. Populated by `python -m citrusguard supabase sync-dataset`; never inserted with invented values.';

create index dataset_metadata_status_idx on public.dataset_metadata (status);
create index dataset_metadata_name_idx on public.dataset_metadata (dataset_name);

create trigger dataset_metadata_set_updated_at
  before update on public.dataset_metadata
  for each row execute function public.set_updated_at();

-- =====================================================================
-- model_versions
-- Immutable per training run. One row may have status='production'.
-- =====================================================================
create table public.model_versions (
  id                   uuid primary key default gen_random_uuid(),
  model_name           text not null,
  version              text not null,
  dataset_id           uuid references public.dataset_metadata (id) on delete set null,
  dataset_version      text,
  model_architecture   text,
  storage_path         text not null,
  classes              text[] not null default '{}',
  classes_by_part      jsonb not null default '{}'::jsonb,
  input_size           integer[],
  preprocessing_method text,
  -- NULL means "not measured". The UI renders NULL as "Not available";
  -- it must never be defaulted to 0 or to a placeholder value.
  validation_accuracy  double precision check (validation_accuracy is null or (validation_accuracy >= 0 and validation_accuracy <= 1)),
  test_accuracy        double precision check (test_accuracy is null or (test_accuracy >= 0 and test_accuracy <= 1)),
  model_checksum       text,
  trained_at           timestamptz,
  promoted_at          timestamptz,
  part_summary         jsonb not null default '{}'::jsonb,
  severity_support     jsonb not null default '{"enabled": false}'::jsonb,
  training_report_path text,
  status               public.model_status not null default 'candidate',
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (model_name, version)
);

comment on column public.model_versions.validation_accuracy is
  'Measured validation accuracy in [0,1]. NULL when evaluation did not run - never fabricate.';
comment on column public.model_versions.test_accuracy is
  'Measured test accuracy in [0,1]. NULL when evaluation did not run - never fabricate.';

create index model_versions_status_idx on public.model_versions (status);
create index model_versions_dataset_idx on public.model_versions (dataset_id);

create trigger model_versions_set_updated_at
  before update on public.model_versions
  for each row execute function public.set_updated_at();

-- Only one production model per model_name.
create unique index model_versions_single_production_idx
  on public.model_versions (model_name)
  where status = 'production';

-- =====================================================================
-- disease_information
-- Admin-managed reference content. Seeded only with the classes that
-- actually exist in the discovered dataset.
-- =====================================================================
create table public.disease_information (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  -- 'leaf' / 'fruit' / 'both' - matches the dataset parts that contain it.
  applies_to    text[] not null default '{}',
  is_healthy    boolean not null default false,
  short_description text not null,
  symptoms      text[] not null default '{}',
  prevention    text[] not null default '{}',
  management    text[] not null default '{}',
  references    text[] not null default '{}',
  -- Free-form "not available yet" reasons for guidance we do not have.
  content_complete boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index disease_information_applies_to_idx on public.disease_information using gin (applies_to);

create trigger disease_information_set_updated_at
  before update on public.disease_information
  for each row execute function public.set_updated_at();

-- =====================================================================
-- scans
-- =====================================================================
create table public.scans (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  image_path         text not null,
  processed_path     text,
  explanation_path   text,
  heatmap_path       text,
  input_type         public.input_type,
  input_type_confidence double precision check (input_type_confidence is null or (input_type_confidence >= 0 and input_type_confidence <= 1)),
  predicted_class    text,
  predicted_class_display text,
  confidence         double precision not null check (confidence >= 0 and confidence <= 1),
  status             public.health_status,
  prediction_state   public.prediction_state not null default 'ok',
  is_low_confidence  boolean not null default false,
  severity           text check (severity is null or severity in ('early', 'moderate', 'severe')),
  -- JSONB snapshot of the full model probability vector.
  probabilities      jsonb not null default '[]'::jsonb,
  part_probabilities jsonb not null default '[]'::jsonb,
  quality_metrics    jsonb,
  explanation_note   text,
  model_version      text,
  model_name         text,
  dataset_version    text,
  latency_ms         integer,
  error_code         text,
  created_at         timestamptz not null default now()
);

comment on table public.scans is
  'One row per user scan. RLS restricts every operation to auth.uid().';

-- Hot paths: "my recent scans" and admin aggregates.
create index scans_user_created_idx on public.scans (user_id, created_at desc);
create index scans_user_status_idx on public.scans (user_id, status);
create index scans_predicted_class_idx on public.scans (predicted_class);
create index scans_model_version_idx on public.scans (model_version);
create index scans_created_idx on public.scans (created_at desc);
create index scans_probabilities_gin on public.scans using gin (probabilities);

-- =====================================================================
-- RLS: profiles
-- =====================================================================
alter table public.profiles enable row level security;

-- Users read their own profile; they never read anyone else's.
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- Users may update only their own profile, and may not change their own role.
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select p.role from public.profiles p where p.id = auth.uid()));

-- Admins read any profile (admin dashboard only).
create policy profiles_select_admin
  on public.profiles for select
  to authenticated
  using (public.is_admin());

-- No insert policy: rows are created by handle_new_user() only.
-- No delete policy: profiles are removed with the auth user.

-- =====================================================================
-- RLS: scans  (the core user-isolation guarantee)
-- =====================================================================
alter table public.scans enable row level security;

create policy scans_select_own
  on public.scans for select
  to authenticated
  using (user_id = auth.uid());

-- A user may insert only a row that belongs to them. The `predicted_class`
-- is not restricted here; scan integrity is enforced server-side.
create policy scans_insert_own
  on public.scans for insert
  to authenticated
  with check (user_id = auth.uid());

-- Users may delete their own history. There is deliberately no UPDATE policy:
-- a scan is an immutable record of what the model predicted.
create policy scans_delete_own
  on public.scans for delete
  to authenticated
  using (user_id = auth.uid());

-- Admins read scans for aggregate statistics.
create policy scans_select_admin
  on public.scans for select
  to authenticated
  using (public.is_admin());

-- =====================================================================
-- RLS: dataset_metadata / model_versions / disease_information
-- Readable by any signed-in user (the Detect page needs the class list);
-- writable only by the service role, which bypasses RLS.
-- =====================================================================
alter table public.dataset_metadata enable row level security;
alter table public.model_versions enable row level security;
alter table public.disease_information enable row level security;

create policy dataset_metadata_select_authenticated
  on public.dataset_metadata for select
  to authenticated using (true);

create policy model_versions_select_authenticated
  on public.model_versions for select
  to authenticated using (true);

create policy disease_information_select_public
  on public.disease_information for select
  to anon, authenticated using (true);

-- Disease content is curated by admins only.
create policy disease_information_admin_write
  on public.disease_information for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Explicitly deny client writes on the dataset/model tables by simply not
-- granting any insert/update/delete policy. The service role bypasses RLS.
revoke insert, update, delete on public.dataset_metadata from authenticated, anon;
revoke insert, update, delete on public.model_versions from authenticated, anon;

-- =====================================================================
-- Storage buckets (idempotent)
-- All three are PRIVATE. Scan images are read through signed URLs issued by
-- the server after an ownership check.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('citrus-dataset', 'citrus-dataset', false, 536870912, null),
  ('trained-models', 'trained-models',  false, 1073741824, null),
  ('scan-images',    'scan-images',     false, 20971520,
     array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- scan-images policies
-- Object keys are: {user_id}/{scan_id}/{original|processed|explanation}/*
-- The first path segment must equal the caller's uid, so one user can never
-- read or overwrite another user's scans even with a crafted key.
-- ---------------------------------------------------------------------
create policy scan_images_select_own
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy scan_images_insert_own
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy scan_images_delete_own
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'scan-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No UPDATE policy on scan-images: uploaded artefacts are immutable.

-- ---------------------------------------------------------------------
-- Dataset and model buckets: NO client policies at all.
-- Anonymous and authenticated clients therefore have no access; every
-- upload/download goes through the server using the service-role key.
-- ---------------------------------------------------------------------
revoke all on storage.objects from anon, authenticated;
-- Re-grant read on the other two buckets only to the service role
-- (service role bypasses RLS entirely, so no policy is required).

-- ---------------------------------------------------------------------
-- Helper: emit signed URLs only for objects the caller owns.
-- ---------------------------------------------------------------------
create or replace function public.owns_scan_object(object_name text)
returns boolean
language sql
stable
as $$
  select (storage.foldername(object_name))[1] = auth.uid()::text;
$$;

-- ---- 0002_reference_content.sql ----------------------------------------
-- =====================================================================
-- CitrusGuard - 0002 reference content + storage helpers
--
-- Seeds `disease_information` for exactly the classes that exist in the
-- published dataset, and adds the RPCs the server uses.
--
-- The class slugs below were derived from the archive by walking
-- `Citrus/<Fruits|Leaves>/<class>/` (see ml/citrusguard/dataset/classes.py).
-- Nothing is seeded for a class the dataset does not contain.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Disease reference content
--
-- Content rules, applied to every row:
--   * general, publicly documented horticultural information;
--   * no specific pesticide, dose, or product names;
--   * treatment decisions explicitly deferred to a local expert.
-- ---------------------------------------------------------------------
insert into public.disease_information
  (slug, display_name, applies_to, is_healthy, short_description, symptoms, prevention, management, references)
values
  (
    'black-spot',
    'Black Spot',
    array['leaf', 'fruit'],
    false,
    'A fungal disease that produces dark, roughly circular lesions on leaves and fruit. On leaves the spots are typically surrounded by a yellow halo; on fruit the rind shows raised, dark, velvety lesions.',
    array[
      'Round to irregular dark brown or black spots on the upper leaf surface',
      'A yellow halo (chlorotic margin) around many leaf spots',
      'Spots may merge into larger blotches as the disease progresses',
      'Affected leaves turn yellow and drop prematurely (defoliation)',
      'On fruit, dark raised lesions with a rough, sandpaper-like texture',
      'Premature fruit drop and reduced fruit quality when infection is heavy'
    ],
    array[
      'Prune and destroy infected leaves and dead twigs; do not leave infected debris in the orchard',
      'Improve air circulation by keeping the canopy open with regular pruning',
      'Avoid overhead irrigation and keep water off the foliage; irrigate at the base instead',
      'Mulch under trees to reduce soil splash onto lower leaves and fruit',
      'Remove fallen leaves and fruit from the orchard floor during the dormant season',
      'Use disease-free nursery stock and disinfect pruning tools between trees'
    ],
    array[
      'Start with a confirmed diagnosis from a local extension service before acting',
      'Where a registered fungicide is recommended locally, apply it on a label-approved schedule beginning early in the disease cycle',
      'Alternate or rotate labelled active ingredients to slow resistance development',
      'Remove and destroy heavily infected tissue; fungicides protect new growth, they do not repair existing lesions',
      'Keep trees adequately watered and mulched to reduce stress-related susceptibility'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'FAO and national plant-protection department citrus disease guides'
    ]
  ),
  (
    'canker',
    'Canker',
    array['leaf', 'fruit'],
    false,
    'A contagious bacterial disease. It forms raised, corky, crater-like lesions on leaves, fruit and twigs, often with a yellow halo on the leaf. It spreads mainly through wind-driven rain and is aggravated by citrus leafminer feeding.',
    array[
      'Raised, corky or crater-like lesions with a tan or grey centre',
      'A distinct yellow halo surrounding lesions on leaves',
      'Lesions visible on both sides of the leaf',
      'Rough, raised pustule-like spots on fruit, sometimes cracking as the fruit grows',
      'Lesions on young twigs and, in severe cases, dieback of small branches',
      'Defoliation and premature fruit drop when infection is heavy'
    ],
    array[
      'Plant certified disease-free nursery stock; canker spreads readily through infected propagative material',
      'Prune infected twigs during dry weather and sterilise tools between cuts',
      'Manage citrus leafminer, since leafminer-created wounds are a major entry point for the bacteria',
      'Maintain a windbreak or hedge to reduce wind-driven rain and mechanical injury',
      'Do not work in orchards when the canopy is wet; avoid moving equipment through wet foliage',
      'Remove infected material promptly and dispose of it away from the production area'
    ],
    array[
      'Have the diagnosis confirmed by a plant pathologist or extension officer; several conditions look similar',
      'Copper-containing bactericides are used in some regions under local label guidance; efficacy is local and label-specific',
      'Prune out and destroy infected tissue during dry conditions',
      'Control leafminer and any other insect that wounds young flush, reducing new infection sites',
      'Expect that heavily infected blocks may require a longer-term orchard renovation plan; seek professional advice'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'National plant quarantine and plant-protection department guidance'
    ]
  ),
  (
    'greening',
    'Greening (Huanglongbing)',
    array['leaf', 'fruit'],
    false,
    'A destructive disease associated with bacteria carried by psyllid insects. It disrupts the tree''s phloem, so the canopy develops blotchy, asymmetric yellowing that is not confined by leaf veins, along with small, lopsided, poorly coloured fruit.',
    array[
      'Blotchy, irregular yellowing of leaves that crosses leaf veins (mottled rather than vein-defined)',
      'Yellowing that is asymmetric within the canopy, often on one branch',
      'Small, upright shoots with pale, narrow leaves',
      'Fruit that are small, lopsided, and remain green at the stem end when ripe',
      'Unbalanced or bitter-tasting fruit with aborted seeds',
      'Progressive twig dieback and canopy thinning over time'
    ],
    array[
      'Use certified, pathogen-free nursery stock from a reputable source',
      'Control psyllid vectors with locally approved methods and monitor their population',
      'Remove infected trees promptly once confirmed, following local regulatory requirements',
      'Avoid moving plant material between regions; many jurisdictions restrict transport of citrus',
      'Maintain tree vigour with correct irrigation and nutrition, which does not cure infection but limits stress',
      'Keep new plantings at a density that allows inspection and vector management'
    ],
    array[
      'There is no curative treatment for an infected tree; management focuses on prevention and vector control',
      'Confirm the diagnosis through an authoritative laboratory, as symptoms overlap with nutrient deficiencies',
      'Follow local reporting and quarantine rules, which commonly apply to this disease',
      'Plan psyllid control for the whole district rather than isolated blocks; vector control fails at single-tree scale',
      'Consult an extension specialist about replanting strategy and rootstock choice'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'National plant-protection department and citrus industry authority guidance'
    ]
  ),
  (
    'melanose',
    'Melanose',
    array['leaf'],
    false,
    'A fungal disease of citrus leaves and twigs. It produces small, raised, dark brown to black rough spots that give infected tissue a sandpaper-like feel. In this dataset the class is represented by leaf images only.',
    array[
      'Small, raised, dark brown to black spots on the leaf surface',
      'A distinctly rough, sandpaper-like texture when the leaf is rubbed',
      'Spots that may merge into irregular dark patches on older leaves',
      'Occasional twig lesions on young, susceptible flush',
      'Cosmetic damage on fruit in severe seasons, though leaf symptoms are the focus here'
    ],
    array[
      'Prune dead and infected twigs, which carry the fungus between flushes',
      'Reduce leaf wetness by improving drainage and avoiding late-day overhead irrigation',
      'Keep the canopy open so humid pockets are less likely to develop',
      'Remove infected leaf litter from the orchard floor',
      'Avoid wounding the bark during cultural operations; wounds are infection courts'
    ],
    array[
      'Confirm the diagnosis locally; melanose is frequently confused with other leaf spot diseases',
      'Where a registered fungicide is advised for your region, follow the label schedule and observe pre-harvest intervals',
      'Target the timing of protection to new flush, which is the most susceptible tissue',
      'Combine chemical and cultural measures; pruning without moisture management gives limited results'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'Citrus research institute disease fact sheets'
    ]
  ),
  (
    'scab',
    'Scab',
    array['fruit'],
    false,
    'A fungal disease that mainly affects fruit. It forms wart-like, corky protrusions that break the rind surface and can distort young fruit, causing cosmetic damage and raising the risk of citrus canker entering through the lesions. In this dataset the class is represented by fruit images only.',
    array[
      'Small water-soaked spots that become raised, wart-like or corky',
      'Protrusions that may coalesce into rough, scabby areas on the rind',
      'Distortion and deformation of young, newly set fruit',
      'A corky, cracked surface that is cosmetically unacceptable for fresh market',
      'Scabs that can serve as entry points for other pathogens, including canker'
    ],
    array[
      'Protect the fruit-setting period most rigorously, since fruit are most susceptible while very young',
      'Prune to open the canopy and improve airflow, reducing humidity around young fruit',
      'Remove infected fruit and fallen debris from the orchard floor',
      'Time irrigation to avoid prolonged leaf and fruit wetness',
      'Monitor the orchard through the fruit-set window, when targeted protection is most effective'
    ],
    array[
      'Confirm the diagnosis with a local extension officer, as scab is often confused with canker or melanose',
      'Where a registered fungicide is recommended locally, focus applications on the fruit-set period',
      'Rotate labelled active ingredients and observe all label restrictions and pre-harvest intervals',
      'Reduce inoculum by removing mummified and fallen fruit before the next season'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'Citrus research institute disease fact sheets'
    ]
  ),
  (
    'healthy',
    'Healthy',
    array['leaf', 'fruit'],
    true,
    'No visible symptoms of the diseases covered by this model were detected. A healthy result means this model found no evidence of its trained disease classes in the image; it is not a laboratory diagnosis and cannot rule out conditions outside the model''s scope.',
    array[
      'Normal leaf colour and texture for the cultivar, without the lesions or mottling of the modelled diseases',
      'No raised corky spots, no dark circular lesions, no asymmetric yellowing',
      'Fruit surface free of the wart-like scab lesions and dark spots of the modelled diseases',
      'No visible dieback or premature defoliation attributable to a modelled disease'
    ],
    array[
      'Continue routine orchard hygiene: remove dead tissue and fallen leaves, and keep the canopy open',
      'Monitor fruit and foliage through the season so early symptoms are noticed while still minor',
      'Keep irrigation consistent and avoid prolonged leaf wetness',
      'Use certified disease-free nursery stock for new plantings',
      'Inspect regularly, especially after wet weather, which favours several of these diseases'
    ],
    array[
      'No disease treatment is indicated by this result',
      'Re-scan if symptoms develop or change, since a single image cannot represent a whole tree',
      'If the plant looks unwell overall, seek advice from a local agricultural expert, as causes outside this model''s classes (nutrient deficiency, water stress, root problems, pests) are not assessed here'
    ],
    array[
      'Local agricultural extension service publications for your region'
    ]
  )
on conflict (slug) do update
set display_name    = excluded.display_name,
    applies_to      = excluded.applies_to,
    is_healthy      = excluded.is_healthy,
    short_description = excluded.short_description,
    symptoms        = excluded.symptoms,
    prevention      = excluded.prevention,
    management      = excluded.management,
    references      = excluded.references,
    updated_at      = now();

-- ---------------------------------------------------------------------
-- Cross-check: the model's class list must match the reference content.
-- Exposed as an RPC so the admin panel can prove the two agree rather than
-- letting the UI silently render an empty guide for a real class.
-- ---------------------------------------------------------------------
create or replace function public.class_content_gaps()
returns table (slug text, has_content boolean)
language sql
stable
as $$
  select
    c.slug,
    exists (
      select 1 from public.disease_information d where d.slug = c.slug
    ) as has_content
  from (
    select unnest(coalesce(classes, '{}'::text[])) as slug
    from public.model_versions
    where status = 'production'
    order by version desc
    limit 1
  ) c;
$$;

grant execute on function public.class_content_gaps() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Aggregate statistics for the admin dashboard.
-- Service-role only: it intentionally has no anon/authenticated grant, so a
-- normal user cannot enumerate other users' activity.
-- ---------------------------------------------------------------------
create or replace function public.admin_system_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- Defence in depth: the function is only useful to an admin.
  if not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_users',        (select count(*) from public.profiles),
    'total_scans',        (select count(*) from public.scans),
    'scans_last_7_days',  (select count(*) from public.scans where created_at > now() - interval '7 days'),
    'healthy_scans',      (select count(*) from public.scans where status = 'healthy'),
    'diseased_scans',     (select count(*) from public.scans where status = 'diseased'),
    'low_confidence',     (select count(*) from public.scans where is_low_confidence),
    'failed_scans',       (select count(*) from public.scans where prediction_state = 'failed'),
    'by_input_type', (
      select coalesce(jsonb_object_agg(input_type, n), '{}'::jsonb)
      from (select input_type, count(*) as n from public.scans group by input_type) t
    ),
    'by_class', (
      select coalesce(jsonb_object_agg(predicted_class, n), '{}'::jsonb)
      from (select predicted_class, count(*) as n from public.scans group by predicted_class) t
    ),
    'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) into result;

  return result;
end;
$$;

revoke execute on function public.admin_system_stats() from public, anon;
-- Granted to authenticated, NOT because anonymous callers should see it, but
-- because the function is SECURITY DEFINER and re-checks `public.is_admin()`
-- on every call. The grant is what lets the admin dashboard reach it with the
-- RLS-scoped client instead of handing the service-role key to the browser.
grant execute on function public.admin_system_stats() to authenticated, service_role;

-- ---- 0003_model_activation.sql -----------------------------------------
-- =====================================================================
-- CitrusGuard - 0003 atomic model activation
--
-- Promoting a model touches two things that must never disagree:
--   * `model_versions.status` - which version the API serves;
--   * the artifact prefix in Supabase Storage - which bytes it loads.
--
-- Doing that as two statements leaves a window where Postgres says v2 while
-- Storage still holds v1. This function performs the status flip inside one
-- transaction, so a reader either sees the old version fully or the new one
-- fully. The upload itself happens first and is idempotent, so a crash between
-- upload and activation simply leaves the new version as a candidate.
-- =====================================================================

-- ---------------------------------------------------------------------
-- activate_model_version
--
-- Demotes every other version of this model to 'retired' and promotes the
-- named one, in one transaction. Raises if the version does not exist, so a
-- typo cannot silently leave the app with no production model.
--
-- SECURITY: guarded on public.is_admin() *and* on the caller being a service
-- role. Model metadata is not user-writable, so a plain authenticated user
-- must not be able to promote a candidate they uploaded.
-- ---------------------------------------------------------------------
create or replace function public.activate_model_version(p_version text)
returns public.model_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.model_versions;
  v_is_service_role boolean;
begin
  -- `auth.role()` returns 'service_role' when the request came through the
  -- service key. Together with is_admin() this covers both the admin UI and
  -- the Python publisher.
  select coalesce(auth.role(), '') = 'service_role' into v_is_service_role;

  if not (v_is_service_role or public.is_admin()) then
    raise exception 'Admin access required to activate a model version.'
      using errcode = '42501';
  end if;

  select * into v_row
  from public.model_versions
  where version = p_version
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'Model version % does not exist.', p_version
      using errcode = 'P0002';
  end if;

  -- Retire the incumbent. `retired` rather than `failed`: the previous model
  -- still works, it simply is not the one being served.
  update public.model_versions
     set status = 'retired',
         promoted_at = null
   where model_name = v_row.model_name
     and status = 'production'
     and id <> v_row.id;

  update public.model_versions
     set status = 'production',
         promoted_at = now()
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.activate_model_version(text) is
  'Atomically make one model version the production model. Demotes the previous one to ''retired''. Callable by admins and by the service role only.';

revoke execute on function public.activate_model_version(text) from public, anon, authenticated;
grant execute on function public.activate_model_version(text) to service_role;

-- ---------------------------------------------------------------------
-- record_model_version
--
-- Upserts the row describing a trained bundle. Used by
-- `python -m citrusguard supabase push-model`. Server-only: it accepts the
-- metrics measured by the training run verbatim, so it must not be reachable
-- from the browser.
--
-- `p_part_summary` and `p_severity_support` are JSON documents produced by the
-- evaluation step. Any key missing from them stays NULL on purpose - an
-- unmeasured metric must not become 0.
-- ---------------------------------------------------------------------
create or replace function public.record_model_version(
  p_version              text,
  p_storage_path         text,
  p_classes              text[],
  p_classes_by_part      jsonb,
  p_model_checksum       text,
  p_validation_accuracy  double precision,
  p_test_accuracy        double precision,
  p_part_summary         jsonb,
  p_severity_support     jsonb,
  p_dataset_version      text,
  p_model_architecture   text,
  p_input_size           integer[],
  p_preprocessing_method text,
  p_training_report_path text,
  p_trained_at           timestamptz,
  p_notes                text
)
returns public.model_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.model_versions;
  v_dataset_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'Admin access required to record a model version.'
      using errcode = '42501';
  end if;

  if p_test_accuracy is not null
     and (p_test_accuracy < 0 or p_test_accuracy > 1) then
    raise exception 'test_accuracy must be in [0,1] or NULL, got %', p_test_accuracy
      using errcode = '22023';
  end if;
  if p_validation_accuracy is not null
     and (p_validation_accuracy < 0 or p_validation_accuracy > 1) then
    raise exception 'validation_accuracy must be in [0,1] or NULL, got %', p_validation_accuracy
      using errcode = '22023';
  end if;

  -- Link to the dataset this model was trained on when it is known.
  if p_dataset_version is not null then
    select id into v_dataset_id
    from public.dataset_metadata
    where version = p_dataset_version
    order by updated_at desc
    limit 1;
  end if;

  insert into public.model_versions as mv (
    model_name, version, dataset_id, dataset_version, model_architecture,
    storage_path, classes, classes_by_part, input_size, preprocessing_method,
    validation_accuracy, test_accuracy, model_checksum, trained_at,
    part_summary, severity_support, training_report_path, status, notes
  )
  values (
    'citrusguard-transfer-cnn', p_version, v_dataset_id, p_dataset_version,
    p_model_architecture, p_storage_path, p_classes, p_classes_by_part,
    p_input_size, p_preprocessing_method, p_validation_accuracy, p_test_accuracy,
    p_model_checksum, coalesce(p_trained_at, now()), p_part_summary,
    coalesce(p_severity_support, '{"enabled": false}'::jsonb),
    p_training_report_path, 'candidate', p_notes
  )
  on conflict (model_name, version) do update
    set dataset_id          = excluded.dataset_id,
        dataset_version     = excluded.dataset_version,
        model_architecture  = excluded.model_architecture,
        storage_path        = excluded.storage_path,
        classes             = excluded.classes,
        classes_by_part     = excluded.classes_by_part,
        input_size          = excluded.input_size,
        preprocessing_method = excluded.preprocessing_method,
        validation_accuracy = excluded.validation_accuracy,
        test_accuracy       = excluded.test_accuracy,
        model_checksum      = excluded.model_checksum,
        trained_at          = excluded.trained_at,
        part_summary        = excluded.part_summary,
        severity_support    = excluded.severity_support,
        training_report_path = excluded.training_report_path,
        notes               = excluded.notes
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.record_model_version is
  'Upserts a trained model version''s metadata. Server-only; metrics are stored exactly as measured, with NULL meaning not measured.';

revoke execute on function public.record_model_version from public, anon, authenticated;
grant execute on function public.record_model_version to service_role;

-- ---------------------------------------------------------------------
-- record_dataset_metadata
--
-- Same contract for the dataset inventory, written by
-- `python -m citrusguard supabase sync-dataset`.
-- ---------------------------------------------------------------------
create or replace function public.record_dataset_metadata(
  p_dataset_name    text,
  p_version         text,
  p_source_url      text,
  p_landing_page    text,
  p_license         text,
  p_license_url     text,
  p_doi             text,
  p_attribution     text,
  p_checksum        text,
  p_image_count     integer,
  p_class_count     integer,
  p_classes         text[],
  p_parts           text[],
  p_counts_by_part  jsonb,
  p_storage_path    text,
  p_downloaded_at   timestamptz,
  p_metadata        jsonb
)
returns public.dataset_metadata
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.dataset_metadata;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'Admin access required to record dataset metadata.'
      using errcode = '42501';
  end if;

  insert into public.dataset_metadata (
    dataset_name, version, source_url, landing_page, license, license_url,
    doi, attribution, checksum, image_count, class_count, classes, parts,
    counts_by_part, status, storage_path, downloaded_at, metadata
  )
  values (
    p_dataset_name, p_version, p_source_url, p_landing_page, p_license,
    p_license_url, p_doi, p_attribution, p_checksum, p_image_count,
    p_class_count, coalesce(p_classes, '{}'), coalesce(p_parts, '{}'),
    coalesce(p_counts_by_part, '{}'::jsonb),
    -- 'ready' only when images were actually counted. An uncounted dataset
    -- stays 'pending' so the UI cannot claim a dataset exists when it does not.
    case when p_image_count is not null then 'ready'::public.dataset_status
         else 'pending'::public.dataset_status end,
    p_storage_path, p_downloaded_at, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (dataset_name, version) do update
    set source_url     = excluded.source_url,
        landing_page   = excluded.landing_page,
        license        = excluded.license,
        license_url    = excluded.license_url,
        doi            = excluded.doi,
        attribution    = excluded.attribution,
        checksum       = excluded.checksum,
        image_count    = excluded.image_count,
        class_count    = excluded.class_count,
        classes        = excluded.classes,
        parts          = excluded.parts,
        counts_by_part = excluded.counts_by_part,
        status         = excluded.status,
        storage_path   = excluded.storage_path,
        downloaded_at  = excluded.downloaded_at,
        metadata       = excluded.metadata
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.record_dataset_metadata from public, anon, authenticated;
grant execute on function public.record_dataset_metadata to service_role;


-- ##########################################################################
-- PART B - register the real dataset + the real trained model
-- ##########################################################################
-- ==========================================================================
-- CitrusGuard - register the REAL dataset and the REAL trained model
-- ==========================================================================
-- GENERATED FILE - do not hand-edit.
-- Regenerate with:  python scripts/generate_model_registration.py
--
-- Every literal below was read out of:
--   models/production/config.json   (exported bundle manifest)
--   data/citrus/raw/manifest.json   (verified dataset manifest)
--   reports/training-report.json    (measured evaluation report)
--
-- This file is IDEMPOTENT and safe to run repeatedly. It does NOT create
-- tables; apply supabase/combined_migration.sql first (or use
-- supabase/apply_all.sql, which does both in one paste).
--
-- It registers the model that is already trained and verified on disk. It
-- creates no placeholder and asserts no unmeasured accuracy.
-- ==========================================================================

begin;

-- --------------------------------------------------------------------------
-- 1. dataset_metadata - the verified public dataset
-- --------------------------------------------------------------------------
insert into public.dataset_metadata (
  dataset_name, version, source_url, landing_page, license, license_url, doi,
  attribution, checksum, image_count, class_count, classes, parts,
  counts_by_part, status, storage_path, downloaded_at, metadata
) values (
  'citrus-fruits-leaves',
  '2',
  'https://data.mendeley.com/public-api/zip/3f83gxmv57/download/2',
  'https://data.mendeley.com/datasets/3f83gxmv57/2',
  'CC BY 4.0',
  'https://creativecommons.org/licenses/by/4.0',
  '10.17632/3f83gxmv57.2',
  'Rauf, H. T., Saleem, B. A., Patel, H., & Aftab, S. (2019). "A Citrus Fruits and Leaves Dataset for Detection and Classification of Citrus Diseases through Machine Learning." Data in Brief. Dataset published on Mendeley Data, version 2.',
  'fc82592e9caebda988b278f0f2f965dbd0ae1464f6d920aa4ca9654da7ab19f7',
  759,
  6,
  array['Black Spot', 'Canker', 'Greening', 'Healthy', 'Melanose', 'Scab']::text[],
  array['Fruits', 'Leaves']::text[],
  '{
  "Fruits": {
    "Black Spot": 19,
    "Canker": 78,
    "Greening": 16,
    "Healthy": 22,
    "Scab": 15
  },
  "Leaves": {
    "Black Spot": 171,
    "Canker": 163,
    "Greening": 204,
    "Healthy": 58,
    "Melanose": 13
  }
}'::jsonb,
  'ready',
  'https://data.mendeley.com/public-api/zip/3f83gxmv57/download/2',
  '2026-09-30T10:01:45.074420+00:00',
  '{
  "manifest_version": 1,
  "checksum_kind": "content-sha256",
  "healthy": true,
  "corrupt": [],
  "unsupported": [],
  "duplicates": [],
  "split": {
    "ratios": {
      "train": 0.7,
      "validation": 0.15,
      "test": 0.15
    }
  }
}'::jsonb
)
on conflict (dataset_name, version) do update set
  source_url       = excluded.source_url,
  landing_page     = excluded.landing_page,
  license          = excluded.license,
  license_url      = excluded.license_url,
  doi              = excluded.doi,
  attribution      = excluded.attribution,
  checksum         = excluded.checksum,
  image_count      = excluded.image_count,
  class_count      = excluded.class_count,
  classes          = excluded.classes,
  parts            = excluded.parts,
  counts_by_part   = excluded.counts_by_part,
  status           = excluded.status,
  storage_path     = excluded.storage_path,
  downloaded_at    = excluded.downloaded_at,
  metadata         = excluded.metadata,
  updated_at       = now();

-- --------------------------------------------------------------------------
-- 2. model_versions - the exported bundle, marked production
-- --------------------------------------------------------------------------
-- `model_versions_single_production_idx` allows only ONE production row per
-- model_name, so any previous production row for this model is demoted to
-- 'candidate' first. That is what makes this re-runnable.
update public.model_versions
   set status = 'candidate',
       promoted_at = null,
       updated_at = now()
 where model_name = %s
   and version <> %s
   and status = 'production';

insert into public.model_versions (
  model_name, version, dataset_id, dataset_version, model_architecture,
  storage_path, classes, classes_by_part, input_size, preprocessing_method,
  validation_accuracy, test_accuracy, model_checksum, trained_at, promoted_at,
  part_summary, severity_support, training_report_path, status, notes
) values (
  'citrusguard-cnn',
  'v2',
  (select id from public.dataset_metadata where dataset_name = 'citrus-fruits-leaves' and version = '2'),
  '2',
  'mobilenet_v2',
  'versions/v2',
  array['Black Spot', 'Canker', 'Greening', 'Healthy', 'Melanose', 'Scab']::text[],
  '{
  "part_fruit": [
    "Black Spot",
    "Canker",
    "Greening",
    "Healthy",
    "Scab"
  ],
  "part_leaf": [
    "Black Spot",
    "Canker",
    "Greening",
    "Healthy",
    "Melanose"
  ]
}'::jsonb,
  array[224, 224]::integer[],
  'mobilenet_v2_imagenet',
  0.800000011920929,
  0.7,
  '8ee113fbf9b3277827fb77c62aa0fa8be07951d511956ada70245ffc92517f10',
  '2026-10-04T07:09:35.427100+00:00',
  now(),
  '{
  "Fruits": {
    "accuracy": 0.7,
    "macro_precision": 0.44666666666666666,
    "macro_recall": 0.5151515151515151,
    "macro_f1": 0.4481987577639751,
    "weighted_f1": 0.6554037267080746,
    "test_images": 20,
    "per_class": {
      "Black Spot": {
        "precision": 0.0,
        "recall": 0.0,
        "f1_score": 0.0,
        "support": 2
      },
      "Canker": {
        "precision": 0.8333333333333334,
        "recall": 0.9090909090909091,
        "f1_score": 0.8695652173913043,
        "support": 11
      },
      "Greening (Huanglongbing)": {
        "precision": 0.0,
        "recall": 0.0,
        "f1_score": 0.0,
        "support": 2
      },
      "Healthy": {
        "precision": 1.0,
        "recall": 0.6666666666666666,
        "f1_score": 0.8,
        "support": 3
      },
      "Scab": {
        "precision": 0.4,
        "recall": 1.0,
        "f1_score": 0.5714285714285714,
        "support": 2
      }
    },
    "confusion_matrix": [
      [
        0,
        1,
        0,
        0,
        1
      ],
      [
        1,
        10,
        0,
        0,
        0
      ],
      [
        0,
        0,
        0,
        0,
        2
      ],
      [
        0,
        1,
        0,
        2,
        0
      ],
      [
        0,
        0,
        0,
        0,
        2
      ]
    ],
    "classes": null
  },
  "Leaves": {
    "accuracy": 0.9090909090909091,
    "macro_precision": 0.9413898601398601,
    "macro_recall": 0.9196666666666665,
    "macro_f1": 0.9284868451155341,
    "weighted_f1": 0.9089955491774298,
    "test_images": 88,
    "per_class": {
      "Black Spot": {
        "precision": 0.9545454545454546,
        "recall": 0.84,
        "f1_score": 0.8936170212765957,
        "support": 25
      },
      "Canker": {
        "precision": 0.8461538461538461,
        "recall": 0.9166666666666666,
        "f1_score": 0.88,
        "support": 24
      },
      "Greening (Huanglongbing)": {
        "precision": 0.90625,
        "recall": 0.9666666666666667,
        "f1_score": 0.9354838709677419,
        "support": 30
      },
      "Healthy": {
        "precision": 1.0,
        "recall": 0.875,
        "f1_score": 0.9333333333333333,
        "support": 8
      },
      "Melanose": {
        "precision": 1.0,
        "recall": 1.0,
        "f1_score": 1.0,
        "support": 1
      }
    },
    "confusion_matrix": [
      [
        21,
        3,
        1,
        0,
        0
      ],
      [
        1,
        22,
        1,
        0,
        0
      ],
      [
        0,
        1,
        29,
        0,
        0
      ],
      [
        0,
        0,
        1,
        7,
        0
      ],
      [
        0,
        0,
        0,
        0,
        1
      ]
    ],
    "classes": null
  }
}'::jsonb,
  '{
  "enabled": false,
  "reason": "The published dataset has no severity labels (no early/moderate/severe annotations), so a severity model would have to be invented. The pipeline and the database column exist so one can be trained later."
}'::jsonb,
  'reports/training-report.json',
  'production',
  'Registered by scripts/generate_model_registration.py from the exported bundle at models/production/config.json. Artefacts: part_fruit=part_fruit.keras, part_leaf=part_leaf.keras. Per-part measured accuracy: Fruits=0.7, Leaves=0.9090909090909091. Mean test accuracy over 108 held-out images: 0.8045454545454545.'
)
on conflict (model_name, version) do update set
  dataset_id            = excluded.dataset_id,
  dataset_version       = excluded.dataset_version,
  model_architecture    = excluded.model_architecture,
  storage_path          = excluded.storage_path,
  classes               = excluded.classes,
  classes_by_part       = excluded.classes_by_part,
  input_size            = excluded.input_size,
  preprocessing_method  = excluded.preprocessing_method,
  validation_accuracy   = excluded.validation_accuracy,
  test_accuracy         = excluded.test_accuracy,
  model_checksum        = excluded.model_checksum,
  trained_at            = excluded.trained_at,
  promoted_at           = now(),
  part_summary          = excluded.part_summary,
  severity_support      = excluded.severity_support,
  training_report_path  = excluded.training_report_path,
  status                = 'production',
  notes                 = excluded.notes,
  updated_at            = now();

-- --------------------------------------------------------------------------
-- 3. show what was registered
-- --------------------------------------------------------------------------
select model_name,
       version,
       status,
       storage_path,
       model_architecture,
       input_size,
       test_accuracy,
       validation_accuracy,
       left(model_checksum, 16) || '...' as model_checksum,
       classes
  from public.model_versions
 where model_name = 'citrusguard-cnn'
 order by created_at desc;

commit;
