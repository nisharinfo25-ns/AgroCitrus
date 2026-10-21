-- =====================================================================
-- CitrusGuard - 0004 safe recovery migration: rename references column
--
-- Renames the PostgreSQL reserved keyword `references` to `reference_sources`
-- in `public.disease_information` safely and idempotently.
-- =====================================================================

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'disease_information'
      and column_name = 'references'
  ) then
    alter table public.disease_information rename column "references" to reference_sources;
  end if;
end $$;
