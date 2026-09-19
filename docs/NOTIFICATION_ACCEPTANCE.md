# Notification acceptance

Configuration, provider acceptance and actual delivery are separate gates. None is
proof that a wearable will supply a reading promptly or that an alert is a
diagnosis/emergency service.

## Check configuration without sending

Run `HMS_NOTIFICATION_ENV_FILE=/absolute/path/to/private.env npm run notifications:verify`
against one explicitly selected file, or omit that variable to use only the
process environment. The script does not implicitly load `.env.local`. It checks
sender syntax, the VAPID contact and whether the public/private keys form the same
P-256 key pair. It prints fixed descriptions, never keys or sender addresses.

Add `-- --provider` to make read-only requests to Resend's domain API. The exact
sender domain must be verified with sending enabled. A sending-only API key may
not permit listing domains; an inaccessible result is **unverified**, not a reason
to widen the application's key permissions. Check that domain in the dashboard
using the existing owner account instead.

Vercel's sensitive variables cannot be downloaded. `vercel env run` may also merge
local values, so its output must not be represented as production validation.
The existing authenticated `/api/jobs/tick?check=notifications` endpoint checks
configuration inside the deployed runtime. Both GET and POST require the existing
cron bearer secret. This check returns before any database, provider or dispatch
work; its response is `no-store` and contains no credential values. It does not
verify sender-domain status or delivery. Never paste the bearer secret into a
URL, a screenshot, a document or source control.

## Controlled email acceptance — still requires approval

1. Record the intended recipient's explicit agreement to one test message.
2. Confirm the production sender domain and sending permission in Resend.
3. Use a clearly labelled test message with no real health information; record
   its delivery ID, UTC request time and provider status without retaining the key
   or private message contents in the repository.
4. Have the recipient confirm inbox arrival and any spam/junk placement. Provider
   acceptance alone is not inbox receipt.
5. Separately redeem one authorised Supabase magic-link email and confirm its
   production callback. Application Resend settings do not configure Supabase SMTP.

## Controlled push acceptance — still requires a real device

1. On a consenting tester's real supported device, enable notifications. Devices
   subscribed before the September VAPID replacement must Disable then Enable
   instant alerts to replace the old subscription.
2. Record OS/browser versions and notification permission. Test the installed
   web app where the platform requires it.
3. With approval, send one non-health test notification. Confirm receipt with the
   app foregrounded, backgrounded and the screen locked; record measured delays.
4. Check acknowledgement, expired-subscription handling and failed/exhausted
   delivery visibility. Repeat on each supported physical platform before making
   delivery claims. Simulators and synthetic `Sample data` (which is deliberately
   stubbed) do not satisfy this gate.

No real email/push delivery is claimed by the configuration checker. Keep failure
and freshness states visible; do not promise guaranteed emergency notification.

References: [Resend domain listing](https://resend.com/docs/api-reference/domains/list-domains),
[Resend pagination](https://resend.com/docs/api-reference/pagination).
