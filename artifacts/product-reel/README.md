# Soulia — One system. Total control.

## Deliverables

- `Soulia-One-System-90s.mp4`: final vertical H.264 film, 1080 × 1920, 30 FPS, exactly 90 seconds / 2,700 frames. Silent; all messages are on screen.
- `timeline.json`: editable 11-scene sequence, durations, captions, visual targets and crop positions.
- `capture.cjs`: isolated Chromium capture of the application's shipped HTML, CSS and JavaScript.
- `render.cjs`: reusable portrait framing, title, camera motion, crossfade, progress and logo composition.
- `assets/`: original UI captures, copied product logo, composition panels and SRT captions.
- `verify.cjs`, `verification.json`, `decode-check.txt`: playback, timing and decoding verification.
- `review/`: rendered opening and second-half samples from every scene, plus a contact sheet.
- `capture-audit.json`: capture selectors, extracted visible text, request-block counts and browser errors.

## Implementation and audit

The frontend is an Express-served application whose main views and renderers live in `frontend/public/index.html`, extended by dedicated JavaScript/CSS modules. Navigation switches real page components including dashboard, Shopify orders, products, inventory, pickup orders, movements, suppliers, expenses, complaints, reports, vault and users. The backend is organized into NestJS modules for those operational domains.

The existing intercepted Puppeteer tests supplied the safe capture pattern. This project uses the actual local UI and its rendering functions, without replacing the product with mock HTML. Captures use the application's existing 520-pixel responsive layout at 2× pixel density. Portrait panels preserve proportions and crop deliberately to individual controls or records. External chart libraries are stubbed offline; no simulated charts are included.

Source evidence inspected:

| Domain | Evidence | What the film shows |
| --- | --- | --- |
| Dashboard | `buildDashKpis`, `renderDashKpis` in `index.html` | Actual KPI card design with the native value-privacy toggle enabled |
| Online orders | `shopify.controller.ts`: signed webhook handling, imports, approvals, reassignment, deposits; `renderShopifyOrders` | Order DEMO-1001, status, items, search and period counts |
| Follow-up | `followups.service.ts`: scheduled jobs; `renderFollowUps` | Confirmation ticket, awaiting-customer status and responsible employee |
| Products/inventory | `renderProducts`, `renderInventory`, inventory and warehouse modules | Real product cards and displayed stock availability |
| Preparation | `preparation-workspace.cjs` browser test; pickup workspace and inventory-unit modules | Prep group, same demo order, two required pieces, scanner-ready interface |
| Shipping | Bosta backend module and movement status renderer | Bosta-linked out-for-delivery status attached to the demo order |
| Finance/purchasing | Expense, supplier-ledger, purchase-order and transaction modules | Approved demo expense and supplier record |
| Team/service | `renderUsers`, complaints and after-sales modules | Admin/staff roles and customer follow-up assignment |
| Reporting | `shopify-kpis.js` report renderer and movement-history UI | Actual generated daily order report followed by a transaction record |
| Branding | `frontend/public/soulia-logo.svg` | Original product mark and existing Soulia name |

The demo order contains two products at EGP 150 each, total EGP 300; the demo expense is EGP 20. These are synthetic demonstration inputs, not actual company performance or customer records. Financial dashboard figures are hidden with the application?s native privacy controls because backend financial calculations were not exercised. Order counts and report figures are calculated by the real frontend from the demo order. The film labels every scene “ACTUAL APPLICATION UI · DEMO DATA.” No claim about the company's revenue or results is made.

## Feature-prioritization fallback

1. Prefer an implemented, directly inspectable interface that renders safely with local demo data.
2. Keep DEMO-1001 as the common record wherever the UI supports it.
3. If a feature requires a live provider, show the implemented status/control without executing the action or asserting live connectivity.
4. If a demo endpoint or computed dataset is unavailable, use a smaller working adjacent feature. Preserve the allocated scene duration and revise the caption to match what is visible.
5. Omit features whose implementation or safe presentation cannot be established. Never substitute invented dashboards or successful actions.

Applied fallbacks: scene 2 emphasizes computed order counts; scene 4 uses customer follow-up instead of staged automatic messages; scene 5 favors working product stock cards over the warehouse-filtered inventory fixture; scene 8 favors expenses/suppliers over unverified treasury balances; scene 9 shows roles and responsibility rather than employee rankings. Scene 10 uses the application's real daily-order report rather than simulated financial charts.

## Capture data-safety workflow

1. Launch a fresh headless Chromium session without a saved user profile, login token or production cookie.
2. Serve only files under `frontend/public` through request interception at the reserved capture origin `http://reel.test`.
3. Intercept every request. Fulfill local files in memory; return inert responses for all other resources. Never call `request.continue()`. No request reaches a real backend, Shopify, Bosta, messaging service or remote asset host.
4. Populate in-memory arrays with explicitly named demo customers, employees, suppliers, products and order identifiers. Use no customer phone, email, real address, credentials or production extracts.
5. Replace the capture session's API callback with fixture responses. Do not approve orders, scan stock, create shipments, settle funds or send messages on any service.
6. Record capture errors, request counts and visible text. Inspect captures before composition and inspect the final encoded frames.
7. Keep all tools, inputs and output under this dedicated folder. Do not load `.env`, existing logs or production databases. Do not modify application code, APIs or business logic.

## Scope and limitations

This is an edited film of authentic UI captures, with smooth camera motion and transitions between staged offline demonstration states. It is not a recording of a live order moving through backend transactions. The order-search state is entered through the actual search control, and the picking and report views use the real application functions. The shipping state is supplied as an offline fixture, not created by a carrier call.

The code supports more than is shown: Shopify webhooks/imports, deposits, scheduled follow-ups, purchase orders, piece scans, labels, returns/exchanges, carrier settlement, security permissions, and financial reporting. Live provider connectivity, successful automatic customer messaging, real scan completion, label generation, address verification, settlements, wallets, employee performance, and return/exchange execution were not exercised and are not represented as completed actions. The scanner view remains visibly awaiting scans.

Some user-management labels remain Arabic in the application's English mode. They are preserved rather than redesigned. Product images are not supplied by the fixture, so the application's own product placeholders are visible. Audio is intentionally omitted; there are no music-license or sound-sync dependencies.

No production source changes are required. Existing unrelated workspace modifications are left untouched. Full application regression tests were not rerun because this work changes only the isolated media project; the capture checks exercise the shipped renderers without server writes.

## Reproduction

From the repository root:

```powershell
npm ci --prefix artifacts/product-reel
node artifacts/product-reel/capture.cjs
node artifacts/product-reel/render.cjs
node artifacts/product-reel/verify.cjs
```

Capture uses the repository's existing `backend/node_modules/puppeteer` and its Chromium installation. The renderer's FFmpeg and Sharp dependencies are pinned by the local lockfile. `node artifacts/product-reel/render.cjs --scene=11` rerenders one scene and reassembles the complete film from existing clips. `clips/` and `node_modules/` are regenerable and ignored.

Verification checks the full MP4 decode, reads dimensions/duration in Chromium, seeks across all scene boundaries and the ending, and extracts two visual samples per scene. See the JSON and decoder log for actual results.
