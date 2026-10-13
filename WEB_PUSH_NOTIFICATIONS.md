# SOULIA Web Push

Implemented locally; deployment and an actual iPhone delivery are still required for final acceptance.

## Behavior and permissions

Settings → General → Notification Settings provides six independently persisted category switches, a master switch, device activation/removal, and a test action. A shortcut in the notification bell opens personal notification settings for every active account, including employees without access to system settings. Administrators can configure all six types; staff/viewers can configure only their own mentions and master switch. Business and financial notifications remain administrator-only. The master switch preserves category choices. Notifications start disabled. Each account owns its preferences and can register several devices. Existing in-app mention/assignment notifications continue unchanged.

Deposit notifications include the registering employee's name, the saved deposit amount in EGP and the order reference, as explicitly requested. Manual transaction APIs pass the authenticated actor name separately from editable business/audit labels; receipt notifications use the recorded uploader, not the approving manager. Other notifications exclude financial amounts. Mentions include the sender's name and order reference without comment text. Customer contact details remain excluded. The timestamp is delivered as notification metadata for these concise messages. Links open existing authenticated record navigation. Logging never includes subscription endpoints, keys, payloads or provider responses.

Examples:

- Recorded deposit: «تم تسجيل عربون بقيمة 500 ج.م. للطلب رقم 2638 بواسطة أحمد علي.»
- Receipt awaiting approval: «تمت إضافة إيصال عربون بقيمة 500 ج.م. للطلب رقم 2638 بواسطة أحمد علي، بانتظار الاعتماد.»
- Mention: «إشارة من أحمد علي إليك في تعليق على الطلب رقم 2638.»

The notification settings panel now uses a two-column category grid on desktop, one column on mobile, accessible toggle switches, a separate device card, and collapsible iPhone instructions. Labels, feedback and device states follow the current SOULIA interface language. **Notification language** is a separate Arabic/English selector persisted on the account in `notificationaccounts.language`; the first visit initializes it from the interface language. That saved choice is used on the server for all six notification types and tests, including background delivery while SOULIA is closed. Names and order references retain their original spelling.

English deposit example: “Ahmed Ali recorded a deposit of EGP 500 for order #2638.” English mention example: “Ahmed Ali mentioned you in a comment on order #2638.”

| Event | Actual successful operation |
| --- | --- |
| Deposit | Successfully submitted Shopify receipt, clearly labeled as awaiting approval; approval after vault booking as a fallback if no submission notification was queued; initial manual sale deposit after vault booking; positive deposit increase after successful transaction update |
| Comment | New comment IDs after Shopify/transaction comment save; a saved follow-up note |
| Order | First saved Shopify order; successfully created manual sales transaction. Shopify conversion to a transaction does not create another order alert |
| Delivery problem | Bosta's existing `FAILED_ATTEMPT` / `RETURNED` transitions before delivery, when no unresolved issue is already open/awaiting |
| Delivered | Authoritative Bosta update mapped to `DELIVERED`; excludes intermediate states and manually locked delivery records |
| Mention | Explicit user mentions saved through the existing mentions API, sent only to the referenced account. The frontend passes the actual saved comment ID, and stable recipient/author/record/comment identifiers prevent retry alerts. System assignments and automatic follow-up participant notifications are excluded |

Unsaved draft receipts, comment edits/deletions, purchases, synchronization of already existing orders, manual delivery overrides and call-attempt log entries do not generate these alerts. A receipt's submission and approval share one stable deposit event ID, so recipients are not alerted twice for the same deposit. Deposit corrections that leave the amount unchanged do not count as a new deposit. Follow-up comments accept an optional UUID `requestId`; the shipped composer retains it on failed requests, and MongoDB's conditional update prevents retry duplicates. Older callers without a request ID still work, but cannot have transport retries identified as the same comment.

## Server configuration

The maintained `web-push` dependency is server-only. Local VAPID keys were generated in ignored `backend/.env`, without printing them. For another environment, generate a separate stable pair on a trusted server:

```sh
cd backend
npx web-push generate-vapid-keys
```

Transfer the generated values directly into private environment configuration; do not paste them into source, build output or logs. Required variables:

```dotenv
VAPID_PUBLIC_KEY=<generated public key>
VAPID_PRIVATE_KEY=<generated private key; server only>
VAPID_SUBJECT=https://admin.soulia.store
SHOPIFY_WEBHOOK_SECRET=<the existing Shopify app webhook signing secret>
```

`VAPID_SUBJECT` may instead be a valid `mailto:` address. The frontend receives only the public key from an authenticated endpoint. Keep keys stable between deployments; rotating them requires devices to unsubscribe and subscribe again. Missing VAPID configuration leaves notifications unavailable without preventing normal app startup.

Shopify webhook verification now rejects missing, incorrect or unconfigured HMAC signatures using the raw body and constant-time comparison. **Configure the existing Shopify signing secret before deploying**, or Shopify webhook ingestion will reject requests. Authenticated Shopify API sync remains available. Bosta webhook secret validation and status mapping remain unchanged.

## Actual deployment: Docker Compose / Jenkins

`docker-compose.yml` passes the four variables to the backend container. Set them through the host's ignored root `.env` or Jenkins secret environment bindings in the deployment workspace. The local `backend/.env` is for local Nest execution; Compose does not automatically read that file. No production host was changed during this implementation.

1. Configure those variables securely before the Jenkins deployment stage.
2. Keep HTTPS termination on the public reverse proxy for `admin.soulia.store`. This repository's frontend nginx listens on internal HTTP port 80; its TLS terminator and certificate configuration are outside this repository and were not verified here. Ensure the public certificate is trusted and HTTP redirects to HTTPS. Do not enable HSTS until the site's HTTPS setup has been verified.
3. Deploy through the existing Jenkins pipeline, or from the deployment workspace:

   ```sh
   docker compose -p soulia up -d --build --no-deps backend frontend
   ```

4. Verify `/manifest.webmanifest`, `/push-sw.js`, and both push icons return their actual files over HTTPS. The worker and manifest have explicit revalidation headers. The worker has no fetch/cache handler and never caches authenticated pages or financial responses.
5. Sign in as an administrator, activate a device, and send a test notification. Allow up to ten seconds for the worker to pick up a queued job.

Allow outgoing HTTPS to browser push services. Registration restricts endpoints to known Apple, Google, Mozilla and Microsoft push provider hosts to prevent arbitrary server-side HTTP requests. Unsupported providers fail with a clear registration error.

## Database changes and reliability

No financial or shipment migration is required. The notification module creates indexes on two new MongoDB collections:

- `notificationaccounts`: one account document per user, preferences and device subscriptions; unique user ID and unique subscription endpoint ownership.
- `notificationjobs`: durable per-event/per-user/per-device jobs; unique composite index, scheduled dispatch index and a 30-day TTL for cleanup and duplicate suppression.

These collections are necessary because there is no existing durable push/background queue. The existing Nest scheduler checks jobs every ten seconds. MongoDB leases prevent concurrent worker claims. Preferences, the current role required for each category, active account state and subscription ownership are checked again at dispatch. Sends have a ten-second timeout and at most three attempts. HTTP 404/410 removes the expired device. Repeated notifications use a stable display tag so retried delivery replaces the same alert.

Delivery is best effort: business operations and queue insertion are separate commits. A crash between them or a queue database failure can lose an alert, while never undoing the business record. Push providers acknowledge acceptance, not actual device display. A crash after provider acceptance can resend the same tagged notification. Event IDs suppress duplicates for the 30-day queue retention window. Existing business operations that lack their own idempotency key cannot distinguish a genuinely new record from a client retry that creates a new business record.

Notification collections are deployment/runtime state and are not added to the existing exported business backup/restore lists. Normal refresh, login and deployment preserve them in MongoDB. Moving to another database requires device re-registration and preference setup; this avoids restoring stale browser credentials or replaying queued alerts. Logout unsubscribes this browser without removing other devices or category choices.

## iPhone

Use iOS 16.4 or later. Open SOULIA in Safari → Share → Add to Home Screen. Open the installed SOULIA icon, sign in as an administrator, then Settings → General → Notification Settings → Enable notifications on this device, and grant permission. Enable desired categories. Close the app and test first with the test button, then a real authorized business event. If permission was denied, change it in iPhone notification settings before retrying. [WebKit's iOS Web Push requirements](https://webkit.org/blog/13878/) describe the Home Screen installation and explicit user-interaction requirement.

## Changed files

- `backend/src/notifications/notifications.{service,controller,module}.ts`: secured settings/subscription API, validation, durable queue, preference filtering and sending.
- `backend/src/app.module.ts`: notification module registration.
- `backend/src/shopify/shopify.service.ts`, `shopify.controller.ts`: order/comment events and enforced webhook signatures.
- `backend/src/shopify/deposit-receipts.service.ts`: approved and booked receipt event.
- `backend/src/transactions/transactions.service.ts`: manual sale/deposit/comment events.
- `backend/src/transactions/transactions.controller.ts`: passes authenticated actor names for deposit notification attribution.
- `backend/src/mentions/mentions.{service,controller}.ts`: explicit saved mention push routing and duplicate identifiers.
- `backend/src/bosta/bosta.service.ts`: verified delivery and existing delivery-problem transitions.
- `backend/src/followups/followups.{service,controller}.ts`, `schemas/followup.schema.ts`: saved comment event and optional retry ID.
- `backend/package.json`, `package-lock.json`: `web-push` dependency.
- `frontend/public/index.html`: manifest/icons, settings section, script loading, logout device cleanup, follow-up request IDs. Pre-existing user edits preserved.
- `frontend/public/notification-settings.{js,css}`: settings controls, permission UI, device management and authenticated navigation.
- `frontend/public/push-sw.js`, `manifest.webmanifest`, `push-icon-{192,512}.png`: installed app identity and native push worker.
- `frontend/nginx.conf`, `docker-compose.yml`: manifest/worker serving and server environment variables.
- `backend/test/unit/notifications.spec.ts`, `notification-events.spec.ts`, `test/integration/notifications.persistence.spec.ts`, `test/browser/notification-settings.cjs`: mocked delivery, real scratch MongoDB and browser checks.
- `WEB_PUSH_NOTIFICATIONS.md`: configuration, deployment, behavior and verification limits.

## Verification

Run from `backend`:

```sh
npm run build
npm test -- --runInBand notifications.spec.ts notification-events.spec.ts notifications.persistence.spec.ts
node test/browser/notification-settings.cjs
```

Persistence tests use only a uniquely named `soulia_test_push_*` scratch database on local MongoDB, deleted after testing. Push transport is mocked; no customer data or real notifications are sent by automated tests.

The original full run passed 1440 tests in 73 suites and failed seven existing static UI assertions in `staff-dashboard.spec.ts` and `shopify-order-edit.spec.ts`; their asserted UI code was outside the notification changes. After adding detailed deposit messages and mentions, the build succeeded and the final targeted run passed 268 tests across seven suites, including Arabic message formatting, saved comment identifiers, mention persistence/routing/deduplication, role restrictions, real MongoDB subscriptions, receipt accounting and transaction regressions. Chrome browser QA passed 12 checks covering seven administrator switches, separate mention preferences, restricted employee settings, the notification-bell settings dialog, logout hiding, mobile layout, master-switch preservation, error rollback and explicit permission/denial. Chrome required execution outside the restricted sandbox to launch.

Manual acceptance still requires the production TLS/configuration checks, actual iPhone Home Screen installation, permission approval, a push displayed while the app is closed, preference behavior on that device, and opening the relevant authenticated record.

The responsive/bilingual update passed the backend build and 68 focused tests, including English output for all six categories and test/receipt messages. Real MongoDB persistence checks also confirm that notification language survives a service restart. Browser checks cover Arabic/English layout, language selection, desktop/mobile grids, switch behavior and role restrictions. The local backend was restarted to activate the new language setting; production still needs deployment.

## Browser push registration troubleshooting

`localhost` can be used to test Web Push in a compatible standalone browser; it does not require production TLS. A browser registration error such as `Registration failed - push service error` occurs before the subscription is sent to SOULIA. Check the browser's notification permission, its push-service settings and network connection, and use a regular standalone browser instead of a private or embedded preview window. SOULIA's local VAPID pair and service-worker response were verified, and a host-level HTTPS connection to Google's push-service domain succeeded; that does not prove that the user's browser profile can register with the provider.

The UI now explains provider registration failures in Arabic/English, disables the server test until this device has a subscription, and detects a stale subscription key when explicitly enabling the device. Browser QA passed 21 checks including simulated provider failure and ensuring that the failed device never shows a successful activation/test. A successful provider registration and real device delivery still require manual verification in the user's browser.
