-- Winkler County (FIPS 48495) mineral ownership + wells tables.
--
-- Same pattern as 20260820170000_create_permian_county_tables.sql: mirror
-- Howard's tables via `CREATE TABLE ... (LIKE ... INCLUDING ALL)` so columns,
-- defaults, checks, indexes, and the int `id` sequence match exactly. Run
-- against the Supabase project that already has howard_mineral_ownership /
-- howard_wells. Idempotent (`if not exists`).
--
-- NB: winkler_permits already exists (created by the earlier
-- 20260716200000_create_permian_permits.sql loop), so it is intentionally
-- not (re)created here.

create table if not exists public.winkler_mineral_ownership
  (like public.howard_mineral_ownership including all);
create table if not exists public.winkler_wells
  (like public.howard_wells including all);

-- Indexes mirror 20260820180000 (the 5 earlier Permian counties):
--   * abstract        -> per-tract owner lookup (.in('abstract', [...]))
--   * owner_name      -> OwnerDrawer holdings + owner search
--   * owner_name trgm -> ilike() owner search
--   * owner_name + acreage DESC -> drawer ordering
-- Without the abstract/owner_name indexes the per-tract and owner-search
-- queries seq-scan the ~52k-row roll and can hit the statement timeout.
create extension if not exists pg_trgm;

create index if not exists idx_winkler_ownership_abstract
  on public.winkler_mineral_ownership (abstract);
create index if not exists idx_winkler_ownership_owner_name
  on public.winkler_mineral_ownership (owner_name);
create index if not exists idx_winkler_ownership_owner_name_trgm
  on public.winkler_mineral_ownership using gin (owner_name gin_trgm_ops);
create index if not exists idx_winkler_ownership_owner_acreage
  on public.winkler_mineral_ownership (owner_name, acreage desc nulls last);

-- RLS: CREATE TABLE ... (LIKE ... INCLUDING ALL) copies RLS *enablement* but
-- NOT policies, so without an explicit "allow read all" policy anon /
-- authenticated SELECTs are filtered to zero rows (symptom: "Total owners: 0"
-- on the county overview, empty owner search / OwnerDrawer). Mirror
-- 20260821010000. Idempotent.
do $$
declare
  tbl text;
  tables text[] := array['winkler_mineral_ownership', 'winkler_wells'];
begin
  foreach tbl in array tables loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = tbl
    ) then
      raise notice 'Skipping %: table does not exist yet', tbl;
      continue;
    end if;
    execute format('alter table public.%I enable row level security;', tbl);
    execute format('drop policy if exists "allow read all" on public.%I;', tbl);
    execute format(
      'create policy "allow read all" on public.%I for select using (true);', tbl
    );
  end loop;
end $$;
