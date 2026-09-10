# Wearable and health-platform rollout

HMS uses one canonical ingestion boundary, but each provider still needs its own authorised connector, agreements, rate-limit handling and verification. Catalogue presence never means a live integration exists.

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
