# Open questions

> **Retired identifier.** OQ008 was opened during M8 for a temporary host-sleep interruption and was resolved and removed once the large-import benchmark passed. That number is retired rather than reused, so the references in PROGRESS.md and `docs/verification/m8-review.md` still point at the retired entry. Production wearable-provider access is OQ012 below.

## OQ001 — Verifiable parental consent before launch

- Founder-specified launch requirement: DPDP Act requires verifiable parental consent for children; the exact verification method needs a lawyer before launch.
- Owner: founder with legal counsel.
- Needed outcome: an approved method for verifying the consenting adult and their parental/guardian authority, with the evidence, retention, and re-verification requirements needed for implementation.
- Status: unresolved before launch. Recording a guardian's consent is part of the build, but does not by itself resolve the verification requirement.
- Review DPDP Act section 9, final Rules 2025 rule 10 and the child-monitoring restrictions/exceptions for HMS specifically. Do not assume an independent wellness/facilitation app qualifies for a healthcare exemption. Official sources: [Act](https://www.meity.gov.in/static/uploads/2024/02/Digital-Personal-Data-Protection-Act-2023.pdf), [Rules](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf).

## OQ002 — Hosted CI result still unobserved

- Resolved in part: the checkout now has a Git remote, `origin` → `https://github.com/garilohia/hms.git`, and `big-changes` tracks it. The earlier statement that no remote was configured is superseded.
- Still open: no hosted GitHub Actions result has been observed. The M0 workflow is configured for pushes and pull requests and its quality commands pass locally; local success is not a hosted-CI result.
- As of 11 September 2026, local `main` is one commit ahead of `origin/main`. That commit is already contained in `origin/big-changes`, so nothing is unbacked.

## OQ003 — Launch email delivery and redirect configuration

- Live Supabase token redemption, browser sessions, and sign-out have been verified using a generated test link without emailing anyone.
- Before launch, verify delivery to an authorised recipient and ensure the final app URL and auth callback are allowed in Supabase. The exact deployment URL is not available until deployment. No inbox-delivery claim is made by the token/session test.

## OQ004 — Scheduler and notification launch configuration

- The environment has no cron secret, Resend key or VAPID credentials, and no deployed application URL yet. Configure the same random `CRON_SECRET` in Vercel and restricted Supabase Vault, set the deployed `NEXT_PUBLIC_APP_URL`, then run `npm run cron:setup` and observe successful minute-by-minute HTTP responses. Do not assume a successful pg_cron SQL run means the HTTP handler succeeded.
- Email uses a privacy-preserving console stub until a verified Resend sender/key are configured. Test real delivery only to an authorised recipient. Sample data always remains stubbed. Monitor failed/exhausted delivery rows before launch.
- Browser worker registration and local notification tests are separate from server Web Push delivery. Web Push subscription storage, recipient rechecks and transport are implemented, but production delivery still requires the configured VAPID pair and a physical-device test. SMS/WhatsApp remain stubs and no provider accounts were created.

## OQ005 — History timezone changes after import

- M5 allows choosing a home timezone before importing. Post-import changes are explicitly refused because silently regrouping daily history would invalidate summaries, period anchors and alert timing.
- Supporting such changes needs a tested full re-bucketing workflow. Until then the UI explains the restriction; country of residence is separate from the history timezone.

## OQ006 — Additional PDF scripts

- Clinical PDFs embed Noto Sans and Noto Sans Devanagari, with Latin/Hindi visual fixtures. Characters outside these fonts' coverage, including emoji, cause an explicit PDF-unavailable response rather than a corrupted clinical document. The complete HTML summary and stored original text remain available.
- Add and visually verify further script fonts before advertising multilingual PDF support beyond the bundled coverage. No patient text is sent to an external font or translation service.

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

- Resolved 11 September 2026. The founder preferred the reference HTML's dark `--urgent` `#F0554F`, but it measures 4.34:1 on dark `--surface-2`, below the 4.5:1 floor in §4.5 and §10, so `scripts/check-contrast.ts` rejects it. DESIGN.md's `#F4655E` (4.87:1 on surface-2) stays, and the repository copy of DESIGN.md is the source; the reference file should be updated to match.
- Resolved 11 September 2026: the founder asked for the three densities. `profiles.display_mode` (migration 0035), the `display` settings action, the onboarding choice, More → Display and the Simple and Advanced renderings of Today and History are built (D031).
