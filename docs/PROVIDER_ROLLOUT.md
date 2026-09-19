# Wearable and health-platform rollout

HMS uses one canonical ingestion boundary, but each provider still needs its own authorised connector, agreements, rate-limit handling and verification. Catalogue presence never means a live integration exists.

For exact dashboard steps, current callback URLs, environment variables and the acceptance checklist, follow [Provider setup](PROVIDER_SETUP.md). Documentation was checked against the providers' official pages on 19 September 2026.

## Current implementation

- Google Health and WHOOP have server-side OAuth, encrypted grants, bounded reads and scheduled sync. Real-provider approval, credentials and device acceptance are still required.
- Each connection re-reads a rolling seven-day window because phone uploads and scored sleep can arrive after the original measurement. A versioned private checkpoint freezes the window, retains one cursor per metric collection and rotates between collections. Manual runs handle at most 12 pages; scheduled runs yield after at most three pages or their eight-second phase-start budget. Google pages contain at most 1,000 readings. A failed or unfinished sweep never advances the successful-sync timestamp. Replay uses the existing metric deduplication boundary. This is a recent-history synchronisation window, not an all-time backfill or provider correction/deletion feed.
- Google Health includes intraday heart rate, steps, active energy, weight, sleep and supported daily summaries. Daily VO2 max is requested under activity permission. Heart rate keeps its original observation time and does not invent resting status.
- WHOOP currently imports recovery measurements, cycle energy, main-sleep duration and respiratory rate. Workout details and body measurements are not imported or requested in the OAuth scopes.
- Webhooks for Google Health, WHOOP, Garmin, Oura and Withings are not implemented. Do not register a made-up webhook endpoint or describe polling as provider push.
- The minute scheduler is a bounded queue. The time to finish a sweep depends on accounts ahead in the queue, page count, rate limits, phone upload and provider processing. One-minute dispatch does not prove every user's data arrives within a minute.
- Dense histories can still take many ticks to finish. Google Health alternates rotating current head-page probes with an older, still-paginated reconciliation sweep; a probe never changes historical cursors or the successful-sync timestamp. WHOOP rotates reconciliation collections without claiming a verified fresh-head contract. The displayed last complete sync time is the frozen window's end, never the later time the job happened to finish. Per-user/metric capacity and delays remain unmeasured with real devices.
- HTTP 429 responses persist both shared scope and connection cooldowns. Manual sync, token refresh and further pages respect them; another successful request cannot shorten them. `Retry-After` supports seconds and HTTP dates, with WHOOP reset seconds as a fallback. Migration 0042 adds a shared private request allowance covering all outbound provider requests, not just data pages. Local allowance exhaustion queues work without completing its checkpoint. Source-to-recipient load/device acceptance remains required before any minute-level promise.
- Rollback compatibility: keep the version 2 checkpoint reader when reverting unrelated changes. An older version-1-only runtime cannot resume a partially completed version 2 sweep. Do not silently discard cursors or claim a completed sync to work around that boundary.

## Quota constraint before public rollout

WHOOP's documented default allowance is 100 requests per minute and 10,000 requests per day per client. Reading all three implemented collections once per minute needs at least 4,320 calls per day per user before pagination or token refresh. Three such users exceed the daily allowance. Provider-approved webhooks and a quota-aware dispatcher or an approved quota increase are required before promising that cadence to a wider population. [WHOOP rate limits](https://developer.whoop.com/docs/developing/rate-limiting/)

Google applies project-wide and per-user quotas. Inspect the actual project's allocation and test throttling; read-only scopes and credentials do not establish a latency guarantee. [Google Health quotas](https://developers.google.com/health/rate-limits)

HMS now caps WHOOP conservatively at a 9,000/day replenishment rate with a burst of ten, and Google at one request per second with a burst of one **for the whole project**. Every attempted OAuth/data/refresh/revocation request consumes an independently committed permit; failed or uncertain requests are not refunded. The WHOOP envelope is at most 9,010 requests in any 24 hours, including the starting burst. Google intentionally underuses the published project allowance to remain below even one user's limit without putting account IDs into the counter. These caps do not guarantee admission, data freshness, a supported user count or approval from either provider.

All deployments sharing a provider client/project must use the same budget database. Preview must use separate provider clients/projects while its database is isolated. `GOOGLE_HEALTH_QUOTA_PROJECT_ID` must match the actual OAuth project's canonical ID; changing that value or resetting budget rows to evade throttling is not a valid operation. Other applications using the same credentials are outside this counter's control. Missing scope configuration/migration or unavailable database blocks outbound HTTP. Preserve budget rows across deployments, disconnects and reconnects. Do not downgrade to a pre-budget runtime after enabling real credentials.

## Recommended order

1. **Apple HealthKit companion** — broad iPhone/Apple Watch and third-party app coverage; background delivery is opportunistic and must be measured on physical devices.
2. **Android Health Connect companion** — broad Android app/device aggregation; WorkManager and vendor write cadence determine freshness.
3. **Fitbit / Google ecosystem** — OAuth and vendor notifications where approved, with polling only inside documented quotas.
4. **WHOOP, Garmin and Oura** — provider webhooks/cloud APIs; Garmin native streaming requires the applicable licensed SDK/programme.
5. **Withings and smart scales** — webhook/cloud reads after the user weighs; these are event-driven measurements, not 24/7 streams.
6. **Clinical sensors and CGMs** — only through authorised partner programmes with product, regulatory and clinical review.

## Connector definition of done

- Official API/programme approval and current documentation are recorded.
- OAuth/link/unlink, token refresh/revocation, webhook signature and replay protection are tested.
- Provider IDs map to stable HMS sources and normalised readings retain provenance and original timestamps.
- Backfill, incremental sync, late corrections, deletion/revocation and quota/backoff behaviour are tested.
- The catalogue states observed source delay, sample cadence, background limitations and whether updates are webhook, polling, phone-sync or licensed live stream.
- No unsupported metric is inferred. “Near real-time” begins only when the source makes the reading available to HMS.
