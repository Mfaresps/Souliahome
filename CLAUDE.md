# SOULIA Warehouse Management System - Technical Documentation

## Project Overview
SOULIA is a comprehensive warehouse management system built with NestJS (backend) and vanilla JavaScript (frontend). The system manages transactions (sales/purchases/returns), inventory, expenses, and vault/treasury accounts.

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
