create or replace function public.aem_request_client_id()
returns text
language sql
stable
set search_path=pg_catalog,public
as $$
  select (current_setting('request.headers', true)::json ->> 'x-aem-client-id');
$$;

alter table public.notifications add column if not exists client_id text;
create index if not exists notifications_client_idx on public.notifications(client_id);

drop policy if exists "notifications public read" on public.notifications;
create policy "notifications client read" on public.notifications
for select to anon,authenticated
using (client_id is null or client_id = (select public.aem_request_client_id()));

drop policy if exists "notifications client insert" on public.notifications;
create policy "notifications client insert" on public.notifications
for insert to anon,authenticated
with check (client_id is not null and client_id = (select public.aem_request_client_id()));

grant select,insert on public.notifications to anon,authenticated;
