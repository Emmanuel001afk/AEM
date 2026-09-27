create or replace function public.aem_trigger_android_signing()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,vault,extensions
as $$
declare
  project_url text;
  publishable_key text;
  sync_secret text;
begin
  if tg_op='INSERT' then
    if new.platform <> 'android' or new.kind <> 'apk' or new.signing_status <> 'pending' then
      return new;
    end if;
  elsif tg_op='UPDATE' then
    if new.platform <> 'android' or new.kind <> 'apk'
       or new.signing_status <> 'pending'
       or old.signing_status is not distinct from new.signing_status then
      return new;
    end if;
  else
    return new;
  end if;

  project_url := (select decrypted_secret from vault.decrypted_secrets where name='aem_project_url' limit 1);
  publishable_key := (select decrypted_secret from vault.decrypted_secrets where name='aem_publishable_key' limit 1);
  sync_secret := (select decrypted_secret from vault.decrypted_secrets where name='aem_sync_secret' limit 1);

  if coalesce(project_url,'')='' or coalesce(publishable_key,'')='' or coalesce(sync_secret,'')='' then
    raise warning 'AEM signing trigger could not dispatch: required Vault secret is missing';
    return new;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/aem-trigger-android-signing',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey',publishable_key,
      'x-aem-sync-secret',sync_secret
    ),
    body := jsonb_build_object(
      'source','database-trigger',
      'artifact_id',new.id,
      'occurred_at',now()
    ),
    timeout_milliseconds := 10000
  );

  return new;
end $$;

revoke execute on function public.aem_trigger_android_signing() from public,anon,authenticated;

drop trigger if exists aem_android_artifact_signing_trigger on public.artifacts;

create trigger aem_android_artifact_signing_trigger
after insert or update of signing_status on public.artifacts
for each row
execute function public.aem_trigger_android_signing();
