# SOULIA Warehouse Management System - Technical Documentation

## Project Overview
SOULIA is a comprehensive warehouse management system built with NestJS (backend) and vanilla JavaScript (frontend). The system manages transactions (sales/purchases/returns), inventory, expenses, and vault/treasury accounts.

---

## UI Standing Rules

### Search Boxes — Always Small, Simple Text (Jul 30, 2026)
All search inputs across the app (placeholder starting with "بحث") must keep small, simple text — no large or bold placeholder/value fonts. Enforced globally via `input[placeholder*="بحث"]` CSS rule near line 916 in `frontend/public/index.html`. Any new search box automatically inherits this; don't override it with a larger font-size.

---

## Movements → Order Detail Navigation & Full-Page Invoice View (Jul 31, 2026)

**Customer name is no longer clickable.** The transaction/order number (ref column, mobile card ref badge, grid card ref) is the click target to open order details — across the desktop table (`renderMovementTxRow`), mobile card, and grid card renderers. All route through `openOrderView(id)`.

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
