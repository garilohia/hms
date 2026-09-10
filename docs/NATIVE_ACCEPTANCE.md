# Native companion acceptance gates

Status: implementation contract ready; physical-device acceptance pending.

The iOS and Android companions use the versioned API documented in `mobile/README.md`. A build is not accepted merely because it uploads one sample. Each platform must pass every gate below on supported physical phones and at least one supported wearable.

## Shared release gates

- Authenticate with a real Supabase access token. Never embed the Supabase secret key, database URL or cron secret.
- Store the queue encryption key in Keychain or Android Keystore and retain only encrypted health batches at rest.
- Reuse one UUID batch ID until the server confirms it. A byte-for-byte retry must return the original result; changed content under the same ID must fail.
- Recover queued, uploading and retryable batches after process death, reboot, temporary loss of network and access-token refresh.
- Preserve device timestamps and timezone offsets. Flag material phone-clock drift in diagnostics rather than rewriting recorded time.
- Batch at most 1,000 canonical readings per request. Back off on 5xx/network failures, stop on validation errors and require reauthentication after a final 401.
- Show last sensor sample, last phone sync and last HMS receipt separately. Never label provider freshness as continuous sensor coverage.
- Keep push payloads free of health measurements, thresholds, names and profile identifiers. Re-read the authorised alert after opening HMS.
- Measure recorded-to-received, received-to-alert and alert-to-delivery timing during the pilot.

## iOS physical-device matrix

- Current supported iOS release and previous major release.
- Initial HealthKit history grant, incremental anchored reads, revoked permission and empty history.
- Observer/background delivery while locked, after force-quit, after reboot and in Low Power Mode.
- Apple Watch samples that arrive late or are corrected by HealthKit.
- APNs delivery while foregrounded, backgrounded, locked and temporarily offline.

## Android physical-device matrix

- Current supported Android release and previous two supported releases.
- Health Connect unavailable, permission denied, permission revoked and history permission boundaries.
- Change-token expiry/full resync, WorkManager retry, reboot and battery-optimisation modes.
- Data from at least two Health Connect writers with duplicate-looking but distinct source records.
- FCM delivery while foregrounded, backgrounded, locked and temporarily offline.

## Exit criteria

Release only after all required cases have recorded evidence, no high-severity security or clinical-safety findings remain, and the supervised pilot/clinical/legal gates in `LAUNCH_GATES.md` are signed off. Signed binaries, App Store/Play policy review and production APNs/FCM credentials remain external release work.
