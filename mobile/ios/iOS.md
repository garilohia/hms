# iOS HealthKit implementation gate

The iOS companion should use HealthKit anchored queries for incremental history and observer queries/background delivery for data types Apple permits to wake the app. It must maintain one anchor per profile, sample type and source, and commit a new anchor only after its encrypted queue transaction succeeds.

Map only types with a reviewed canonical conversion. HealthKit heart-rate variability is SDNN; HMS must not relabel it as RMSSD. Skin/wrist temperature is not core temperature. Sleep categories remain categorical. Preserve `HKSourceRevision`, device name, sample UUID, start/end time and timezone offset when available.

Required validation before this can be marked complete:

- Full Xcode, signing team, bundle identifier, HealthKit capability and privacy manifest.
- Purpose strings that name every requested read type without suggesting diagnosis.
- Background delivery and anchored-query recovery on at least one supported iPhone/Apple Watch pair.
- Airplane-mode queueing, process termination, token expiry, consent withdrawal, clock change, duplicate callback and multi-day backlog tests.
- APNs foreground/background notification and acknowledgement tests with health values absent from lock-screen payloads.

This host currently has Command Line Tools only, so no signed or simulator-tested iOS target is claimed.
