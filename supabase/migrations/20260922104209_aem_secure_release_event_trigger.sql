create or replace function public.aem_release_event_ingest()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op='INSERT' then
    insert into public.release_history(application_id,release_id,reason) values(new.application_id,new.id,'published');
    insert into public.notifications(kind,title,body,app_id,release_id) values('release','New release',coalesce(new.title,new.version_name)||' is now available.',new.application_id,new.id);
  elsif tg_op='UPDATE' and old.status is distinct from new.status then
    if new.status='published' then
      insert into public.release_history(application_id,release_id,reason) values(new.application_id,new.id,'published');
      insert into public.notifications(kind,title,body,app_id,release_id) values('release','Release published',coalesce(new.title,new.version_name)||' is now available.',new.application_id,new.id);
    elsif new.status='withdrawn' then
      insert into public.release_history(application_id,release_id,reason) values(new.application_id,new.id,'withdrawn');
      insert into public.notifications(kind,title,body,app_id,release_id) values('security','Release withdrawn',coalesce(new.title,new.version_name)||' was withdrawn.',new.application_id,new.id);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.aem_release_event_ingest() from public,anon,authenticated;