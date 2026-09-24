alter table public.artifacts
  add column if not exists signing_status text not null default 'ready';

alter table public.artifacts
  drop constraint if exists artifacts_signing_status_check;

alter table public.artifacts
  add constraint artifacts_signing_status_check
  check (signing_status in ('ready','pending','processing','failed'));

create index if not exists artifacts_signing_status_idx
  on public.artifacts(signing_status);
