import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { inspectNotificationConfig, inspectSenderDomain, senderDomain, type NotificationConfigCheck, type NotificationEnvironment } from "../src/lib/alerts/notification-config";

// No implicit .env.local fallback: select one file explicitly, or inherit runtime variables.
// Offline: HMS_NOTIFICATION_ENV_FILE=.env.local npx tsx scripts/verify-notification-config.ts
// Provider metadata (GET only): add --provider. No email or push is ever sent.
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--provider")) throw new Error("UnexpectedArgument");
  const path = process.env.HMS_NOTIFICATION_ENV_FILE;
  const env: NotificationEnvironment = path ? parseEnv(readFileSync(path, "utf8")) : process.env;
  const checks = inspectNotificationConfig(env);
  let domainCheck: NotificationConfigCheck = { check: "sender_domain", status: "unverified", detail: "Read-only provider verification was not requested." };
  if (args.includes("--provider")) {
    const domain = senderDomain(env.EMAIL_FROM);
    if (!domain || !checks.filter(check => ["resend_key", "email_sender"].includes(check.check)).every(check => check.status === "pass")) {
      domainCheck.detail = "Provider verification requires a valid API key and non-test sender configuration.";
    } else {
      try {
        let after: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 10; page++) {
          const url = new URL("https://api.resend.com/domains");
          url.searchParams.set("limit", "100");
          if (after) url.searchParams.set("after", after);
          const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
            headers: { Authorization: "Bearer " + env.RESEND_API_KEY } });
          if (!response.ok) {
            domainCheck = { check: "sender_domain", status: "unverified", detail: response.status === 401 || response.status === 403
              ? "Provider domain metadata is inaccessible to this key; a sending-only key may not permit this read."
              : "Provider domain metadata could not be read (HTTP " + response.status + ")." };
            break;
          }
          const inspection = inspectSenderDomain(await response.json(), domain);
          domainCheck = inspection.result;
          if (!inspection.nextCursor || seen.has(inspection.nextCursor)) break;
          seen.add(inspection.nextCursor);
          after = inspection.nextCursor;
        }
      } catch {
        domainCheck = { check: "sender_domain", status: "unverified", detail: "Provider metadata request failed or timed out; no notifications were sent." };
      }
    }
  }
  const localConfigurationValid = checks.every(check => check.status === "pass");
  process.stdout.write(JSON.stringify({ source: path ? "explicit_env_file" : "inherited_environment", localConfigurationValid,
    senderDomainVerified: domainCheck.status === "pass", deliveryVerified: false, notificationsSent: 0, checks: [...checks, domainCheck] }, null, 2) + "\n");
  if (!localConfigurationValid || (args.includes("--provider") && domainCheck.status !== "pass")) process.exitCode = 1;
}

main().catch(() => { process.stderr.write("Notification configuration verification could not run. Check the explicit environment file and supported --provider option. No credentials are printed.\n"); process.exitCode = 1; });
