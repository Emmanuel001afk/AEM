drop policy if exists "downloads public insert" on public.downloads;
drop policy if exists "build requests public insert" on public.build_requests;
create policy "build requests public insert" on public.build_requests
for insert to anon,authenticated
with check (exists (select 1 from public.applications a where a.provider='github' and a.project=repository));