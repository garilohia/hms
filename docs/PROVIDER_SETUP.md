# Wearable provider setup

Checked 19 September 2026. This is the setup guide for the connectors in this repository. The application owner must create accounts, approve terms, supply credentials and complete provider review. No credentials or approvals are implied by a device appearing in HMS.

## 1. Prepare the existing application

1. Use the stable production origin, currently `https://hms-indol-psi.vercel.app`. If a custom domain replaces it, update the provider's registered callback and `NEXT_PUBLIC_APP_URL` together.
2. Keep development, Preview and production on separate databases and provider applications where possible. A Preview callback must use its own stable origin and credentials, not the production database.
3. Register these exact production callbacks, including the underscore in `google_health`:

   | Provider | Registered callback |
   | --- | --- |
   | Google Health | `https://hms-indol-psi.vercel.app/api/integrations/google_health/callback` |
   | WHOOP | `https://hms-indol-psi.vercel.app/api/integrations/whoop/callback` |

4. For local tests on port 3001, set `NEXT_PUBLIC_APP_URL=http://localhost:3001` and register the same callback paths under that origin if the provider permits local redirects. The repository's example defaults to port 3000; use the port actually running. Do not mix `localhost` and `127.0.0.1` during an OAuth round trip.
5. Apply repository migrations before deploying code that uses the private provider checkpoint: `npm run db:migrate` with the intended environment's `DATABASE_URL`.
6. Open `.env.local` in `/Users/gari/Documents/ChatGPT/HMS` for local values. In Vercel, open the HMS project → Settings → Environment Variables for hosted values. These files and dashboard fields, not source code, are where credentials go.

## 2. Store the shared encryption key

Production already has a generated `INTEGRATION_TOKEN_KEY`, configured as a sensitive Vercel variable on 19 September 2026 after confirming there were no existing grants. Its value was not printed or copied into this repository. Leave it in place. Google Health and WHOOP client credentials are still required.

For a separate local/development database, the code needs its own `INTEGRATION_TOKEN_KEY`: exactly 32 random bytes encoded as base64. Generate it once with `openssl rand -base64 32`, save it securely, and paste it into that environment's `.env.local`. Do not point local provider tests at production grants using a different key. Environments sharing a database must use its original encryption key; the safer development setup uses its own database and key.

Do not overwrite an existing valid key just to follow this guide. Existing provider grants are encrypted with it; replacing it makes those grants unreadable unless they are migrated or disconnected first. It stays server-only. Never prefix it with `NEXT_PUBLIC_`, paste it into chat or commit it.

## 3. Google Health: Fitbit Air, Fitbit and Pixel Watch

Use the Google Health API, not legacy Fitbit or Google Fit developer credentials. The implemented provider identifier is `google_health`.

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/) with the account that will own HMS.
2. Select the intended project and enable **Google Health API** under APIs & Services → Library.
3. Configure Google Auth Platform branding, support contact, audience and data access. Review any terms yourself.
4. Create a **Web application** OAuth client. Register the HMS callback from section 1 instead of the example Google/Playground callback in the tutorial.
5. Save its client ID as `GOOGLE_HEALTH_CLIENT_ID` and its client secret as `GOOGLE_HEALTH_CLIENT_SECRET` in `.env.local` and the appropriate Vercel environment. Downloaded credential JSON is not an HMS input and should stay outside the repository.
   Also set `GOOGLE_HEALTH_QUOTA_PROJECT_ID` to that Google Cloud project's permanent project ID, not its display name or numeric project number. HMS fails closed when this shared-allowance scope is missing or invalid. All deployments using the same Google project or WHOOP client must use the same quota database; do not invent an environment suffix or reuse production credentials with an isolated preview database. WHOOP's scope comes from `WHOOP_CLIENT_ID`, with no extra quota environment variable.
6. While testing, add permitted Google accounts under Audience → Test users. Current Google Health setup documentation caps unverified applications at 100 users and requires security review for wider access. Complete the provider's verification process before public rollout. [Official setup](https://developers.google.com/health/setup)

Configure the exact current read-only scopes requested by `src/lib/integrations/providers.ts`:

```text
openid
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

`openid` identifies the connected account. HMS does not request settings permission. Users can grant a subset of health scopes; HMS requests only the collections permitted by those grants. [Google scopes](https://developers.google.com/health/scopes)

The connector imports available intraday heart rate and preserves observation time; nightly/daily derived values retain their slower source cadence. Google documents heart rate as a sample, not continuous access to a sensor. [Vitals API](https://developers.google.com/health/data-types/vitals)

Google Health supports provider notifications, but HMS has no subscriber/webhook receiver yet. Leave subscriber configuration for the connector implementation milestone. [Google Health release notes](https://developers.google.com/health/release-notes)

## 4. WHOOP

1. Sign in to the [WHOOP developer dashboard](https://developer-dashboard.whoop.com/) using the owning WHOOP account.
2. Create the developer team/application yourself and review its terms.
3. Add the exact WHOOP redirect from section 1.
4. Enable the data scopes below. The `offline` request is needed to obtain a refresh token for background sync.
5. Save the client ID as `WHOOP_CLIENT_ID` and client secret as `WHOOP_CLIENT_SECRET` in `.env.local` and the matching Vercel environment. Keep the secret server-side. [Official app setup](https://developer.whoop.com/docs/developing/getting-started/), [OAuth](https://developer.whoop.com/docs/developing/oauth/)

```text
offline
read:profile
read:cycles
read:recovery
read:sleep
```

The current connector uses profile for identity and imports recovery, cycles and main sleep. It does not request unused workout or body-measurement permissions. Continuous heart rate is not available through WHOOP's public API. [WHOOP API](https://developer.whoop.com/api/), [Developer support](https://developer.whoop.com/docs/developing/support/)

Before a wider pilot, follow WHOOP's [app approval](https://developer.whoop.com/docs/developing/app-approval/) process and resolve the quota budget in [Provider rollout](PROVIDER_ROLLOUT.md). Do not configure a webhook callback yet: HMS currently polls the v2 API and has no WHOOP webhook handler.

## 5. Deploy and accept each connector separately

1. Redeploy after adding Vercel variables. Restart the local server after editing `.env.local`.
2. Use an adult test account with explicit ingestion consent and a wearable account whose owner has agreed to testing.
3. In HMS, open More → Devices & data and connect one provider.
4. Confirm the provider shows the expected HMS name, requested permissions and callback host. Cancel once and confirm HMS returns without creating a connection.
5. Complete consent. The initial sync is queued for the minute worker. Confirm the correct profile is connected and compare an imported reading, original timestamp and unit against the provider app once that sync runs.
6. Leave the connection through an access-token expiry and confirm automatic refresh succeeds without asking the user to reconnect.
7. Temporarily keep the phone offline, record a measurement or sleep, then sync the phone later. Confirm HMS imports it after it appears in the cloud. The supported reread window is seven days; an older upload needs a separately implemented backfill or a file import.
8. For dense data, confirm a partial sweep resumes from its stored page and that the successful-sync timestamp changes only after the full sweep. Duplicate page replay must not add duplicate readings.
9. Disconnect in HMS and verify new ingestion stops. Confirm provider access is removed; if the provider could not be reached, use the displayed retry/provider-settings flow until removal is confirmed.
10. Record observed device → cloud → HMS → alert delivery times for each supported metric. Capture provider quota use and throttling/retry behaviour. Never record raw tokens or identifiable health payloads in the evidence.
11. Mark the provider gate passed only after these real-account checks, revocation and rate-limit tests pass. Unit tests and a green deployment do not prove provider permission or delivery latency.

## 6. Providers which need more implementation

Adding new environment variable names alone does not enable the following integrations. Store approvals and redacted configuration notes under `docs/verification/`; store actual credentials only once the relevant connector defines its server-side configuration.

| Provider/path | External work | Repository/native work still required |
| --- | --- | --- |
| Apple Health / Apple Watch | Apple developer membership and signing when the native client is ready. | HealthKit-capable iOS client, per-metric consent, background delivery and physical-device testing. No server API key exposes HealthKit to this website. Follow [Native acceptance](NATIVE_ACCEPTANCE.md) and [Apple HealthKit](https://developer.apple.com/documentation/healthkit). |
| Android / Health Connect | Play Console health permissions declaration and release review for the native application. | Health Connect client, incremental reads, background permissions and device testing using the existing HMS mobile ingestion contract. [Health Connect overview](https://developer.android.com/health-and-fitness/guides/health-connect) |
| Garmin | Request the applicable commercial programme and record approved metrics/licensing. | Garmin OAuth, notifications, backfill and provenance. A licensed live SDK is a separate integration from Garmin Connect cloud data. [Programme FAQ](https://developer.garmin.com/gc-developer-program/program-faq/) |
| Oura | Register and obtain approval for the intended application/use. | OAuth, scoped reads, authenticated webhooks and sync measurements. No `OURA_*` configuration exists in HMS yet. [Oura API authentication](https://cloud.ouraring.com/docs/authentication) |
| Withings scales, BP and other devices | Create the partner application and confirm available measurement access. | OAuth, measurement mapping and notifications with a reachable HTTPS endpoint that answers validation HEAD requests. `user.metrics` covers health measurements; select other scopes only when used. [Withings OAuth](https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/oauth-authorization-url/), [Notifications](https://developer.withings.com/developer-guide/v3/integration-guide/onsite-mode/data-api/notifications/notification-subscribe/) |
| Other scales, rings, budget wearables and health apps | Confirm whether the exact model exports to Apple Health/Health Connect, offers portable data, or grants an authorised API. | Native hub path or a provider-specific adapter. Brand coverage is not proof that every model/metric is available. Use canonical CSV for supported portable readings today. |
| CGMs, clinical sensors and clinical feeds | Authorised provider programme plus clinical/legal review of the specific use. | Approved connector, timestamps, units, quality/provenance and acceptance tests. Do not use consumer account scraping or undocumented APIs. |
| Terra / ROOK / Junction or another aggregator | Choose a supplier and approve its commercial/data-processing terms. | The aggregator interface is a stub. Webhook verification, stable source mapping, replay, deletions and quota handling must be implemented before credentials have any effect. |

Withings describes typical notification delivery as under two minutes after data reaches its cloud, with occasional longer delays and no standard-plan real-time SLA. This is a provider statement, not measured HMS performance. [Withings delivery and reliability](https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/data-api/notifications/notification-overview/)

## 7. What belongs in the repository folder

- `.env.local`: only the values named above, together with the already required Supabase/notification settings; it stays git-ignored.
- `.env.example`: variable names and safe placeholders only. Never paste live credentials into it.
- `docs/verification/`: approval reference/date, scope list, redacted test evidence and measured freshness. Credentials, downloaded OAuth JSON and private keys do not belong here.
- No Apple signing key, Google service-account JSON, wearable password or downloaded API-token bundle is needed by the current web connectors.
