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

-- AEM Store is managed through the same catalog path as every other application.
insert into public.applications(provider,project,package_identity,name,description,source_url,platforms,category,functionality,description_source,icon_source)
values('github','Emmanuel001afk/AEM','com.aem.store','AEM Store','A software store for discovering, building, installing and updating applications from configured sources.','https://github.com/Emmanuel001afk/AEM',array['android','web'],'Store',array['Discovery','Builds','Install','Updates'],'aem','repository')
on conflict(provider,project) do update set package_identity=coalesce(public.applications.package_identity,excluded.package_identity),description=coalesce(public.applications.description,excluded.description),description_source=coalesce(public.applications.description_source,excluded.description_source),updated_at=now();

alter table public.manager_state enable row level security;
create policy "public read manager state" on public.manager_state for select to anon,authenticated using(true);
grant select on public.manager_state to anon,authenticated;
