-- Only the service role can manage source coordinates. The download endpoint
-- serves explicitly catalogued, published artifacts; possession of a URL
-- intentionally grants download access, including for private repositories.
create table if not exists public.github_download_sources (
  artifact_id bigint primary key references public.artifacts(id) on delete cascade,
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  source_kind text not null check (source_kind in ('release_asset','actions_artifact')),
  github_id bigint not null check (github_id > 0),
  expires_at timestamptz
);
alter table public.github_download_sources enable row level security;
revoke all on public.github_download_sources from anon, authenticated;
grant select, insert, update, delete on public.github_download_sources to service_role;
alter table public.artifacts add column if not exists source_expires_at timestamptz;
