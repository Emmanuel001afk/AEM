-- Preserve APK metadata and upstream artifact freshness separately from the
-- GitHub release's original published_at date.
alter table public.artifacts
  add column if not exists artifact_version_name text;
