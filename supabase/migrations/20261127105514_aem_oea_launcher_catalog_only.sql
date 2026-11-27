-- Keep OEA's game packages in storage for existing clients, but expose only the
-- launcher as an Android installer through the public store catalog.
-- Service-side discovery/signing retains access to all existing rows.
drop policy if exists "public read published artifacts" on public.artifacts;
create policy "public read published artifacts" on public.artifacts for select to anon, authenticated using (
  exists (
    select 1 from public.releases r
    join public.applications a on a.id = r.application_id
    where r.id = artifacts.release_id and r.status = 'published'
      and not (lower(a.project) = 'emmanuel001afk/oea' and artifacts.platform = 'android' and artifacts.package_identity is distinct from 'com.oea.launcher')
  )
);
