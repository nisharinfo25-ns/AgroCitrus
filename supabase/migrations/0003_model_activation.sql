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