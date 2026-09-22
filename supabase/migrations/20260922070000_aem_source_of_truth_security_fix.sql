-- AEM source-of-truth and client isolation fixes.
alter table public.downloads add column if not exists client_id text;
create index if not exists downloads_client_idx on public.downloads(client_id, created_at desc);

update public.artifacts ar
set package_identity=a.package_identity
from public.releases r
join public.applications a on a.id=r.application_id
where ar.release_id=r.id and ar.platform='android'
  and ar.package_identity is null and a.package_identity is not null;

update public.artifacts ar
set version_code=r.version_code
from public.releases r
where ar.release_id=r.id and ar.version_code is null and r.version_code is not null;

drop policy if exists "aem artifact public insert" on storage.objects;
drop policy if exists "notifications public update" on public.notifications;
drop policy if exists "downloads public update" on public.downloads;
drop policy if exists "downloads public read" on public.downloads;
drop policy if exists "downloads public insert" on public.downloads;

create policy "downloads client insert"
on public.downloads for insert to anon, authenticated
with check (client_id is not null and client_id = current_setting('request.headers', true)::json->>'x-aem-client-id');

create policy "downloads client update"
on public.downloads for update to anon, authenticated
using (client_id = current_setting('request.headers', true)::json->>'x-aem-client-id')
with check (client_id = current_setting('request.headers', true)::json->>'x-aem-client-id');

create policy "downloads client read"
on public.downloads for select to anon, authenticated
using (client_id = current_setting('request.headers', true)::json->>'x-aem-client-id');

grant select on public.applications, public.releases, public.artifacts, public.release_history, public.source_providers, public.source_sync_state to anon, authenticated;
grant insert, select, update on public.downloads to anon, authenticated;
grant insert, select on public.build_requests to anon, authenticated;
