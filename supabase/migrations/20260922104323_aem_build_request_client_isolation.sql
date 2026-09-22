alter table public.build_requests add column if not exists client_id text;
create index if not exists build_requests_client_idx on public.build_requests(client_id,created_at desc);
drop policy if exists "build requests public read" on public.build_requests;
drop policy if exists "build requests public update" on public.build_requests;
create policy "build requests client read" on public.build_requests for select to anon,authenticated
using (client_id=current_setting('request.headers',true)::json->>'x-aem-client-id');