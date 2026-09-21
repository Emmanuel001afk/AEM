create extension if not exists pgcrypto;

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  project text not null,
  name text not null,
  description text,
  source_url text,
  icon_url text,
  platforms text[] not null default '{}',
  package_identity text,
  category text,
  functionality text[] not null default '{}',
  permissions text[] not null default '{}',
  screenshots text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, project)
);

create table if not exists public.releases (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  source_release_id text not null,
  version_name text not null,
  version_code bigint,
  channel text not null default 'stable' check (channel in ('stable','beta','development')),
  status text not null default 'published' check (status in ('draft','published','withdrawn')),
  title text,
  notes text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique(application_id, source_release_id)
);

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.releases(id) on delete cascade,
  platform text not null,
  kind text not null,
  filename text not null,
  download_url text not null,
  size_bytes bigint,
  sha256 text,
  package_identity text,
  signing_certificate_sha256 text,
  version_code bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.release_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  release_id uuid not null references public.releases(id) on delete cascade,
  reason text not null check (reason in ('published','withdrawn','rollback-target')),
  created_at timestamptz not null default now()
);

create index if not exists releases_application_idx on public.releases(application_id);
create index if not exists artifacts_release_idx on public.artifacts(release_id);
create index if not exists release_history_application_idx on public.release_history(application_id);

alter table public.applications enable row level security;
alter table public.releases enable row level security;
alter table public.artifacts enable row level security;
alter table public.release_history enable row level security;

create policy "public can read applications" on public.applications for select to anon, authenticated using (true);
create policy "public can read published releases" on public.releases for select to anon, authenticated using (status = 'published');
create policy "public can read artifacts for published releases" on public.artifacts for select to anon, authenticated using (exists (select 1 from public.releases r where r.id = release_id and r.status = 'published'));
create policy "public can read release history" on public.release_history for select to anon, authenticated using (true);
