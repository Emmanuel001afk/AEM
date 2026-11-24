-- Remember the upstream release-asset identity separately from the stored APK hash.
-- Central Android signing rewrites the APK bytes, so the artifact's final sha256 alone
-- cannot tell whether the source release asset changed on the next GitHub sync.
alter table public.artifacts
  add column if not exists source_sha256 text,
  add column if not exists source_updated_at timestamptz;
