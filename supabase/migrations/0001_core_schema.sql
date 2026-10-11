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
