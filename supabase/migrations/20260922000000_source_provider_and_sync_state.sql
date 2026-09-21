create table if not exists public.source_providers (
  id text primary key,
  label text not null,
  active boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.source_providers(id,label,active,config)
values ('github','GitHub',true,'{}'::jsonb)
on conflict(id) do update set label=excluded.label,active=excluded.active,config=excluded.config,updated_at=now();

alter table public.applications add column if not exists source_external_id text;
alter table public.applications add column if not exists source_visibility text;

create unique index if not exists applications_provider_external_id_key
on public.applications(provider,source_external_id)
where source_external_id is not null;

create table if not exists public.source_sync_state (
  provider text primary key references public.source_providers(id) on delete cascade,
  status text not null default 'never',
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  repositories_scanned integer not null default 0,
  applications_discovered integer not null default 0,
  releases_discovered integer not null default 0,
  artifacts_discovered integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.source_sync_state(provider) values('github') on conflict(provider) do nothing;

alter table public.source_providers enable row level security;
alter table public.source_sync_state enable row level security;

drop policy if exists "public read source providers" on public.source_providers;
create policy "public read source providers" on public.source_providers for select to anon,authenticated using(true);

drop policy if exists "public read source sync state" on public.source_sync_state;
create policy "public read source sync state" on public.source_sync_state for select to anon,authenticated using(true);


drop policy if exists "build requests public update" on public.build_requests;
create policy "build requests public update" on public.build_requests
for update to anon,authenticated
using (true)
with check (status in ('queued','running','succeeded','failed','cancelled'));


drop policy if exists "public read artifacts" on public.artifacts;
