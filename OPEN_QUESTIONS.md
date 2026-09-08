# Open questions

## OQ001 — Verifiable parental consent before launch

- Founder-specified launch requirement: DPDP Act requires verifiable parental consent for children; the exact verification method needs a lawyer before launch.
- Owner: founder with legal counsel.
- Needed outcome: an approved method for verifying the consenting adult and their parental/guardian authority, with the evidence, retention, and re-verification requirements needed for implementation.
- Status: unresolved before launch. Recording a guardian's consent is part of the build, but does not by itself resolve the verification requirement.

## OQ002 — Git remote for hosted CI

- No Git remote is configured in the supplied checkout.
- The M0 workflow is configured for pushes and pull requests, and its quality commands passed locally. A hosted Actions run requires the founder's chosen repository remote and a push; no remote repository has been created or inferred.

## OQ003 — Launch email delivery and redirect configuration

- Live Supabase token redemption, browser sessions, and sign-out have been verified using a generated test link without emailing anyone.
- Before launch, verify delivery to an authorised recipient and ensure the final app URL and auth callback are allowed in Supabase. The exact deployment URL is not available until deployment. No inbox-delivery claim is made by the token/session test.

## OQ004 — Scheduler and notification launch configuration

- The environment has no cron secret, Resend key or VAPID credentials, and no deployed application URL yet. Configure the same random `CRON_SECRET` in Vercel and restricted Supabase Vault, set the deployed `NEXT_PUBLIC_APP_URL`, then run `npm run cron:setup` and observe successful minute-by-minute HTTP responses. Do not assume a successful pg_cron SQL run means the HTTP handler succeeded.
- Email uses a privacy-preserving console stub until a verified Resend sender/key are configured. Test real delivery only to an authorised recipient. Sample data always remains stubbed. Monitor failed/exhausted delivery rows before launch.
- Browser worker registration and local notification tests are separate from server Web Push delivery, which remains a stub. Enabling real push also needs persistent subscriptions, recipient scoping and a configured transport; merely filling VAPID env fields does not enable it. SMS/WhatsApp are stubs and no provider accounts were created.

## OQ005 — History timezone changes after import

- M5 allows choosing a home timezone before importing. Post-import changes are explicitly refused because silently regrouping daily history would invalidate summaries, period anchors and alert timing.
- Supporting such changes needs a tested full re-bucketing workflow. Until then the UI explains the restriction; country of residence is separate from the history timezone.

## OQ006 — Additional PDF scripts

- Clinical PDFs embed Noto Sans and Noto Sans Devanagari, with Latin/Hindi visual fixtures. Characters outside these fonts' coverage, including emoji, cause an explicit PDF-unavailable response rather than a corrupted clinical document. The complete HTML summary and stored original text remain available.
- Add and visually verify further script fonts before advertising multilingual PDF support beyond the bundled coverage. No patient text is sent to an external font or translation service.
