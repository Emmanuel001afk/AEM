-- Keep each bounded repository scan progressing once a minute so all tracked
-- repositories are refreshed promptly without overloading a single invocation.
select cron.unschedule('aem-github-source-sync');
select cron.schedule(
  'aem-github-source-sync',
  '* * * * *',
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
