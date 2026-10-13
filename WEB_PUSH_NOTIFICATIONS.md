# SOULIA Web Push

Implemented locally; deployment and an actual iPhone delivery are still required for final acceptance.

## Behavior and permissions

Settings → General → Notification Settings provides seven independently persisted category switches, a master switch, device activation/removal, and a test action. The notification bell and the user profile both open personal notification settings, including for employees without system-settings access. Administrators can configure all seven types. Active staff/viewers can configure comments, new follow-ups, new orders, delivery issues, successful delivery and their own mentions. Operational events go to every opted-in active account; deposit notifications remain administrator-only, and explicit mentions go only to their target. The master switch preserves category choices. Notifications start disabled. Each account owns its preferences and can register several devices. Existing in-app mention/assignment notifications continue unchanged.

After authenticated startup, a supported device without activation is offered an in-app notification invitation. Native permission is requested only after the user clicks Enable. Successful registration produces an explicit confirmation. Not now is remembered per account/browser; the profile button remains available afterward. iPhone browser sessions show Home Screen installation instructions; installed iPhone apps and supported Android/desktop browsers use the regular explicit activation flow. Per-account device ownership, logout cleanup, role restrictions and preference checks remain enforced.

Recipients for one event are queued in parallel with the same event timestamp and display tag. The durable worker checks every second and sends up to 50 leased jobs concurrently, so a slow push provider does not serialize the other devices in that batch. Actual display timing remains controlled by each device, its connection and OS notification settings; simultaneous display cannot be guaranteed. Retry jobs retain the same event identity and deduplication key.

Deposit notifications include the registering employee's name, the saved deposit amount in EGP and the order reference, as explicitly requested. Manual transaction APIs pass the authenticated actor name separately from editable business/audit labels; receipt notifications use the recorded uploader, not the approving manager. Other notifications exclude financial amounts. Mentions include the sender's name and order reference without comment text. Customer contact details remain excluded. The timestamp is delivered as notification metadata for these concise messages. Links open existing authenticated record navigation. Logging never includes subscription endpoints, keys, payloads or provider responses.

Examples:

- Recorded deposit: «تم تسجيل عربون بقيمة 500 ج.م. للطلب رقم 2638 بواسطة أحمد علي.»
- Receipt awaiting approval: «تمت إضافة إيصال عربون بقيمة 500 ج.م. للطلب رقم 2638 بواسطة أحمد علي، بانتظار الاعتماد.»
- Mention: «إشارة من أحمد علي إليك في تعليق على الطلب رقم 2638.»

The notification settings panel uses a two-column category grid on desktop, one column on mobile, accessible toggle switches and a separate device card. Both settings and onboarding dialogs are centered within the viewport, with bounded height, internal scrolling and responsive typography. Labels, feedback and device states follow the current SOULIA interface language. Administrators retain their personal Arabic/English notification selector and also control **Employee notification language** for all employees. The latter is saved in `notificationconfig` (`employee-language`, default Arabic); staff/viewer account language choices are ignored and language writes from those roles are rejected. Their UI displays the effective language as a read-only value. Names and order references retain their original spelling.

The activation guide shows **STEP 01** (open the supported desktop/mobile browser or install/open the iPhone Home Screen app) and **STEP 02** (click Enable and choose Allow, with recovery instructions for denied permission). The existing explicit permission gesture is preserved. After a successful device registration and master-switch activation, the service worker registration displays an actual native confirmation: **🎉 تم تفعيل إشعارات سوليا بنجاح 🥳**, or its English equivalent in the effective notification language. Re-enabling an already connected/active device does not repeat this confirmation. Activation buttons and the guide are hidden while this device is active, and return when disconnected or paused. The invitation does not return for an active device; dismissing it still leaves the profile shortcut available. Explicit disconnect/master-off clears the prior activation reminder state.

The iPhone instructions follow [WebKit's Home Screen Web Push requirements](https://webkit.org/blog/13878/): iOS/iPadOS 16.4 or later, Home Screen installation and permission requested from an explicit user interaction. Browser tests simulate those flows; a physical iPhone remains required for delivery acceptance.

## Employee points and weekly summaries

The independently configurable `performance` category sends a targeted notification only to the account whose points changed, respecting its master/category settings, active state and device ownership. **⭐ Points Earned** includes `+N`; **⚠️ Points Deducted** includes `-N`. Bodies contain the actual recorded reason (shortened to fit the existing concise message limit) and an order reference where available. Clicking opens the authenticated user's own profile.

The existing scoring operations remain responsible for calculations. After their writes succeed, notification hooks record manual bonuses/penalties, deposit evaluation awards/revisions, successful-delivery points and assignment-credit removals/transfers. A deposit re-score notifies the net change, and an unchanged score produces no new alert. Moving credit sends the appropriate signed delta to each affected employee. Notification failures do not reverse scores or alter business outcomes.

`notificationpointchanges` is notification audit state, with a unique event/employee identity and source-log/time indexes. It retains signed movements and source-log links so deleting/replacing a performance row does not hide gross deductions from the weekly summary. Captured pre-existing score rows supply a baseline when needed; untracked current performance rows supply historical totals without being counted twice. This collection does not replace or modify `employeeperformancelogs`, which remains the source of the current balance. Like other notification runtime collections, moving/restoring databases without this movement collection loses notification movement history, but the existing performance balance remains available.

The Nest scheduler queues **📊 Weekly Performance Summary** every **Sunday at 09:00 Africa/Cairo**, covering the completed Sunday–Saturday week. Boundaries account for Cairo DST. The summary shows current balance, positive points earned in that week and the magnitude of points deducted. All active staff are considered, including zero-activity employees; preferences still determine delivery. A stable week/employee event key and the existing job deduplication prevent repeat sends within the queue's retention window. A server that is offline at the scheduled time does not run missed cron ticks automatically.

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

### Successful live deployment notifications

On `main`, Jenkins runs **Notify live release** after deployment and a successful frontend/API health check. The helper runs inside the live backend container and checks `http://frontend/version.json` against the expected CI build before writing anything. Build-only jobs, other branches, failed health checks and mismatched frontend versions do not announce a release.

Every active admin/staff/viewer receives a persisted bell entry: **🚀 تم رفع نسخة جديدة · SOULIA**, with the deployed version and timestamp. Device delivery follows the existing master switch and subscription permissions; it has no separate category switch. Arabic/English wording follows the existing recipient language rules. Event identity is `release:<BUILD_NUMBER>`, so rerunning the stage does not duplicate existing bell entries or device jobs. Notification failures can be retried through the same stage. The existing version watcher continues to prompt open sessions to refresh.

The helper reads database/VAPID configuration from the backend container environment. No new public endpoint, deployment secret or manual version bump is needed.

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

`VAPID_SUBJECT` may instead be a valid `mailto:` address. The frontend receives only the public key from an authenticated endpoint. Keep keys stable between deployments; rotating them requires devices to unsubscribe and subscribe again. When neither key is supplied, the server uses the persisted automatic configuration described below. An incomplete or invalid explicit configuration leaves notifications unavailable without preventing normal app startup.

Shopify webhook verification rejects missing, incorrect or unconfigured HMAC signatures using the raw body and constant-time comparison. Configure the existing Shopify signing key in **Settings → Shipping → Shopify** to enable delivery. Administrators can save it after deployment without server access or a restart. Saved credentials persist in the existing database across container replacement; password inputs stay empty, blank submissions keep the existing secrets, and stored values take precedence over environment fallback. Bosta webhook secret validation and status mapping remain unchanged.

Environment fallback remains supported: Docker reads the deployment environment or the root `.env` beside `docker-compose.yml`, **not** the local `backend/.env` (excluded from Git and Docker images). The optional root `.env.example` lists the supported variables. Do not commit credentials. Settings responses expose only configured flags for the signing key and API token, and downloaded configuration backups omit Shopify credentials.

Jenkins validates Compose before building/replacing containers. Its Shopify health helper reads persisted credentials and sends a signed empty order through the frontend proxy without saving an order. Broken configured webhook routing/signatures fail the health check. An unconfigured install emits a clear setup warning while leaving the application available for the administrator to configure Shopify. The probe confirms the application's own configured key works, but cannot prove it matches Shopify. After saving the signing key, use Shopify's Send test for `https://admin.soulia.store/api/shopify/webhook` to verify delivery.

The store name and Admin API token can also be saved in the same admin settings card. They are optional for new-order webhook delivery; imports, recovery and order edit delta resolution require valid API credentials. The card's Check saved connection action reports signing-key configuration and API connectivity separately, never returning credentials or Shopify error payloads. The deployment helper checks API read access using order IDs only and warns on missing/invalid credentials without preventing working new-order webhooks or administrator access. Replace an expired/revoked token in the card with a valid token with order read permission.

For manually configured hooks in Shopify Settings → Notifications → Webhooks, use the signing key displayed under that webhook list. `orders/edited` sends an `order_edit` delta; it is resolved through `order_edit.order_id` and the Admin API before applying the existing full-order update rules. This event therefore also requires `SHOPIFY_STORE_NAME` and `SHOPIFY_ACCESS_TOKEN`. Fetch failures return 503 for retry and never overwrite the stored order with partial edit fields. See [Shopify's order editing payload documentation](https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders).

## Actual deployment: Docker Compose / Jenkins

`docker-compose.yml` passes the variables to the backend container. Explicit keys can be set through the host's ignored root `.env` or Jenkins secret environment bindings. The local `backend/.env` is for local Nest execution; Compose does not automatically read that file.

When neither VAPID key is supplied, the server now creates one stable pair in the server-only `notificationconfig` collection. Subsequent deployments reuse that pair; only its public key is returned to the browser. Existing explicit pairs remain authoritative. A partial explicit pair is reported as incomplete instead of generating a replacement and breaking existing device subscriptions. The default subject is `https://admin.soulia.store`; other installations can override `VAPID_SUBJECT`. Keep the configuration collection with the same database as notification subscriptions. Configuration failures leave the app available and return a non-secret status code.

The device card shows when the server is not configured; the Enable button remains visible and can recheck server readiness. Permission is requested only on a separate explicit click after readiness is confirmed. Application JavaScript is revalidated after deployment. No production host was changed during this implementation.

1. Configure those variables securely before the Jenkins deployment stage.
2. Keep HTTPS termination on the public reverse proxy for `admin.soulia.store`. This repository's frontend nginx listens on internal HTTP port 80; its TLS terminator and certificate configuration are outside this repository and were not verified here. Ensure the public certificate is trusted and HTTP redirects to HTTPS. Do not enable HSTS until the site's HTTPS setup has been verified.
3. Deploy through the existing Jenkins pipeline, or from the deployment workspace:

   ```sh
   docker compose -p soulia up -d --build --no-deps backend frontend
   ```

4. Verify `/manifest.webmanifest`, `/push-sw.js`, and both push icons return their actual files over HTTPS. The worker and manifest have explicit revalidation headers. The worker has no fetch/cache handler and never caches authenticated pages or financial responses.
5. Sign in as an administrator, activate a device, and send a test notification. Allow up to ten seconds for the worker to pick up a queued job.

Allow outgoing HTTPS to browser push services. Registration restricts endpoints to known Apple, Google, Mozilla and Microsoft push provider hosts to prevent arbitrary server-side HTTP requests. Unsupported providers fail with a clear registration error.

## Admin notification categories

New-order pushes are personalized within the existing `order` category and event. When the saved Shopify ASSIGNE (`assignedTo`, a user ID) matches an active staff recipient, that employee sees `🛍️ New Order Assigned · SOULIA` and `Order #2771 · EGP 2,450 · Assigned to You`, populated with the actual order reference and total. Administrators and other opted-in employees continue receiving the ordinary `🛍️ New Order · SOULIA` / `New Order Received` message. Orders without an assignee remain ordinary notifications. Names are not used to infer ownership. The master/category preferences, active account checks, subscription ownership, direct order navigation and event/user/device duplicate suppression remain the same. No second new-order event is broadcast to the assignee. Manual reassignment retains its existing reassignment messages and does not announce an old order as newly received.

Notification titles begin with a shared event emoji in Arabic and English: 💰 deposits, 💬 comments/mentions, 📌 follow-ups, 🛍️ new orders, 🚨 delivery issues, 📦 deliveries, 🔐 OTP verification, ✏️ modification requests, ⏳ pending approvals, 🛒 Shopify updates, 🔄 modified transactions, 🛡️ security events, ❌ failed logins, ✅ approvals and 🚫 rejections. Completed changes to other records use ✏️ with “Record Modified”; test notifications use 🔔. Decision status takes precedence over the requested action, so an approved modification is labelled “Request Approved.” The same existing category switches control all these event titles. Message bodies, routing, role restrictions and queue behavior are unchanged. Titles use Unicode emoji passed through JSON to the native Notifications API, including variation selectors; native glyph appearance depends on the device/browser.

Administrators have four additional independent switches (`otp`, `approval`, `shopifyChange`, `security`) in their notification settings and profile shortcut. Each switch is stored per account and applies to all its subscribed devices. Staff and viewers cannot enable or receive these categories, including through direct API calls. Existing operational categories and onboarding remain available to employees.

- **OTP requests:** the requesting employee, the precise existing OTP action, reference and actual active code. This covers discount, purchase, import, product addition/deletion, supplier deletion/payment, cash register access, Excel export and invoice modification requests. Request creation and verification retain their existing checks, expiries and lockouts. The notification queue stores only the OTP record ID and a placeholder; the sender reads the original OTP immediately before delivery, checks its unused/unexpired state and recipient's current admin role, and limits provider TTL to the remaining code validity. Login authenticator secrets, attempted codes and passwords are never included. OTP queue entries expire with the code. A delivered notification cannot be recalled from an operating system's notification history; verification still enforces the original code's state and expiry.
- **Modifications & approvals:** pending requests and saved decisions for invoice edits/OTP authorizations, product edits, transaction and Shopify cancellations, customer returns, supplier returns, expenses, deposit receipt review, Shopify order approval/rejection and manual cash register review. Invoice and cash register edits also report actual saved modifications. Financial decision alerts follow successful financial operations; a rolled-back/failed operation does not produce a success alert. OTP verification means the authorization was granted; it does not assert that a later business action completed. Each category remains independent, so an OTP authorization or deposit review can produce separate requested-category alerts.
- **Shopify changes:** compare the stored Shopify payload with the incoming authenticated update, identifying address, price, quantity, products, shipping, discounts, notes, tags, payment/fulfillment, customer/billing and additional business fields. Numeric formatting, key ordering and transport timestamps alone do not alert. Notifications contain field names, never address values or customer contact data. Changes to shipped orders are detected without changing existing shipment/financial freeze rules. A historical record without a stored Shopify payload establishes a baseline on its first update. Existing webhook configuration must deliver `orders/updated` events.
- **Security:** newly saved audit events, failed login attempts (including unknown usernames), account lock/unlock, incorrect OTP verification, failed login/recovery authenticator checks, cash register/settings violations, data exports and authenticated role/permission denials. Unsupported anomaly detection is not introduced. One denied request is audited once even if multiple guards reject it. Notification contents use controlled event labels and exclude raw audit details, passwords, authenticator secrets, attempted codes, IPs and device fingerprints.

Clicking an admin alert opens its authenticated record: OTP audit row, exact security audit row, invoice/order detail, return detail, cash register detail or the existing approval detail and actions for products, expenses and supplier returns. URLs contain record IDs rather than codes. The specific OTP/security record is fetched separately so navigation also works outside the recent-record list. Notification clicks never approve an action automatically.

Admin events reuse the existing queue's event/user/device unique index and delivery tags. Duplicate suppression follows the queue retention window; business commits and best-effort notification insertion remain separate. Disabled notifications, invalid/expired devices or push provider failures do not reverse or interrupt business operations. Existing switches default enabled when the account's notification master switch is enabled; administrators can turn any category off independently.

Validation uses mocked push transport, isolated MongoDB test databases, browser checks of each new switch at mobile/desktop widths, admin/staff isolation, OTP expiry/use checks, duplicate webhook handling, approval failure paths and authenticated record routing. No production notification or deployment is performed by these tests. Verify real-device delivery after deploying both backend and frontend through the existing pipeline.

## Database changes and reliability

No financial or shipment migration is required. The notification module creates indexes on two new MongoDB collections:

- `notificationaccounts`: one account document per user, preferences and device subscriptions; unique user ID and unique subscription endpoint ownership.
- `notificationjobs`: durable per-event/per-user/per-device jobs; unique composite index, scheduled dispatch index and a 30-day TTL for cleanup and duplicate suppression.

These collections are necessary because there is no existing durable push/background queue. The Nest scheduler checks jobs every second and processes a batch of up to 50 jobs in parallel. MongoDB leases prevent concurrent worker claims. Preferences, the current role required for each category, active account state and subscription ownership are checked again at dispatch. Sends have a ten-second timeout and at most three attempts. HTTP 404/410 removes the expired device. Repeated notifications use a stable display tag so retried delivery replaces the same alert.

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
