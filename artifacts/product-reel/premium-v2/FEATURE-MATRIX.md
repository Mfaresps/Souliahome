# Feature evidence, priority and fallbacks

## Content priority hierarchy

1. **Truth and safe data first.** Use implemented controls/statuses and the real application's renderer. Never invent a feature, provider success, automatic message, revenue metric or delivery outcome. Use only synthetic records, clearly labeled throughout.
2. **The order journey.** Preserve DEMO-1001 and the sequence order → confirmation → ownership → stock → preparation → dispatch → delivery. The first 52 seconds establish this story. Never replace it with a dashboard tour.
3. **Readable proof of the main action.** One relevant card, field group or control takes priority over fitting a whole page. Crop authentic UI rather than redesigning it. Important motion supports the demonstrated action.
4. **Connected business capabilities.** Finance/suppliers/returns, team/service/permissions, and reporting follow the main journey, in that order. Prefer clear examples over a list of features that cannot be demonstrated safely.
5. **Advertising pace and identity.** Retain all twelve scene windows, 41 purposeful editorial beats, strong English headlines, restrained branding and a clean four-second final lockup.
6. **Decorative motion last.** Remove visual flourish before removing information. If a conflict remains, change a shot and its headline within its fixed scene duration; never imply the omitted capability worked.

## Feature-to-scene fallback matrix

Paths below are relative to the repository root. Function names are searchable anchors that remain useful as line numbers change.

| Scene / time | Verified feature and source | Proof in the film | Applied fallback / exclusion |
| --- | --- | --- | --- |
| 01 / 00–05 | Real order, item and shipment components from `frontend/public/index.html`; `frontend/public/pickup-daily-shipping.js` | Fragments enter and connect under the two hook headlines | Start with UI fragments, not a dashboard. No synthetic dashboards or app logo. |
| 02 / 05–12 | `renderShopifyOrders`, `openSpOrderPeek`, `_spPeekHtml`; `backend/src/shopify/shopify.controller.ts` | Native DEMO-1001 order card, customer, delivery address, products and payment details | Shopify integration exists in source; no webhook receipt or live store connection is staged. |
| 03 / 12–19 | `approveShopifyOrder`, `_spStockVerdict`, `_spPeekFuHtml`; `backend/src/followups/` | Customer/address review, actual confirmation dialog and Prepare & Ship action; Awaiting Prep state | Address review is human review, not automated verification. Follow-up ownership replaces unsupported automated-message visuals. No sent-message fiction. |
| 04 / 19–25 | `openSpAssignModal`, `saveSpAssign`, `_spStaffList`; Shopify assignment/reassignment endpoints | Actual employee selection, current assignee and open-order count; animated card handoff | Native count is computed from the single fixture. No fabricated workforce rankings or throughput. No live assignment write. |
| 05 / 25–32 | `renderProducts`, `renderInventory`, `_spItemStock`; `frontend/public/warehouses.js` | Ordered products, 12/9 available, actual product records and MAIN inventory card | Provide the documented `warehouseBalances.MAIN` shape so stock does not falsely appear zero. No claim of external/live stock synchronization. |
| 06 / 32–39 | `_pwSubmitScan`, `pwScanAnyOrderUnit`, `_pwApplyScanReceipt`; `backend/src/inventory-units/`; existing `backend/test/browser/preparation-workspace.cjs` fixture pattern | Required pieces, packing note, actual scan handler, two scanned / zero remaining, matched piece indicator | Offline API returns match the two demo product IDs. No production inventory writes, physical camera scan, label creation or completed backend preparation claim. |
| 07 / 39–46 | `_carrierPickerHtml`, `_puDailyOrdersHtml`, `previewBostaAwb`; `backend/src/bosta/` | Native Bosta choice, tracking record, Preview label and Open in Bosta controls | No provider-generated label can be verified offline. The actual label-preview control takes its place; no fabricated barcode/waybill is drawn. Demo carrier settings are not evidence of the production account configuration. |
| 08 / 46–52 | `_puDailyOrderStatus`; `backend/src/bosta/bosta.service.ts` status mapping and `pickupStatus: Delivered` update | Same order: Out for delivery → Delivered using supported display states | States are fixtures, explicitly labeled offline. The tracking line stops at In transit until the Delivered shot. No customer portal or real carrier update claimed. |
| 09 / 52–60 | Payment section in `_spPeekHtml`, `renderExpenses`, `renderSuppliers`; `backend/src/expenses/`, `backend/src/supplier-ledger/`, `backend/src/after-sales/` | Native payment card, approved demo packaging expense, account filter, supplier record and linked return request | Live cash/wallet balances, purchasing execution and shipping settlement require backend datasets. Prefer these verifiable controls and records; no reconciliation/settlement success, purchase execution or actual funds movement is shown. |
| 10 / 60–68 | `renderUsers`, `openUserModal`, `_umTab`; follow-ups; `frontend/public/after-sales.js` | Staff role, assignment, customer-service follow-up, actual permission editor and pending return case | Native Arabic permission labels remain. Permission choices are those supplied to the demo staff record. Employee performance exists (`admin-team-home.js`) but no unverified performance dataset is presented. |
| 11 / 68–77 | `frontend/public/shopify-kpis.js`, `_spkOpenReport`, `renderMovements`, order comments | Genuine rendered Daily Orders Report, final-stage order KPI component, transaction record and packing comment | Single-demo-order calculations replace fabricated sales charts and financial KPIs. No synthetic chart is passed off as an app report. No full audit-history or financial reporting execution is claimed. |
| 12 / 77–90 | `renderDashKpis`, `buildDashKpis`, `frontend/public/soulia-logo.svg` | Modules assemble, actual dashboard KPI component, original logo and Soulia name | Native financial privacy masking avoids unverified dashboard figures. Final lockup has no invented URL, CTA or logo. |

## Supported modules not portrayed as executed

The workspace also contains purchase-order processing, supplier ledgers, vault cash/wallet/bank balances, carrier settlements, automated follow-up scheduling, employee performance, inventory movements, and detailed after-sales exchanges. Their existence is not proof of a successful demo transaction. The corresponding film windows prioritize the safely rendered adjacent features listed above. This is a broad product advertisement rather than an exhaustive click-through of every module.

## Capture isolation

`capture.cjs` opens a new Chromium profile and intercepts **every** request. It only serves static files from `frontend/public` at the reserved `reel.test` origin; it never calls `request.continue()`. Other resources receive inert offline responses. It reads no `.env`, saved profile, production logs or database. Application state is assigned in the page's memory, and the `api` callback returns local fixtures. The production app remains unchanged.

The scanner handlers use deterministic local operation IDs because the reserved HTTP capture origin does not provide secure-context UUID support. This shim belongs only to the temporary browser page. The fixture follows the repository's existing intercepted preparation test.

The capture audit lists selected elements and their actual displayed text, blocked/local request counts and JavaScript errors. A missing capture selector fails immediately instead of silently capturing a whole page. After any source update, regenerate and inspect the assets; fixed crop coordinates are tied to the current UI geometry.
