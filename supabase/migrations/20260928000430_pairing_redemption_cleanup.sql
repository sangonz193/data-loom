select
  cron.schedule (
    'purge-pairing-redemption-failures',
    '*/5 * * * *',
    $$
    delete from public.pairing_redemption_failures
      where created_at < clock_timestamp() - interval '15 minutes';
    delete from cron.job_run_details
      where jobid = (select jobid from cron.job where jobname = 'purge-pairing-redemption-failures')
        and end_time < clock_timestamp() - interval '1 day';
  $$
  );
