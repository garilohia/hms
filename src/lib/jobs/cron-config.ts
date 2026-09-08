export const cronSchedule = "* * * * *";
export const cronJobName = "hms-minute-dispatch";
export function cronEndpoint(appUrl: string) {
  const url = new URL(appUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") || /(^localhost$|\.localhost$|\.local$|\.internal$|^[\d.]+$|[:\[\]])/.test(url.hostname)) throw new Error("Use the deployed HTTPS application URL.");
  return new URL("/api/jobs/tick", url.origin).href;
}
// Only Vault references are visible in cron.job, never the bearer secret itself.
export const cronCommand = `select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='hms_job_url'),
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
    (select decrypted_secret from vault.decrypted_secrets where name='hms_cron_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 110000
);`;
