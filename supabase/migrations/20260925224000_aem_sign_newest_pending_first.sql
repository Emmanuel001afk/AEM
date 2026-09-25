-- Prioritize the newest pending APKs so the store can surface the latest release
-- without waiting behind a backlog of older artifacts.

update public.artifacts
set signing_status='pending',
    signing_authority='source',
    signing_error=null
where platform='android' and kind='apk' and signing_status='processing';

create or replace function public.claim_android_artifacts(claim_limit integer default 25)
returns setof public.artifacts
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_ids bigint[];
begin
  if claim_limit is null or claim_limit < 1 or claim_limit > 25 then
    raise exception 'claim_limit must be between 1 and 25';
  end if;

  with picked as (
    select id
    from public.artifacts
    where platform='android'
      and kind='apk'
      and signing_status='pending'
    order by id desc
    for update skip locked
    limit claim_limit
  ), changed as (
    update public.artifacts a
    set signing_status='processing'
    from picked
    where a.id=picked.id
    returning a.id
  )
  select coalesce(array_agg(id), '{}'::bigint[]) into claimed_ids from changed;

  if coalesce(array_length(claimed_ids,1),0)=0 then return; end if;

  return query
    select a.*
    from public.artifacts a
    where a.id=any(claimed_ids)
    order by a.id desc;
end;
$$;

revoke all on function public.claim_android_artifacts(integer) from public, anon, authenticated;
grant execute on function public.claim_android_artifacts(integer) to service_role;
