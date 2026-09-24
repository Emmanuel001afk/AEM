create or replace function public.aem_get_sync_secret()
returns text
language sql
stable
security definer
set search_path=pg_catalog,public,vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name='aem_sync_secret' limit 1;
$$;
revoke all on function public.aem_get_sync_secret() from public,anon,authenticated;
grant execute on function public.aem_get_sync_secret() to service_role;

select cron.unschedule('aem-github-source-sync');
select cron.schedule(
  'aem-github-source-sync',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'aem_project_url') || '/functions/v1/aem-sync-github',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'apikey',(select decrypted_secret from vault.decrypted_secrets where name = 'aem_publishable_key'),
        'x-aem-sync-secret',(select decrypted_secret from vault.decrypted_secrets where name = 'aem_sync_secret')
      ),
      body := jsonb_build_object('source','cron','time',now()),
      timeout_milliseconds := 120000
    ) as request_id;
  $job$
);