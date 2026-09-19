# Wearable and health-platform rollout

HMS uses one canonical ingestion boundary, but each provider still needs its own authorised connector, agreements, rate-limit handling and verification. Catalogue presence never means a live integration exists.

For exact dashboard steps, current callback URLs, environment variables and the acceptance checklist, follow [Provider setup](PROVIDER_SETUP.md). Documentation was checked against the providers' official pages on 19 September 2026.

## Current implementation

- Google Health and WHOOP have server-side OAuth, encrypted grants, bounded reads and scheduled sync. Real-provider approval, credentials and device acceptance are still required.
- Each connection re-reads a rolling seven-day window because phone uploads and scored sleep can arrive after the original measurement. A private checkpoint freezes the window and resumes its provider page token across runs. Each run handles at most 12 pages; Google pages contain at most 1,000 readings. A failed or unfinished sweep never advances the successful-sync timestamp. Replay uses the existing metric deduplication boundary. This is a recent-history synchronisation window, not an all-time backfill or provider correction/deletion feed.
- Google Health includes intraday heart rate, steps, active energy, weight, sleep and supported daily summaries. Daily VO2 max is requested under activity permission. Heart rate keeps its original observation time and does not invent resting status.
- WHOOP currently imports recovery measurements, cycle energy, main-sleep duration and respiratory rate. Workout details and body measurements are not imported or requested in the OAuth scopes.
- Webhooks for Google Health, WHOOP, Garmin, Oura and Withings are not implemented. Do not register a made-up webhook endpoint or describe polling as provider push.
- The minute scheduler is a bounded queue. The time to finish a sweep depends on accounts ahead in the queue, page count, rate limits, phone upload and provider processing. One-minute dispatch does not prove every user's data arrives within a minute.
- Dense heart-rate histories can take tens of minutes to finish a sweep within the current limits. The displayed last complete sync time is the frozen window's end, never the later time the job happened to finish. Before making a one-minute freshness claim, implement separate bounded fresh-reading and historical-reconciliation work, fair scheduling across users and metrics, provider-aware quota budgets, then measure them under load with real devices. This is an open rollout requirement, not verified current performance.

## Quota constraint before public rollout

WHOOP's documented default allowance is 100 requests per minute and 10,000 requests per day per client. Reading all three implemented collections once per minute needs at least 4,320 calls per day per user before pagination or token refresh. Three such users exceed the daily allowance. Provider-approved webhooks and a quota-aware dispatcher or an approved quota increase are required before promising that cadence to a wider population. [WHOOP rate limits](https://developer.whoop.com/docs/developing/rate-limiting/)

Google applies project-wide and per-user quotas. Inspect the actual project's allocation and test throttling; read-only scopes and credentials do not establish a latency guarantee. [Google Health quotas](https://developers.google.com/health/rate-limits)

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
