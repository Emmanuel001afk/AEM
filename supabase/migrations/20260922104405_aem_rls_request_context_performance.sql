drop policy if exists "downloads client insert" on public.downloads;
drop policy if exists "downloads client update" on public.downloads;
drop policy if exists "downloads client read" on public.downloads;
drop policy if exists "build requests client read" on public.build_requests;
create policy "downloads client insert" on public.downloads for insert to anon,authenticated
with check (client_id is not null and client_id=(select current_setting('request.headers',true)::json->>'x-aem-client-id'));
create policy "downloads client update" on public.downloads for update to anon,authenticated
using (client_id=(select current_setting('request.headers',true)::json->>'x-aem-client-id'))
with check (client_id=(select current_setting('request.headers',true)::json->>'x-aem-client-id'));
create policy "downloads client read" on public.downloads for select to anon,authenticated
using (client_id=(select current_setting('request.headers',true)::json->>'x-aem-client-id'));
create policy "build requests client read" on public.build_requests for select to anon,authenticated
using (client_id=(select current_setting('request.headers',true)::json->>'x-aem-client-id'));