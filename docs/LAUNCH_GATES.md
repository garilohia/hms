# HMS launch gates

Passing automated tests is necessary but does not authorise clinical use. Record a named owner, date, evidence link and explicit pass/fail decision for each gate.

## Engineering and staging

- A dedicated Vercel Preview environment uses deliberate non-production Supabase public configuration and synthetic data.
- Database migrations, RLS/advisor checks, build, unit/integration/browser suites and the native contract tests pass from a clean checkout.
- Supabase Cron calls the protected minute route in the intended environment; overlapping invocations and delivery retries remain idempotent.
- APNs/FCM and each enabled provider are tested with authorised accounts and health-free notification payloads.
- The native physical-device matrix in `NATIVE_ACCEPTANCE.md` passes.
- Dashboards and alerts exist for delayed sources, failed ingestion, exhausted delivery, cron failure and elevated pipeline latency.

## Supervised pilot

- Enrol only named adults who have consented; do not enrol dependants until parental verification is legally approved.
- Limit the pilot to an explicit device/phone/version matrix and publish the expected delay for each connection path.
- Predefine success criteria for recorded-to-HMS latency, alert creation, notification delivery, duplicate suppression, battery impact, false positives and missed readings.
- Give participants a support route, incident procedure, withdrawal/deletion process and a clear instruction not to rely on HMS for emergencies.
- Review every alert and missed/late reading against the source record. Treat absence of a reading as feed status, not evidence of sleep, stability or deterioration.

## Clinical safety review

- A qualified reviewer approves supported metrics, canonical units, corruption bounds, rule copy, severity, acknowledgement, repeat suppression and escalation timing.
- Thresholds are patient-specific care-plan settings or explicitly illustrative defaults; wearable skin temperature is not treated as core temperature.
- The review covers stale/noisy sensors, motion artefact, late corrections, clock drift, missing data, temporary connectivity and contradictory devices.
- The reviewer approves the user-facing emergency limitations and the process for changing a live rule set.

## Legal and operational review

- Counsel approves verifiable parental consent, guardianship conversion, DPDP responsibilities, privacy/retention/deletion, international monitoring and telemedicine terms.
- The operating entity, grievance/privacy contact, incident response owner and clinician-verification process are published and staffed.
- Vendor agreements and platform policies permit every advertised provider integration and use of its data.
- Security review covers mobile storage, access-token handling, RLS, webhook verification, secrets, audit logs, exports/deletion and breach response.

## Go/no-go rule

Any missing clinical, legal, security or native physical-device approval is a no-go for public clinical reliance. It may remain a clearly labelled development preview using synthetic data.
