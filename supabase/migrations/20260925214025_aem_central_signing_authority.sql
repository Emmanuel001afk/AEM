alter table public.artifacts
  add column if not exists signing_authority text not null default 'source';

alter table public.artifacts
  drop constraint if exists artifacts_signing_authority_check;

alter table public.artifacts
  add constraint artifacts_signing_authority_check
  check (signing_authority in ('source','aem'));

create index if not exists artifacts_signing_authority_idx
  on public.artifacts(signing_authority);

update public.artifacts
set signing_status='pending',
    signing_authority='source',
    signing_certificate_sha256=null
where platform='android'
  and kind='apk';

update public.artifacts
set signing_status='pending',
    signing_authority='source'
where platform='android'
  and kind='apk'
  and signing_status='failed';
