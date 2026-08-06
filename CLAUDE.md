# SOULIA Warehouse Management System - Technical Documentation

## Project Overview
SOULIA is a comprehensive warehouse management system built with NestJS (backend) and vanilla JavaScript (frontend). The system manages transactions (sales/purchases/returns), inventory, expenses, and vault/treasury accounts.

---

## UI Standing Rules

### Search Boxes — Always Small, Simple Text (Jul 30, 2026)
All search inputs across the app (placeholder starting with "بحث") must keep small, simple text — no large or bold placeholder/value fonts. Enforced globally via `input[placeholder*="بحث"]` CSS rule near line 916 in `frontend/public/index.html`. Any new search box automatically inherits this; don't override it with a larger font-size.

---

## Movements → Order Detail Navigation & Full-Page Invoice View (Jul 31, 2026)

**Customer name is clickable again (Aug 3, 2026).** Both the transaction/order number (ref column, mobile card ref badge, grid card ref) and the customer name (`.mov-client-name`) open order details — across the desktop table (`renderMovementTxRow`), mobile card, and grid card renderers. All route through `openOrderView(id)`. On the desktop table, the client name cell is an `<a>` with its own `stopPropagation` click handler (the row itself has no click behavior — `handleMovRowClick` is a no-op, selection happens only via the checkbox).

### Route & deep-linking
`#movements/orders/view/{type}-{ref}` — e.g. `#movements/orders/view/sales-2254`, `purchase-2254`, `return-2254-RET`. The type prefix (`sales`/`purchase`/`return`, via `_ORDER_TYPE_SLUG`) makes the URL self-descriptive. Built by `_orderViewSlugFor(tx)`, parsed by `_parseOrderViewHash(rawHash)` (extracts the slug segment) + `_resolveOrderViewSlug(slug)` (strips the type prefix — matches by `indexOf('-')`, not `lastIndexOf`, so refs that themselves contain a dash like `2254-RET` still parse correctly). Old bare-ref links (`.../view/2254`, no recognized type prefix) still resolve, for backward compatibility with previously shared/bookmarked URLs.

**This sub-route is parsed in three places that must stay in sync** — all three set `window._invoiceViewRef` + `window._invoiceViewTxId = null` and route to `'invoice-view'` with `updateHash: false` (critical — passing `true`/default here overwrites the descriptive URL back to a bare `#invoice-view`, because `_doNavigateTo` normalizes the hash whenever it doesn't match the plain page id):
1. `showApp()` (~line 15783, inside the boot sequence) — handles hard refresh / first load. This was a real bug until Jul 31: the sub-route parsing existed in `popstate` but not here, so refreshing the page while on an order-detail URL landed on the Movements table instead.
2. `window.addEventListener('popstate', ...)` (~line 19312) — handles browser back/forward.
3. `openOrderView(id)` itself — the origin of a fresh navigation, pushes the hash via `history.pushState`.

The same three-place pattern also applies to `supplier-profile/{id}` — if adding a new deep-linkable sub-route, wire it into all three, not just `popstate`.

### `renderInvoiceViewPage()` (~line 34222)
The single full-featured invoice view, ported to full parity with (and now superseding, for Movements-table entry) the legacy `showInvoiceDetail()` modal — repeat-customer badge/history, pickup/Bosta status chips, manual-delivery notice, supplier attachments, discount badge with percentage/code, order timeline (مسار الطلب), payment timeline (سجل المدفوعات), comments (التعليقات), edit history (سجل التعديلات). The old `showInvoiceDetail()` modal still exists and is used by other flows (notifications, admin briefing, collections table, pickup cards, discount deep-links) — not removed, only detached from the Movements table's primary click paths.

**Layout**: Two-column dashboard (`.inv2-*` CSS classes), full-width (`#inv-view-content` is `max-width:1280px`, no longer the old 660px receipt-style cap). Breadcrumb + "الرجوع لـ{nav label}" both read the Movements nav label live via `_movementsNavLabel()` (looks up `NAV_ITEMS` — don't hardcode this string, it has been renamed before). All action buttons (icon-only نسخ الرابط/طباعة via `.inv2-btn-icon`; تعديل المعاملة; Update/Send Bosta; تحصيل/سداد; تأكيد/تراجع التسليم اليدوي) live in the top header row, not a bottom footer.

- **Main column** (`.inv2-col-main`): Customer Information (party card — no avatar circle, client name is font-weight 400) → Order lines (items table) → Order Summary → سجل النشاط ("Active Log", one tabbed card merging مسار الطلب/المدفوعات/التعليقات/التعديلات via `switchInvLogTab()`).
- **Side column** (`.inv2-col-side`): الحالة (Status) → حالة التسليم (Delivery Status, sales only) → بيانات الدفع (payment method + deposit amount with `payMethodIcon()`) → بيانات الشحن (shipping company + cost, sales only) → supplier attachments.

**Prices**: formatted as `1,000.00 EGP` (two decimals, English digits, currency suffix) via a local `fmt(v)` helper — every price/amount in this page goes through it. Don't reintroduce ad-hoc `.toLocaleString('en', {maximumFractionDigits:2})` without the EGP suffix/fixed 2-decimal minimum.

**Dark mode**: the whole page is theme-aware via `body.dark-mode` (this codebase's dark-mode mechanism — a class toggle, not `prefers-color-scheme` or `data-theme`; see `:root`/`body.dark-mode` CSS variable definitions near the top of `index.html`). Hardcoded hex colors were replaced with `var(--text)`/`var(--muted)`/`var(--border)`/`var(--bg-alt)` throughout. Semantic pastel status colors (deposit=green/collected=blue/owed=red rows, cancel-reason box, city badge) use new reusable classes with their own `body.dark-mode` overrides: `.inv2-status-row.is-success/.is-info/.is-danger`, `.inv2-badge-green`, `.inv2-text-green`, `.inv2-status-banner.paid/.cancelled/.pending`. When adding new colored UI to this page, follow this pattern (a class + explicit `body.dark-mode .class{}` override) rather than inline hex.

**Gotcha**: `toLocaleTimeString('ar-EG', ...)` / `toLocaleDateString('ar-EG', ...)` without the `-u-nu-latn` suffix renders Arabic-Indic digits (٠-٩), not Latin ones — a recurring trap in this codebase when copying date-format snippets. This page uses `'ar-EG-u-nu-latn'` everywhere (dates, Bosta sync timestamp).

**Refreshing after an action**: action functions that used to call `showInvoiceDetail(txId)` to redraw (comment add/edit/delete, `undoManualDelivery`, `syncBostaStatus`, `sendToBosta`) now call `refreshInvoiceView(txId)` — a dispatcher that redraws whichever view (this full page, via `currentPage === 'invoice-view'` + `window._invoiceViewTxId` match, or the legacy modal) is currently showing that transaction. New actions added to the invoice detail should call `refreshInvoiceView(id)`, not `showInvoiceDetail(id)` directly.

### Editing from the order page
`openEditMovement(id)` — the existing, fully-validated edit modal (stock checks, discount-code bundles, server-side edit lock, non-admin OTP-approval flow) — is reused as-is, unmodified. The "تعديل المعاملة" button is gated by the same lock rule as the Movements row (`_editLocked = isExchangeSalePendingCollect || cancelled || isStatusCancelled || isStatusCompleted`). The only change made anywhere in the edit flow: `_applyEditTxBody`'s success path and the non-admin OTP-request path in `saveEditMovement` now check `currentPage === 'invoice-view' && window._invoiceViewTxId === id` — if true, they call `renderInvoiceViewPage()` (refreshing this page with saved data) instead of only `renderMovements()`. This works because `openEditMovement` opens as an overlay on top of whatever page is active — it never navigates away — so "return to the same page after save" only required refreshing the right thing, not building a second edit UI. **Do not duplicate `openEditMovement`'s validation/locking/OTP logic elsewhere**; if a future page needs edit-from-here behavior, extend this same `currentPage`-aware refresh pattern rather than rebuilding the editor.

---

## i18n — Settings Page Localized (Aug 6, 2026)

All seven Settings tabs (عام / الشحن / الأمان / الطباعة / العروض / الإعلانات / البيانات) were localized — 218 `stg*` keys, 228 `data-i18n*` bindings. Same two mechanisms as the Products/Categories/Inventory work below; the notes there apply here too.

**`applyLang()` now re-renders the Settings page.** The static markup is covered by the sweep, but the shipping-companies table, discount-code and bundle rows, the tag manager, and the bundle audit log are built in JS template literals. `applyLang()` therefore calls `renderSettings()`, `renderDiscountCodes()`, `renderDiscountBundles()`, `renderTagMgmt()`, `renderDiscAuditLog()` when `currentPage === 'settings'`. **Add new JS-rendered settings sections to that list.**

**`#settings-lang-hint` stays untagged — deliberately.** `syncLangControls()` owns its text (it swaps between `settingsLangHint` and `settingsLangLockedHint`); a `data-i18n` binding would let the `applyLang()` sweep overwrite the locked message. The inline Arabic is the pre-`applyLang` fallback. See the "Language Policy" section below.

**Bosta status text is JS-written.** `_updateBostaKeyStatus()` / `_updateBostaWebhookStatus()` replace their container's `innerHTML`, so the container can't carry `data-i18n` (it would wipe the SVG). Their four messages now go through `t()` (`stgBostaKeySaved`, `stgBostaKeyUnset`, `stgWebhookSaved`, `stgWebhookUnset`); the initial "جاري التحقق..." is a nested `<span data-i18n="stgChecking">`.

**Direction, not just words.** The Bosta API-key and webhook instruction boxes had hardcoded `direction:rtl` / `text-align:right`, which left English text right-aligned. They now use `dir="auto"`. Watch for this on any settings block that hardcodes direction.

**`data-stg-keywords` is search data, not a label.** Those attributes feed `stgSearch()` and are intentionally bilingual — **do not translate or tag them**, or settings search breaks in one language.

**Two slider defaults were Arabic-Indic** (`١٢`, `٤` in `#ann-font-size-val` / `#ann-speed-val`) while `annCtrlUpdatePreview()` writes Latin digits on every change — an inconsistency until the first interaction. Now `12` / `4`.

---

## i18n — Products / Categories / Inventory Localized (Aug 6, 2026)

The الأصناف / التصنيفات / المخزن modules (including the product edit modal, manufacturing spec sheets, category & collection profiles, and the stock-movement log) were fully localized. ~1030 keys now live in `TRANSLATIONS`.

### The two mechanisms — pick the right one
1. **Static markup** → `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-html`, swept by `applyLang()`. **Keep the Arabic text inline** as the pre-`applyLang` fallback — don't delete it.
   - The aria attribute is **`data-i18n-aria-label`**. `data-i18n-aria` (line ~9629, Movements) is a typo `applyLang` never reads — that binding silently does nothing.
   - `applyLang` sets `textContent`, which **wipes child elements**. On a button containing an SVG icon, put the label in its own `<span data-i18n="…">` instead of tagging the button.
2. **JS-generated strings** → `t('key')`. `t(key, params)` fills `{n}`-style placeholders (`t('catCountLabel',{shown:3,total:12})`). The older `tf(key, vars)` does the same and still works.

### Rendered-in-JS pages must be re-rendered, not patched
Rows, cards, badges, chips and toasts are built inside template literals, so a `data-i18n` sweep can't reach them. `applyLang()` therefore re-calls `renderProducts()`, `renderInventory()`, `renderInventoryLog()`, `renderCategories()`, `loadCategoryProfile(currentCategoryId)`, `loadCollectionProfile(currentCollectionId)`. **Add new JS-rendered pages to that list** or they'll keep the old language until navigation.

### Module-level `const` label maps freeze at parse time
A `t()` call inside a top-level object literal evaluates once and never re-translates. Store a **key** and resolve at render:
- `FX_SORT_OPTIONS` entries carry `labelKey` (not `label`), resolved by `_fxSortLabel(opt)` at each render site. The `mov` context still uses legacy `label` — the helper falls back to it.
- `COL_STATUS_KEY` / `COL_TYPE_KEY` + `colStatusLabel(v)` / `colTypeLabel(v)` replaced the old `COL_STATUS_LABEL` / `COL_TYPE_LABEL` maps. Safe to translate because MongoDB stores **English enums** (`draft|active|archived`, `permanent|seasonal|…`).
- `INV_KPI_META` (~line 22410, the KPI "i" explainer) is **still hardcoded Arabic** — deferred, same pattern applies when it's done.

### Never translate a value that is also logic
Some Arabic strings are data, not labels. Translating them breaks behavior:
- **CSS class names**: `#page-inventory .inv-status-badge.متوفر{…}` (~lines 4337-4342) uses *Arabic class names*. In `renderInventory` the mobile card keeps raw `status` for the class and a separate `statusLabel` for the visible text. Same split in `_fxBuildChips` (values stay `ok`/`low`/`zero`) and `_fxSpecsSectionsHtml`.
- **API comparisons & params**: `r.status === 'منخفض'`, and movement types (`مبيعات`, `تسوية مخزون`, …) sent as `?type=`. `INV_LOG_TYPE_KEY` + `_invLogTypeLabel()` translate these **for display only**.
- **API error-contract literals**: `msg.includes('معلق بالفعل')`, `'الكود موجود'` — translate the message shown, never the compared literal.
- **DB content**: product/category/collection/supplier names, `a.by`, and the `'موظف'` `requestedBy` fallback.

### `t` shadowing — a real trap in this file
Callbacks like `movTypes.map(t => …)` shadow the global `t()`; any `t('key')` inside then throws. One such bug was fixed in `openFxDrawer` (param renamed to `mt`). **Check the enclosing callback's parameter names before adding a `t()` call.**

### Server-persisted Arabic is out of reach of the client
Collection **activity-log** entries (`سجل النشاط`) are written into MongoDB by `backend/src/collections/collections.service.ts` (`logActivity`) at action time, and rendered verbatim via `esc(a.action)`/`esc(a.detail)`. Backend service errors (`collections.service.ts`, `categories.service.ts`) reach the user through `t('errorPrefix',{v:e.message})` the same way. These **cannot** be translated by a key lookup — fixing them needs structured events (`{actionKey, params}`) or error codes, plus a legacy fallback for existing rows. `update()` also leaks raw enums into Arabic detail text (`الحالة: draft → active`).

---

## Language Policy — Admin Enforcement vs. Staff Preference (Aug 6, 2026)

Language is **two levels, deliberately separated**. Before this change it was a single shared `settings.lang`, so any employee switching language changed it for the whole system.

| Level | Where | Who writes it |
|---|---|---|
| System default | `settings.lang` (Mongo) | **Admins only** — `PUT /settings` is `@Roles('admin')` |
| Per-device preference | `localStorage['soulia_lang_pref']` | Staff, on their own device only |
| The policy switch | `settings.langEnabled` | Admins only |

`langEnabled` already existed in [settings.schema.ts](backend/src/settings/schemas/settings.schema.ts) / [settings.dto.ts](backend/src/settings/dto/settings.dto.ts) as a **dead field** — this wired it up. It is **`!== false`-checked everywhere**, never `=== true`: absent/undefined means permissive, so pre-existing installs and restored old backups (there is no settings migration block) keep the previous behaviour until an admin opts in.

### The core helpers (all in `index.html`, one block under `LANGUAGE POLICY`)
- `langLocked()` — `settings.langEnabled === false && !isAdmin()`. **The admin is never locked**; they're the one setting the default.
- `resolveLang()` — locked → `settings.lang` wins; otherwise device pref → `settings.lang` → `'ar'`.
- `syncLangControls()` — hides `#pm-lang` (profile menu), disables `#set-lang`, swaps the hint text, and shows the admin-only `#stg-lang-enforce-row`. Called from `applyLang()` **and** the settings-page render.
- `handleLangPolicy({force})` — re-evaluates and re-renders; used at boot and on the live socket event.
- `changeLang()` — guards on `langLocked()` first, so a staff member who re-enables the disabled `<select>` via devtools still gets rejected. Admin writes `settings.lang`; staff writes localStorage only.

### Gotchas
- **`#settings-lang-hint` deliberately has no `data-i18n`.** `syncLangControls()` owns its text (it swaps between the normal and locked variants); adding `data-i18n` back would let the `applyLang()` sweep overwrite the locked message.
- **Live enforcement** rides `settings:lang-policy`, emitted from [settings.controller.ts](backend/src/settings/settings.controller.ts) via the already-injected `PresenceGateway.emitEvent()`, and **only** when `lang`/`langEnabled` were in the request — unrelated settings saves must not churn every open session.
- When enforcement turns on, the socket handler calls `clearLangPref()` — otherwise the staff member snaps back to their stale preference the moment enforcement is later lifted.
- Boot calls `handleLangPolicy({force:true})` instead of the old `if (settings.lang) {…}`; it sits after several `await`s so the `const LANG_PREF_KEY` is long since initialized (no TDZ issue).

---

## Users Page — Table Redesign (Aug 6, 2026)

The Users page (`#page-users`, المستخدمون) was redesigned from a `.user-card` grid to a proper data table, matching the `.ent-table` conventions used elsewhere (Movements). The old card grid is gone; `.user-card` CSS was removed as dead code.

**Structure**: `#users-table-wrap.ent-table-card > .overflow-x.ent-table-scroll > table#users-table.ent-table` — same shell classes as Movements, so it inherits sticky header, borders, and dark mode for free. Toolbar above it (`.users-toolbar`) has a search box (`#users-search`, placeholder starts with "بحث" so it auto-inherits the global small-font rule) and a role filter (`#users-role-filter`). Both call `renderUsers()` on `input`/`change` — filtering happens client-side in `renderUsers()`, not via a separate function.

**Columns**: avatar+name+@username (`.users-avatar-sm`/`.users-name-cell`), job title (+phone as a sub-line), role pill, status pill, password (admin-only reveal toggle), joined date (relative, e.g. "منذ 3 أيام", with the exact date as a `title` tooltip), and a `⋮` actions column.

**Role/status pills**: `.user-role-badge` (`.user-role-admin`/`.user-role-staff`/`.user-role-viewer`) and `.user-status-pill` (`.is-active`/`.is-inactive`) — deliberately scoped class names, not the shared `.badge` class. **Gotcha**: this file has two competing `.badge{}` base rules (~line 94 pill-style, ~line 326 the one most existing code actually uses) that silently collide by source order. Don't add a third meaning to `.badge` — give new badge-like UI its own scoped class + explicit `body.dark-mode` override, as done here.

**Password reveal**: `_userPasswordCellHtml(u)` stores the plaintext in a `data-pw` attribute (escaped via `escHtml()`, which encodes `"` — `esc()` does not, and does NOT belong here) and toggles visibility via a delegated handler, `toggleUserPasswordVisibility(this)`. **Do not** inline the eye-icon SVG swap directly into an `onclick="..."` string — the SVGs use double-quoted attributes (`stroke-width="1.5"`), and embedding that inside a double-quoted HTML `onclick` attribute truncates the row's HTML at the first internal `"`, corrupting every cell after it in that row. This exact bug shipped once during this redesign; the delegated-function pattern avoids the whole class of mistake.

**Count label**: use `fmtN(n)` for plain counts (e.g. "5 مستخدم"), never `fmtJ(n)` — `fmtJ` returns HTML markup with an "EGP" currency suffix (`<span class="amt-cur">EGP</span> <span class="amt-num">...</span>`), meant for money amounts. Using it for a plain count renders literal "EGP" text and stray markup.

**Action menu**: reuses the Movements `.actions-dd`/`.dd-toggle`/`.dd-menu` + global `toggleActionMenu()`/`closeAllMenus()` portal pattern verbatim (see "Movements ⋮ action-menu pattern" — no new JS needed). Built via `_userActionsMenuHtml(u, isSuperAdmin, isInactive)`: تعديل always shown; تفعيل/تعطيل and حذف hidden for the `admin` super-admin account (existing backend rule — the super-admin can't be deactivated or deleted).

**Mobile fallback**: `#users-table-wrap` is hidden below 768px; `#users-grid` (repurposed — no longer a CSS grid, just a container id) becomes `.users-cards-mobile`, a flex column of `.users-mcard` cards built by the same `renderUsers()` call, one row-shaped card per user with the same data as the table row.

---

## Access Control & Security (Apr 25, 2026)

### Admin-Only Features
**Restricted Access**: Only users with `role === 'admin'` can access:

#### 📊 Reports (التقارير)
- Navigation item hidden from staff
- Page inaccessible to non-admin users
- Protected with password lock
- Contains all financial analytics and performance data

#### 💰 Sensitive Financial Data
**Purchase Prices (سعر الشراء)**:
- Hidden in Inventory table for staff
- Excluded from Excel exports for staff
- Only visible to admins
- Implementation: `.inv-buyprice-col { display: none }` for non-admins

**Stock Depletion Alerts** (🚨⚠️):
- Only shown to admin users
- Notifications for:
  - Items out of stock (current = 0)
  - Low stock items (current ≤ minStock)

#### 🔔 Administrative Notifications (Admin Only)
- **Expense Approvals**: معلق expenses
- **Return Requests**: طلب استرجاع/استبدال معلق
- **Cancellation Requests**: طلب إلغاء حركة معلق
- **Collection Reminders**: فرق استبدال بانتظار التحصيل
- **Complaints**: شكاوى معلقة

### Implementation Details
**Navigation Control** (`buildSidebar`, `findFirstAllowedPage`):
- NAV_ITEMS entries can have `adminOnly: true` property
- Items with `adminOnly: true` are filtered out for non-admin users
- Access is controlled via `isAdmin()` check

**Notification Filtering** (`buildNotifications`):
- Stock alerts: Only built if `currentUser?.role === 'admin'`
- All approval notifications: Already restricted with `currentUser?.role === 'admin'` checks

---

## Transaction Management System

### Transaction Types
1. **مبيعات (Sales)** - Customer sales with optional shipping and payment terms
2. **مشتريات (Purchases)** - Supplier purchases with payment terms
3. **مرتجع (Returns)** - Return requests from customers

### Transaction Form Features (Latest Update - Apr 24, 2026)

#### 1. **Improved Items Display** (Invoice-Style Layout)
- **Structure**: Product dropdown + Name/Code display + Price/Qty/Subtotal columns
- **Product Dropdown**: Searchable, shows code and name
- **Product Info Row**: Code and product name displayed below dropdown for clarity
- **Three-Column Grid** (aligned with labels):
  - **السعر (Price)**: Formatted with Arabic numerals, font-weight:600
  - **الكمية (Quantity)**: Number input, center-aligned, editable
  - **الإجمالي (Subtotal)**: Calculated (qty × price), highlighted in primary color, font-weight:700
- **Stock Info** (Sales only): Shows available stock with warning if oversold
- **CSS**: Rounded borders, background color (var(--bg-alt)), 12px padding, consistent spacing

#### 2. **Purchase Deposit Logic** (Critical Fix - Apr 24, 2026)
**Business Rule**: When deposit = 0 or empty → Full amount is debt (not paid)

**User Guidance** (Helper Text):
- Label: "العربون (دفعة مقدمة)" (Earnest/Deposit - Advance Payment)
- Helper: "اتركه 0 لاعتبار الكل ديناً للمورد — أدخل المبلغ المدفوع من الخزنة الآن"
  - Translation: "Leave it 0 to consider the full amount as debt to supplier — Enter the amount paid from the vault now"

**Frontend Calculation** (index.html:2859):
```javascript
const dep = Number(qs('#tx-deposit')?.value) || 0;
const paid = dep > 0 ? dep : 0;  // Key: 0 means no payment made
const rem = Math.max(0, total - paid);
```

**Display Logic**:
- Paid Now (العربون المدفوع الآن): Shows 0 if deposit empty, otherwise shows deposit amount
- Remaining (المتبقي للمورد لاحقاً): Shows amount owed to supplier
- Fully Paid (مدفوع بالكامل): Shows checkmark only when remaining = 0

**Saved to Database**:
- `body.deposit = paidNow` (0 if empty, X if has value)
- `body.remaining = purRemaining` (total - paid)
- `body.payStatus = purRemaining <= 0 ? 'مكتمل' : 'معلق'`

#### 3. **Save Button Protection** (Double-Click Prevention)
- Button disabled during save operation (opacity: 0.6)
- Re-enabled automatically after success or error via finally block
- Prevents accidental duplicate submissions

#### 4. **Animated Toast Notifications** (Apr 24, 2026)
**Success Messages**:
- Sales: "تم حفظ حركة المبيعات بنجاح ✅"
- Purchases: "تم حفظ حركة المشتريات بنجاح ✅"
- Returns: "تم إرسال طلب استرجاع معلق..."

**Toast Styling**:
- **Success**: Linear gradient(135deg, #10b981 0%, #059669 100%)
- **Error**: Linear gradient(135deg, #ef4444 0%, #dc2626 100%)
- **Animation**: slideIn 300ms + slideOut 300ms
- **Display**: Flex layout with icon (✅/❌) + message

---

## Approval & Cancellation Workflow

### Cancel Request Flow
1. Employee requests cancellation with reason
2. Manager receives notification (type: 'urgent')
3. Manager reviews and approves/rejects
4. Upon approval: Transaction marked cancelled, vault impact recorded

### Freeze/Archive Functionality
**Purpose**: Archive cancelled transactions for organization (similar to trash/archive)

**When Available**: Only for cancelled transactions (tx.cancelled === true)
- **Who**: Admin users only
- **Where**: Action menu (⋮) in Movements table
- **Label**: "تجميد" (Freeze)
- **Condition**: Button appears only when transaction.cancelled === true

**What Happens**:
- Transaction moves to "الحركات المجمدة" (Frozen Transactions) section
- Does NOT affect vault balance (no reverse operations)
- Does NOT affect inventory
- Transaction just becomes hidden from main view (archived)
- Can be unfrozen later if needed

**Confirmation Message**: 
"سيتم تجميد هذه الحركة الملغاة — لا تؤثر على المخزون أو الخزنة ويمكن فك التجميد لاحقاً"
(Translation: "This cancelled transaction will be frozen — does not affect inventory or vault and can be unfrozen later")

### Vault Messages (Purchase vs. Sales)
**For Purchases** (مشتريات):
- Color: Green (#10b981)
- Message: "سيتم **رد** {amount} **إلى** خزنة {method}"
- Meaning: Money returns TO the vault

**For Sales** (مبيعات):
- Color: Red (--red)
- Message: "سيتم **خصم** {amount} **من** خزنة {method}"
- Meaning: Money deducted FROM the vault

---

## Vault (Treasury) Section

### Tab Organization System (Apr 25, 2026)
**Vault Section Now Organized into Two Tabs**:

#### Tab 1: نظرة عامة (Overview)
- **Vault Segments**: 4-card display showing account balances (كاش, فودافون كاش, Instapay, تحويل بنكي)
- **Total Balance**: Fifth card showing aggregate balance
- **KPI Cards**: Key metrics (monthly net, trend, daily average, cash velocity)
- **Manual Adjustment**: Form to manually add/withdraw funds with accounting justification
- **Transaction Log**: Full audit trail table with filters and pagination

#### Tab 2: التحليلات (Analytics)
**Unified Analytics Card** with organized layout

**Charts Included**:
1. **التدفق النقدي (Cash Flow)**
   - Time period filters: 30/60/90 days
   - Shows inflow/outflow trends
   - Height: 300px for better visibility

2. **توزيع مصادر السيولة (Liquidity Distribution)**
   - Shows distribution across vault segments (كاش, فودافون, Instapay, بنك)
   - Legend alongside chart
   - Color-coded by segment

**Layout**: Full-width card with internal 2-column grid for side-by-side chart viewing

### Tab Navigation Function
**`switchVaultTab(tabName, btn)`** (index.html:6498)
- Manages switching between Overview and Analytics tabs
- Animates tab content with fade-in effect
- Updates button styles (active state indicator with accent color)
- Supports dynamic tab switching with visual feedback

---

## Dashboard & Reporting

### Expense Filtering (Apr 24, 2026)
**Approved Expenses Only**: Dashboard and Reports sections now filter expenses with `status === 'معتمد'`

**Dashboard** (transactions.controller.ts:53):
```typescript
const expenseTotal = expenses
  .filter(e => e.status === 'معتمد')
  .reduce((s, e) => s + e.amount, 0);
```

**Reports** (transactions.controller.ts:68):
```typescript
const expenseTotal = filteredExpenses
  .filter(e => e.status === 'معتمد')
  .reduce((s, e) => s + e.amount, 0);
```

---

## API Configuration

### Backend Base URL
- **Development**: `http://localhost:4000/api`
- **Socket.io**: `http://localhost:4000`

### Frontend Proxy (server.js)
- Routes `/api/*` requests to backend at `http://localhost:4000`
- WebSocket support enabled
- Error handling with 502 response on backend failure

---

## Key File Locations

### Frontend
- **Main Application**: `frontend/public/index.html` (~8400 lines)
  - Transaction form: Lines 2662-2684 (renderTxItems)
  - Deposit calculation: Lines 2859-2881 (calcTxSummary)
  - Save function: Lines 3233-3289 (saveTx)
  - Toast function: Lines 1747-1758

- **Proxy Server**: `frontend/server.js`

### Backend
- **Transactions Controller**: `backend/src/transactions/transactions.controller.ts`
- **Transactions Service**: `backend/src/transactions/transactions.service.ts`
- **Transaction Schema**: `backend/src/transactions/schemas/transaction.schema.ts`

---

## Locale & Formatting

### Arabic Numerals
- Function: `fmtJ(value)` - Formats numbers with Arabic numerals (٠-٩)
- Used in all price/amount displays

### Date Formatting
- `fmtDate(d)` - Full Arabic weekday + date (non-today/yesterday dates)
- `fmtDateTime(d)` - Arabic date + HH:MM format

---

## Recent Changes Summary

| Date | Change | Impact |
|------|--------|--------|
| Aug 6, 2026 | Full English localization of the Settings page — all 7 tabs (218 `stg*` keys) | See "i18n — Settings Page Localized" above |
| Aug 6, 2026 | Full English localization of الأصناف / التصنيفات / المخزن (~1030 translation keys) | See "i18n — Products / Categories / Inventory" above |
| Jul 31, 2026 | Order-detail full page: two-column layout, dark mode, type-prefixed URL, hard-refresh routing fix | See "Movements → Order Detail Navigation" above |
| Apr 24, 2026 | Fixed purchase deposit logic (0 = debt) | Critical business logic fix |
| Apr 24, 2026 | Redesigned items display (invoice-style) | Better UX |
| Apr 24, 2026 | Added save button protection | Prevents double submissions |
| Apr 24, 2026 | Enhanced toast animations | Better visual feedback |
| Prior | Approved expense filtering | Accurate dashboard totals |

---

## Development Notes

### When Making Changes to Transactions
1. **Deposits**: Remember the critical logic - 0 = full debt
2. **Vault Impact**: Check transaction type for green (purchase) vs red (sales) messaging
3. **Arabic Messaging**: Use `fmtJ()` for numbers, proper Arabic phrasing for operations
4. **Toast Messages**: Use `toast(msg)` for success, `toast(msg, true)` for errors
5. **Button Handling**: Always disable buttons during async operations to prevent duplicates

### Testing Checklist for Transaction Features
- [ ] Deposit = 0 shows full amount as remaining
- [ ] Deposit = X shows X paid and (total-X) remaining
- [ ] Deposit = total shows checkmark with "مدفوع بالكامل"
- [ ] Save button disables during save
- [ ] Toast notifications slide in/out smoothly
- [ ] Purchase cancellation shows green vault message
- [ ] Sales cancellation shows red vault message
- [ ] Dashboard excludes unapproved expenses
