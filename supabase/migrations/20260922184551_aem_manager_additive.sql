-- AEM Manager layer: additive only. Existing releases, builds, downloads and providers remain intact.
alter table public.applications add column if not exists description_source text not null default 'source';
alter table public.applications add column if not exists icon_source text;

create table if not exists public.manager_state (
  id text primary key default 'default',
  last_run_at timestamptz,
  last_success_at timestamptz,
  status text not null default 'idle',
  active_operations integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.manager_state(id) values('default') on conflict(id) do nothing;

alter table public.manager_state enable row level security;
drop policy if exists "public read manager state" on public.manager_state;
create policy "public read manager state" on public.manager_state for select to anon,authenticated using(true);
grant select on public.manager_state to anon,authenticated;
