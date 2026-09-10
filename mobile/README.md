# HMS native companion contract

This directory is the handoff boundary for the future iOS and Android apps. The server contract is implemented and tested in the web repository; platform binaries are not claimed until they have been built with full Xcode and Android toolchains and tested on physical devices.

## Shared flow

1. Sign in with Supabase Auth using the platform SDK. Keep refresh credentials in Keychain on iOS or Android Keystore-backed encrypted storage. Never put the Supabase secret key or database URL in an app.
2. Send the current access token as `Authorization: Bearer <access-token>` to `GET /api/mobile/bootstrap`.
3. Ask for platform health permissions only after explaining each requested data type. Permission absence is not an error and must not be represented as a zero reading.
4. Generate a random installation identifier once and retain it in secure storage. Register the source with `POST /api/mobile/sources`. Use the returned stable source UUID for every batch from that installation.
5. Convert platform samples to the canonical schema returned by bootstrap. Preserve the original measurement timestamp, source-device label and a stable external identifier.
6. Persist batches locally before sending them to `POST /api/mobile/ingest`. Each batch has a UUID. Retrying the same UUID and exact content returns the original result; changing content under a used UUID is rejected.
7. Delete a local batch only after a successful response. On `401`, refresh the Supabase session. On `403`, stop collection for that profile because ownership or ingestion consent changed. On `400`, quarantine the batch for diagnostics without including health values in logs. Retry `5xx` with capped exponential backoff and jitter.

The body limit is 1 MiB and the record limit is 1,000. The server applies consent, ownership, canonical-unit, future-time, duration, source and deduplication checks again. A fresh accepted batch uses the normal summary/alert fast path; the minute scheduler remains its durable retry.

## Offline queue requirements

- Encrypt queue contents with an installation-specific key held by Keychain/Keystore. Do not put health values in preferences, analytics, crash reports, notification text or filenames.
- Use an append-only queued/sending/accepted/quarantined state machine. Recover `sending` rows to `queued` after process death.
- Batch by record count and encoded byte size. Preserve order within one source, but correctness must not depend on network ordering.
- Use platform background scheduling and battery/network constraints. “Background delivery requested” is not a promise that either operating system will run immediately.
- Record queue age, upload attempt count and the server receipt time for operational diagnostics without exporting values.

## Alert notifications

Native push payloads must remain content-free: “Open HMS to view an unusual reading.” Fetch the authorised alert view after the user opens the app. Acknowledge through the existing authenticated alert API. Treat notification delivery as advisory monitoring, never an emergency guarantee.

See [iOS.md](./ios/iOS.md) and [Android.md](./android/Android.md) for platform work that requires native toolchains and physical-device verification.
