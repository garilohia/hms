# Android Health Connect implementation gate

The Android companion should use Health Connect change tokens for incremental reads and WorkManager for durable uploads. Store each change token by profile and record type, and advance it only after samples are encrypted into the local queue. Handle expired tokens with a bounded historical rescan and server deduplication.

Map only reviewed records and preserve data origin, device, client record ID/version, start/end instants and zone offsets. Missing permissions or records remain missing—not zero. Availability differs by Android/Health Connect version and device manufacturer.

Required validation before this can be marked complete:

- Supported Android SDK/JDK/Gradle toolchain, application ID, Health Connect declarations and Play data-safety form.
- Permission rationale and granular revocation handling for every requested record type.
- WorkManager behavior under Doze, battery saver, reboot, offline mode, process death and token expiry on physical devices.
- Encrypted queue migration/recovery, duplicate change events, clock changes and multi-day backlog tests.
- FCM foreground/background notification and acknowledgement tests with health values absent from lock-screen payloads.

This host currently has no Java or Gradle runtime, so no emulator- or device-tested Android target is claimed.
