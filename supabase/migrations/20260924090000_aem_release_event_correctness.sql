create or replace function public.aem_release_event_ingest()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
begin
  if coalesce(new.source_release_id,'') like 'github-actions-artifact-%' then
    return new;
  end if;
  if tg_op='INSERT' then
    if new.status='published' then
      if not exists (select 1 from public.release_history h where h.release_id=new.id and h.reason='published') then
        insert into public.release_history(application_id,release_id,reason) values(new.application_id,new.id,'published');
      end if;
      if not exists (select 1 from public.notifications n where n.release_id=new.id and n.kind='release') then
        insert into public.notifications(kind,title,body,app_id,release_id,client_id)
        values('release','New release',coalesce(new.title,new.version_name)||' is now available.',new.application_id,new.id,public.aem_request_client_id());
      end if;
    end if;
  elsif tg_op='UPDATE' and old.status is distinct from new.status then
    if new.status='published' then
      if not exists (select 1 from public.release_history h where h.release_id=new.id and h.reason='published') then
        insert into public.release_history(application_id,release_id,reason) values(new.application_id,new.id,'published');
      end if;
      if not exists (select 1 from public.notifications n where n.release_id=new.id and n.kind='release') then
        insert into public.notifications(kind,title,body,app_id,release_id,client_id)
        values('release','Release published',coalesce(new.title,new.version_name)||' is now available.',new.application_id,new.id,public.aem_request_client_id());
      end if;
    elsif new.status='withdrawn' then
      if not exists (select 1 from public.release_history h where h.release_id=new.id and h.reason='withdrawn') then
        insert into public.release_history(application_id,release_id,reason) values(new.application_id,new.id,'withdrawn');
      end if;
      if not exists (select 1 from public.notifications n where n.release_id=new.id and n.kind='security') then
        insert into public.notifications(kind,title,body,app_id,release_id,client_id)
        values('security','Release withdrawn',coalesce(new.title,new.version_name)||' was withdrawn.',new.application_id,new.id,public.aem_request_client_id());
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.aem_release_event_ingest() from public,anon,authenticated;

delete from public.notifications n
where n.kind='release'
  and n.id not in (
    select keep_id from (
      select distinct on (release_id) id as keep_id
      from public.notifications
      where kind='release' and release_id is not null
      order by release_id,created_at,id
    ) kept
  );

delete from public.release_history h
where h.reason in ('published','withdrawn')
  and h.id not in (
    select keep_id from (
      select distinct on (release_id,reason) id as keep_id
      from public.release_history
      where reason in ('published','withdrawn')
      order by release_id,reason,created_at,id
    ) kept
  );