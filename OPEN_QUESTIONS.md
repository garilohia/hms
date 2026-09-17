# Open questions

> **Retired identifier.** OQ008 was opened during M8 for a temporary host-sleep interruption and was resolved and removed once the large-import benchmark passed. That number is retired rather than reused, so the references in PROGRESS.md and `docs/verification/m8-review.md` still point at the retired entry. Production wearable-provider access is OQ012 below.

## OQ001 — Verifiable parental consent before launch

- Founder-specified launch requirement: DPDP Act requires verifiable parental consent for children; the exact verification method needs a lawyer before launch.
- Owner: founder with legal counsel.
- Needed outcome: an approved method for verifying the consenting adult and their parental/guardian authority, with the evidence, retention, and re-verification requirements needed for implementation.
- Status: unresolved before launch. Recording a guardian's consent is part of the build, but does not by itself resolve the verification requirement.
- Review DPDP Act section 9, final Rules 2025 rule 10 and the child-monitoring restrictions/exceptions for HMS specifically. Do not assume an independent wellness/facilitation app qualifies for a healthcare exemption. Official sources: [Act](https://www.meity.gov.in/static/uploads/2024/02/Digital-Personal-Data-Protection-Act-2023.pdf), [Rules](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf).

## OQ002 — Hosted CI result observed and green

- Resolved 14 September 2026. The checkout has `origin` → `https://github.com/garilohia/hms.git`, and hosted GitHub Actions runs are visible.
- The failures beginning with migration 0024 came from replaying Supabase Realtime migrations in a stock `postgres:17` service without the provider-owned `realtime` schema. `scripts/bootstrap-test-db.sql` now supplies a minimal CI-only `realtime.messages`, `realtime.topic()` and inert `realtime.send()` fixture, matching the existing Auth and Storage fixtures without pretending to test websocket delivery.
- Hosted run [34883833639](https://github.com/garilohia/hms/actions/runs/34883833639) passed both `quality` and `database` for commit `a0f1803`. Realtime websocket delivery remains a separate launch question under OQ015.

## OQ003 — Launch email delivery and redirect configuration

- Live Supabase token redemption, browser sessions, and sign-out have been verified using a generated test link without emailing anyone.
- Before launch, verify delivery to an authorised recipient and ensure the final app URL and auth callback are allowed in Supabase. The exact deployment URL is not available until deployment. No inbox-delivery claim is made by the token/session test.

## OQ004 — Scheduler and notification launch configuration

- The environment has no cron secret, Resend key or VAPID credentials, and no deployed application URL yet. Configure the same random `CRON_SECRET` in Vercel and restricted Supabase Vault, set the deployed `NEXT_PUBLIC_APP_URL`, then run `npm run cron:setup` and observe successful minute-by-minute HTTP responses. Do not assume a successful pg_cron SQL run means the HTTP handler succeeded.
- Email uses a privacy-preserving console stub until a verified Resend sender/key are configured. Test real delivery only to an authorised recipient. Sample data always remains stubbed. Monitor failed/exhausted delivery rows before launch.
- Browser worker registration and local notification tests are separate from server Web Push delivery. Web Push subscription storage, recipient rechecks and transport are implemented, but production delivery still requires the configured VAPID pair and a physical-device test. SMS/WhatsApp remain stubs and no provider accounts were created.

## OQ005 — History timezone changes after import

- Resolved 11 September 2026. The founder asked for the change to work, and it is built and verified (D032, migrations 0037-0039). Raw readings are absolute instants and never move; changing the home timezone re-enqueues every affected local day through the existing durable summary queue, drained by the owner-driven refresh batches that already serve import.
- Past alerts are re-evaluated under the new zone, with a narrow prune of unacknowledged, non-escalated events older than 24 hours so nothing already acted on is rewritten and no notification is re-sent. History and Today stay readable and label each day still awaiting recalculation. Shared snapshots stay immutable and now carry the timezone they were computed in, with a flag on the doctor's copy when the patient has since moved.
- Still open: country of residence remains separate from the history timezone. A very long history needs several visits to finish draining while the minute scheduler is undeployed (OQ004).

## OQ006 — Additional PDF scripts

- Clinical PDFs embed Noto Sans and Noto Sans Devanagari, with Latin/Hindi visual fixtures. Characters outside these fonts' coverage, including emoji, cause an explicit PDF-unavailable response rather than a corrupted clinical document. The complete HTML summary and stored original text remain available.
- Resolved 14 September 2026: the founder confirmed Latin and Devanagari are sufficient for now. This is a scope decision, not a gap. Unsupported scripts continue to return the explicit PDF-unavailable response with the complete HTML summary intact.
- If further scripts are wanted later, add and visually verify their fonts before advertising the wider coverage. No patient text is sent to an external font or translation service.

## OQ007 — Operator, retention, grievances and cross-border care before launch

- Publish the actual operator/legal entity, address, grievance officer or designated contact, working inbox, identity-check and response process. Legal pages intentionally identify these as unresolved, not fake contacts or a compliance certification.
- Counsel must reconcile the founder-requested live hard-delete behaviour with applicable medical-record retention and DPDP Rules 2025 rule 8(3)/security-log obligations, taking phased commencement and any subsequent notifications/corrigenda into account. Review provider backup/log retention and processors' locations. Do not promise all infrastructure processing stays in India or immediate backup erasure.
- The preview retains live history until account deletion, anonymises audit identifiers and preserves other patients' consultation text after a doctor deletes their account. Names inside free-text clinical records are not automatically redacted. An approved production retention/redaction policy is still required.
- Approve correction/nomination/grievance workflows, international patient eligibility and telemedicine requirements, clinician verification, paid-consultation pricing/refunds and final jurisdiction language before public clinical use. No operating entity, cross-border licence, partnership or paid service is inferred by this build.

## OQ009 — Native build, signing and physical-device acceptance

- The shared bearer-authenticated server contract, source registration, immutable batch receipts, latency report and platform implementation checklists are in the repository.
- This Mac currently has Apple Command Line Tools but not full Xcode, and has no Java/Gradle Android toolchain. Install the supported toolchains, choose bundle/application IDs and signing accounts, then implement and verify the platform clients against `mobile/README.md`.
- Do not mark native background collection complete until HealthKit/Health Connect permissions, process death, reboot, offline recovery, battery saving, clock changes, consent withdrawal, token expiry, push acknowledgement and physical wearable behavior pass on supported devices.

## OQ010 — Clinical alert review and supervised pilot

- Storage bounds and illustrative UI starting points are engineering safeguards, not prescribed clinical thresholds. A qualified clinical safety reviewer must approve the launch rule set, copy, escalation policy, contraindications and test protocol.
- A supervised pilot needs named consenting participants, supported devices, an incident/withdrawal procedure and explicit success criteria for source latency, false positives, missed readings and delivery reliability. No participant or real personal dataset is created or enrolled by this code change.

## OQ011 — Vercel preview environment parity

- The Vercel project is accessible, but its public Supabase URL/publishable key are currently listed for Production and Development rather than Preview. Add deliberate Preview values and a Preview `NEXT_PUBLIC_APP_URL` strategy before treating a preview deployment as a functioning staging environment. Do not silently reuse production health data for a staging pilot.

## OQ012 — Production wearable-provider access

- Register production OAuth clients for Google Health and WHOOP, approve their consent screens, and add the exact local and production callback URLs before enabling their Connect buttons. No provider accounts, terms or credentials were created by this build.
- Garmin live linking requires acceptance into the Garmin Connect Developer Program and a commercial licence decision. Ultrahuman multi-user access requires partner approval. Owners, fees, allowed data, deletion/revocation duties and launch availability remain unresolved.
- A live Apple Watch background connection requires a native iOS HealthKit bridge and App Store privacy review. The launch web architecture intentionally supports Apple Health export instead.

## OQ013 — Cycle-phase shading is not covered by DESIGN.md

- DESIGN.md §5.1 makes the 28-day band "the only fill in the product" and §12 forbids any colour outside §4.2. PLAN.md §6 golden path 1 and PROGRESS.md require visible cycle-phase shading on the Temp chart, and the History screen previously used four pastel fills for it.
- Applied as written: the four phases now render as hairline hatch patterns in `--ink-soft` (dense diagonal, dots, horizontal, cross-hatch) behind the plot, with a matching swatch and the phase word in the legend. No new colour and no solid fill; the `cycle-phase` test hook is unchanged.
- Resolved 11 September 2026: the founder approved the hatch treatment. DESIGN.md §5.1 in the repository now records it (D031).

## OQ014 — DESIGN.md and the reference HTML disagree on one value, and the three densities do not exist in code

- Resolved 14 September 2026: the founder chose `#F0554F` (D034). It measures 4.87:1 on `--surface` and 4.34:1 on `--surface-2`, but `--urgent` only ever renders on `--surface` — the alert card's top rule and label, and the chart notch. The 4.5:1 floor is unchanged; the vacuous `urgent on surface-2` row was replaced in `scripts/check-contrast.ts` by a structural guard that fails the build if urgent is ever given a `--surface-2` background. Darkening `--surface-2` was rejected: it drops panel-to-card separation to 1.08:1 and erases Advanced's nested panel. DESIGN.md and the reference HTML now agree.
- Resolved 11 September 2026: the founder asked for the three densities. `profiles.display_mode` (migration 0035), the `display` settings action, the onboarding choice, More → Display and the Simple and Advanced renderings of Today and History are built (D031).

## OQ015 — Realtime delivery is unverified in this environment

- The consultation thread now has a live channel: `hms_private.can_receive_consult_live` mirrors the participant rule `hms_private.consult_read` enforces, a `realtime.messages` SELECT policy scopes the `consult:<uuid>` topic, and triggers on `public.messages` and `public.consults` broadcast a `changed` ping carrying no clinical text (migration 0040). All of it is installed and verified present in the database, and the payload deliberately forces a re-read so authorisation and consent are re-checked.
- The websocket ping did not reach the browser in the golden run on 11 September 2026. The database side checks out: RLS is enabled on `realtime.messages`, `authenticated` holds SELECT, the policy and both triggers exist, every function in the path is STABLE and granted, and `setAuth()` with no argument is correct for supabase-js 2.116.0. The cause is therefore above the database and was not isolated within the time box.
- This is not new to the chat. The patient view's `useRealtimePatientView` has used the same mechanism since migration 0024 and no test has ever asserted that it connects; both surfaces announce only an interrupted connection, so a permanently offline channel is invisible. Treat live delivery on Today, History and the consult thread as unverified until one test asserts it.
- The consult room therefore keeps its explicit Refresh messages button unconditionally, so chat never depends on the channel. Before launch, confirm Realtime is enabled for the project, watch the websocket handshake in a browser, and add a golden assertion that a message sent by one participant appears for the other without a refresh.
