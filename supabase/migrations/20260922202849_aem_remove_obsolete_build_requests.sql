-- Remove the obsolete manual/source-build queue.
-- Published GitHub artifacts remain the release source of truth.
drop table if exists public.build_requests cascade;
