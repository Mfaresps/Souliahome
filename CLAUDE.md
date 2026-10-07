# SOULIA Warehouse Management System - Technical Documentation

## Project Overview
SOULIA is a comprehensive warehouse management system built with NestJS (backend) and vanilla JavaScript (frontend). The system manages transactions (sales/purchases/returns), inventory, expenses, and vault/treasury accounts.

---

## UI Standing Rules

### Search Boxes — Always Small, Simple Text (Jul 30, 2026)
All search inputs across the app (placeholder starting with "بحث") must keep small, simple text — no large or bold placeholder/value fonts. Enforced globally via `input[placeholder*="بحث"]` CSS rule near line 916 in `frontend/public/index.html`. Any new search box automatically inherits this; don't override it with a larger font-size.

---

## The Printed Invoice — Rebuilt as an A4 Commercial Document (Aug 28, 2026)

`buildInvoiceHtml` + `_invoiceSharedCss` — the sheet behind **every** print path
(`printInvoice`, `bulkPrintPDF`, the invoice page's printer button, the ⋮ menus).
Both function names and signatures are unchanged, so all six call sites were
untouched.

### It was a styled screen receipt, not a commercial document
The old sheet was internally consistent and looked fine, which is why it lasted.
It was missing the things that make paper a *record*:

- **No issuer block at all.** The header carried a logo and nothing else — no
  legal name, address, phone, tax card or commercial register. A customer holding
  the paper could not identify the seller, and the document had no standing.
- **No تفقيط.** The expected anti-tampering control on an Arabic commercial
  invoice, and entirely absent. A figure can be altered with a pen; a written
  sentence cannot.
- **No signature block**, so the printed invoice could not double as the delivery
  receipt it is used as.
- **`فاتورة مبيعات` was a small green pill** beside the logo. A formal document
  leads with its title and its number.
- **One unlabelled date.**
- **No page numbering** on a document that is normally two sheets.

### `@page` — the geometry was never declared
`.page` was a fixed `210mm` with **no `@page` rule**, so the print engine applied
its own default paper and margins and fought that width; a full invoice could
spill onto a third sheet. It is now `@page{size:A4 portrait;margin:0}` with the
sheet painting its own `14mm/13mm` padding — so the on-screen preview and the
printed page have identical geometry.

⚠ **`thead` is `display:table-header-group`.** Without it a long invoice printed
its second sheet as headerless rows — the columns could not be identified. `tr`
is `page-break-inside:avoid` so a line item never splits across sheets.

### The currency is stated once, in the column heading
`fmtJ()` emits an `EGP` run before **every** figure — six repetitions per column
on a document whose currency never varies. `.amt-cur{display:none}` hides that
run **inside the print sheet only**; the shared helper is not forked, so nothing
else in the app changes. The heading carries `سعر الوحدة / EGP` instead.

⚠ **The code column was deleted, not moved.** The old table printed the same code
twice — as a sub-line in column 2 *and* as column 3 — spending 64px of a 210mm
sheet to repeat itself. It now appears once, under the item name.

### التفقيط — `amountToArabicWords()`
⚠ **Arabic counted nouns inflect, and agreement is governed by the LAST number
spoken (`n % 100`), never by the whole amount.** Five distinct forms:

| Ends in | Form | Example |
|---|---|---|
| 1 | noun + numeral as adjective | `جنيه واحد` |
| 2 | dual — no numeral at all | `جنيهان` |
| 3–10 | plural (جمع قلة) | `ثلاثة جنيهات` |
| 11–99 | accusative singular (تمييز منصوب) | `أربعون جنيهاً` |
| round 100/1000 | **genitive** singular | `مائة جنيه` |

Three bugs this went through, all caught by the tests and all easy to
reintroduce:
- **`مائة ألفاً`** — a scale word is *itself* a counted noun, so `_arScaleWord`
  needs the same `% 100` rule. Testing `count` directly gets 100,000 wrong.
- **`مائة وواحد جنيه واحد`** — the `one`/`two` forms *embed* the numeral, so they
  may be used only when the amount **is** 1 or 2. For 101 the numeral is already
  spoken by the hundreds, and the noun must be the bare genitive.
  `_arNumeralSuppressed` is the only place that tests the whole number.
- **`واحد ألف`** — 1 and 2 are carried by the scale word (`ألف`/`ألفان`) and are
  never counted in front of it.

⚠ **Rounds to 2dp BEFORE splitting off the piastres** — reading the fraction off
an unrounded float prints 49 piastres where the total says 50.

### Company identity is data, not hardcoded text
Seven new optional `@Prop`s on `Settings` (`companyLegalName`, `companyAddress`,
`companyPhone`, `companyEmail`, `companyWebsite`, `companyTaxNumber`,
`companyCommercialReg`), a card in **الإعدادات ← الطباعة**, and `saveCompanyIdentity()`.

⚠ **Every line is omitted when its field is empty**, so an install that fills in
nothing prints exactly what it printed before (logo + `SOULIA`) rather than a
column of empty labels. **This is what makes the change deployable with no
migration and no backfill.**

⚠ The DTO fields are mandatory, not optional politeness — the whitelist pipe
**silently strips** any property the DTO does not declare, so the values would
have been dropped at save with no error.

### Data that was already stored and never printed
`payment` (terms), `carrierCode` → `carrierLabel()`, `shipZone`, `pickupRef` now
render in a terms strip. On a formal invoice these are **contract terms**, not
metadata. Each cell is omitted when its field is empty, so the strip disappears
entirely on a transaction that carries none of them.

### Other rules this sheet follows
- **Each document type names itself**: مبيعات / مشتريات / **إشعار دائن** for a
  return. A credit note is a different instrument from an invoice, so the old
  generic `فاتورة {type}` was wrong for returns.
- **`date` and `createdAt` are both printed and both labelled** — the business
  date can be backdated, and on a formal invoice they are different facts. The
  issue date is omitted when it equals the invoice date rather than printing the
  same value twice.
- **A cancelled document gets a ribbon and loses its signature block.** Nothing
  about a void invoice is meant to be signed for.
- **Notes sit beside the totals, not beneath them** — the space left of the
  totals box is otherwise dead, and using it keeps the signatures on sheet 1.
- ⚠ **Every numeric run is `unicode-bidi:isolate`** (`.num`, `.amt-num`, dates,
  phone, tax card). Latin digits inside Arabic prose reorder otherwise — the same
  class of bug as the write-off dialog and the vault journal. **Don't "fix" a
  mis-rendered figure by reordering the string.**
- The policy sheet gained an **acknowledgement paragraph** and both sheets carry
  «صفحة ١ من ٢».

### Verification
- **24 cases in `backend/test/unit/amount-to-words.spec.ts`.** ⚠ It **extracts
  the function from the shipped `index.html`** rather than copying it — a copy
  would keep passing after the real one broke, which is exactly what the
  pre-existing `returns.spec.ts` does wrong. Confirmed to fail (5 cases) when the
  `% 100` agreement rule is reverted.
- A sales and a purchase invoice rendered through the **shipped** functions, with
  every printed figure checked to reconcile: line `qty × unit = total`, subtotal =
  Σ lines, subtotal − discount + shipping = grand total, and paid + remaining =
  grand total. All match on both.
- Full suite: **615 tests, 31 suites, all passing** (was 591/30).
- `node dist/main.js` → *Nest application successfully started* — per the
  nullable-`@Prop` rule, `nest build` alone does not prove a schema change.

### Still open
- **The sheet is Arabic-only.** Every string is a literal, not a `t()` key. This
  matches the reports page and was deliberate — it is an accounting archive, not
  a view — but a foreign supplier cannot read it.
- **`printTxInvoice`** (the *unsaved* new-transaction preview, with its
  customer/shipping/warehouse tabs at ~line 34150) is a **separate builder** and
  was not touched. It still carries the old `.hdr`/`.info-bar` markup, so the two
  paths now look different for the same data.
- **No QR / e-invoice payload.** If ETA e-invoicing is ever required, the issuer
  fields added here are the prerequisite that was missing.

---

## Shopify Orders — Photos, Stock, Phone Toggle, Order Quick View (Oct 5, 2026)

### Product photos were never rendered
The items popover read `inv.imageUrl || i.imageUrl` — inventory rows carry no image
and most Shopify lines have no snapshot, so every item was a grey square (the same
defect the prep workspace fixed in Round 4). `_spItemImg(i, inv)` resolves: line
snapshot → inventory row → product by `inv._id` → `_pwItemImgUrl` (id/code/name),
trying both `shopifyName` and `name`. `_spThumbHtml` draws initials UNDER the
`<img>`, so a broken URL shows initials, never an empty tile.

### الأصناف cell — photos + a problem-only badge
Up to 3 stacked thumbnails, the count, and a badge **only when something blocks**:
red «N ناقص» (out of stock or short), amber «غير مربوط». No badge on a clean order —
same no-green-tick rule as before. `_spItemStock(i, idx)` is the one per-line state
(`na|missing|out|short|ok`) used by the popover and the quick view; `na` (inventory
not loaded) says nothing, as `_spStockBlock` already does.

⚠ `SP_COL_W.items` and `th.sp-c-items` are **150** — move together. The cell content
sits in `.sp-items-cq`, a **`<div>` size container** (containment does not apply to
a `<td>`), which sheds parts as `--sp-cw` compresses: extra photos → count on a
blocked row → chevron → tighter type → photo only below 54px. **The photo and the
badge are the last things to go** — verified visible with zero spill at 7 widths
1920→1024 (cw down to 0.547).

### Popover
Rows show photo, name, code chip, unit price, `× qty`, and stock as **have / need
with a bar** for short lines («0 / 1», «1 / 3») or a quiet «المتاح 12» for ok ones.
Header summarises «N جاهز · N يمنع التأكيد · N غير مربوط»; footer the items total.

### Phone under the client — optional
`{id:'phone'}` in `SP_COLS` toggles `[data-col="phone"]` from the الأعمدة menu.
⚠ It is **not** in `SP_COL_W` on purpose: it is a line, not a column, so hiding it
must not change widths or the day-separator colspan (a test checks this). Rendered
as a `tel:` link, `unicode-bidi:isolate`.

### Search
`_spMatchesSearch`: ref, client, tags, item name/`shopifyName`/code, and phone by
**digits only, from 3 digits up**. Goes through `_gsNorm`, so «٢٦٨١» finds #2681.

### Order # → quick view, not navigation
`openSpOrderPeek(id)` opens `#sp-peek` (a side panel) instead of leaving the page:
customer, phone, address, note, money (total/deposit/remaining/shipping/discount),
items with stock state, and the follow-up section.
- Follow-ups matched **exactly like `openShopifyOrderFollowup`** (shopifyOrderId,
  then normalised orderRef) — two rules would disagree about whether one exists.
- `followUps` is fetched here (≤1/min, `_spEnsureFollowUps`). **A failed fetch shows
  an error + retry, never «no follow-up»** (LOAD_FAIL rule). A late reply for a
  different order is dropped (`id !== _spPeekId`).
- When a follow-up exists the panel shows its status, owner, reason, calls n/3 and
  **the whole trail inline**, scrolled to the newest entry; the button opens the real
  `openFuCommentPopup` window. ⚠ No composer in the panel — one write path.
- ⚠ z-index **1150**: above the page, below `.fu-thread-overlay` (1200) and
  `#modal-overlay` (1300), so the trail, comments and confirm dialogs open over it.
  Escape closes the panel only when neither of those is open.
- `closeFuCommentPopup` and `_spRefreshOrderRow` refresh the panel, so a note added
  in the trail window or a comment count change shows without reopening.
- `openShopifyOrderFollowup` still exists (other callers); it is no longer on the ref.

### Comments window
Chronological, composer pinned at the bottom, opens scrolled to the newest, real
author photos via `_pwFindUser`. ⚠ The input id `inv-comment-text-<id>` is unchanged
— `selectMention` builds it.

### Verification
45 assertions in a real Chrome over the shipped `index.html` with a mocked API:
photos load, broken image → initials, badges (out/partial/unlinked/none), popover
stock figures, phone toggle + persistence + colspan, 6 search cases, quick view with
and without a follow-up, fetch failure + retry, z-order and Escape layering,
backdrop close, comments layout, 7 widths, 390px mobile, zero page errors.

### Round 2 (same day)
- **Stock is a mark, not a bar**: `_spStockMarkHtml(s, cls)` — ✓ «متاح 12», ✕ «غير
  متوفر» / «متاح 1 من 3», link icon «غير مربوط». ⚠ This reverses the earlier
  no-tick-on-every-row rule **at the user's request** (Oct 5) — inside the popover
  only; the table cell still badges problems only. The red/amber warn lines under the
  name were removed (the mark says the same); only «سعر مختلف» remains there.
- **«New»** is `.sp-new-badge` (pale pill), stacked UNDER the order number in
  `.sp-ref-cell` — inline it was clipped off the ~57px ref column.
- **Quick view shows the order's own comments** (`_spPeekCommentsHtml`) when there are
  any, separately from the follow-up trail — two different threads.
- **Assign**: `_spStaffCellHtml` — the name is the reassign button, an empty cell is
  «إسناد» (admin only, pending only). `openSpAssignModal(ids)` serves one or many;
  the selection bar has «إسناد». ⚠ Bulk = the existing per-order
  `PATCH /shopify/orders/:id/reassign` in a loop (that route owns the staff-only rule
  and `assignmentHistory`), and ⚠ a 200 with `{success:false}` counts as a failure.
  Failures are named; the selection is kept so they can be retried.
  `openReassignOrderModal` now delegates to it.
- **Filters**: the funnel used to open the DATE popover. It now opens `#sp-fpanel`
  (deposit · stock · status · staff · tags · has comments) on `<body>`, editing a
  DRAFT that «عرض N أوردر» applies (Escape/outside/Cancel discard). Groups AND,
  values OR. Applied after the cards and the star (`_spApplyPanel`), same counting
  rule. Stock options disable while inventory is not loaded. The date has its own
  calendar button (⚠ id `shopify-filter-icon-btn` kept — the date popover anchors on
  it) that names the active range. Every active filter is a chip in
  `#sp-active-chips` with «مسح الكل»; `#sp-result-count` says «عرض X من Y».
  `switchShopifyTab` resets `_spPanel`. The star chip moved into the toolbar.
- Verified: **73 browser assertions** (adds marks, New badge, assign single/bulk/
  partial failure, panel draft/apply/chips/OR/AND/Escape, date label, Clear all,
  comments in the quick view, names not clipped at 1440/1280).

### Round 3 (same day) — contact links, reassignment notice, «New» inline
- **WhatsApp / Vrobo / Call** from the customer's number: two icons on the phone
  line in the table (hidden with it), labelled buttons in the quick view.
  `_spIntlPhone` → `20xxxxxxxxxx` (⚠ wa.me with a bare `01…` opens a non-existent
  number). Vrobo is `https://merchant.vrobo.co/inbox?contact=<20…>&channel=whatsapp`.
  ⚠ The Vrobo icon is a file, **`frontend/public/vrobo.png`** — a **96px trimmed copy**
  of `Vrobo Logo.png` (1254px / 770 KB, kept as the source). Regenerate the copy if
  the logo changes; never point rows at the original. If it is missing the `<img>`
  removes itself and a red «V» tile shows.
  ⚠ The table icons are **grey at rest** (`filter:grayscale(1)`) and take their brand
  colour on hover / `:active` / focus — two saturated logos on every row out-shouted
  the name. The quick-view buttons stay in colour.
  The main-page contact window (`openCustomerContact`, `.fdc-btn.is-vrobo`) uses the
  same logo; its old purple tint was dropped (it clashed with the red mark).
- **A reassignment no longer announces itself as a new order.** `reassignOrder`
  called `notifyOrderAssigned` («أوردر جديد مُسند إليك»), and the client plays the
  new-order sound on «مُسند». It now calls **`notifyOrderReassigned`**: «تم إسناد
  الأوردر إليك» (assignee), «تم نقل الأوردر منك إلى X» (previous assignee), «تم إسناد
  الأوردر إلى X» (other admins), with `بواسطة` / `السابق` lines, and **skips the actor**
  (`changedById` from `req.user.userId`). ⚠ None of these lines may contain «مُسند».
  Client side, `_parseAssignLine` / `_assignTitle` are the one parser for all five
  first lines (card, toast, English localisation). 4 cases in
  `shopify-reassign-notify.service.spec.ts`, revert-checked (3 fail on the old call).
- **«جديد» is back on the order-number line.** Fits because `SP_COL_W.ref` 88 → **112**
  (with `th.sp-c-ref`), the cell padding is 4px, and an unstarred star no longer
  reserves 27px in the table (starring is in ⋮). Below 62px of content it becomes a
  green dot with the word in `title` — never clipped. Word at 1920/1440, dot at
  1280/1100 (measured).
- 83 browser assertions; backend Shopify specs 45/45; `node dist/main.js` loads.

### Round 4 (same day)
- **The star is drawn on every row again**, beside the number (faint `.3` until starred,
  18px) — reverses Round 3's "unstarred star takes no space" at the user's request.
- **Product photos are optional** from الأعمدة: `{id:'thumbs'}` in `SP_COLS` toggles
  `.sp-ithumbs[data-col="thumbs"]`. ⚠ Like `phone`, it is **not** in `SP_COL_W`. With
  photos off the count is never shed on a narrow blocked row (`:has()` rule).
- **Column visibility is now per-user, not per-browser.** `MOV_COLS_KEY` and
  `SP_COLS_KEY` were bare `localStorage` keys — one shared PC used by several
  employees mixed everyone's hidden columns together. `_colsPrefKey(base)` appends
  `_myUserId()` (`__u<id>`); `_readColsPref`/`_writeColsPref`/`_clearColsPref` are the
  one shared implementation both `_getHiddenMovCols`/`_getHiddenSpCols` and their
  `_set*`/`reset*` siblings now call. ⚠ **`_myUserId()` returns `''` before login**, so
  the key falls back to the bare base — this is also how a pre-existing saved
  preference (set before this change, with no suffix) keeps working: `_readColsPref`
  reads the suffixed key first and falls back to the legacy unsuffixed one.
  `_clearColsPref` removes both. Add any future per-column-set table (or any other
  per-user UI prefs) through these same three helpers rather than a bare
  `localStorage.getItem`.

### Still open
- Widening الأصناف (+46) and the ref column (+24) makes every other column narrower at
  the same viewport; the time column still ellipsises below ~1440px.
- The mobile cards show photos but not the stock badge, and have no assign control.
- Filter-panel state is in memory only — a reload clears it.

---

## Shopify Table — Action Column, Discount Badge, Header Type, Tag Tone, Items Popover (Sep 8, 2026)

Four defects, each measured in a real browser against the shipped stylesheet before
anything was written.

### الإجراء overflowed its own column at every viewport but one
The cell is a flex row of three controls. Measured natural widths: the comments slot
**44px** (a FIXED reservation, so rows with and without a count stay aligned), «تأكيد
الطلب» **92.5px**, the ⋮ toggle **30px**, plus two 5px gaps = **176.5px** — inside a
column declared **148px**. Overflow measured at +11.5px (1600), +19.6 (1440), +27.7
(1280), +32.4 (1100). The button sat over its neighbour, which is what the screenshot
showed.

`SP_COL_W.action` and the `.sp-c-action` CSS width both go to **178**. ⚠ **They must
move together** — the JS map re-totals the visible columns to set the table's
min-width, so a width changed on one side only mis-sizes the whole table.

⚠ **Widening alone is not the fix.** `--sp-cw` compresses every column
proportionally, so the cell is routinely narrower than its declared width. The three
controls are therefore explicitly ranked: the ⋮ and the comments button **never
shrink** (an icon control shrunk is an untappable target), and «تأكيد الطلب» is the
one that yields — its label ellipsises while **its icon never does**. A check mark
reduced to a sliver is not a smaller icon, it is a different mark, and this is the
control that commits the order.

`total` went 88 → **94** for the same reason, found by the same sweep: at the 0.60
scale a 1100px viewport produces, `EGP 2,450` was clipping its own value by ~1px.

### The header carried Latin typography over Arabic words
`thead th` set `text-transform:uppercase` **and** `letter-spacing:.04em` on every
header, nearly all of which are Arabic.

⚠ **Arabic is unicameral** — `uppercase` does nothing to «الإجمالي». But Arabic is
also **cursive**, and letter-spacing pries the joins apart, so «الإجراء» rendered as
loosened glyphs rather than a word. Measured: **0.38px of tracking on every Arabic
header**. The size was also 9.52px — below where the dots that *distinguish* Arabic
letters (ب/ت/ث) resolve.

The base rule now carries no case transform and no tracking, at .74rem. **«Tags» is
the only genuinely Latin header**, so it opts back in via `.sp-th-latin` rather than
the treatment being applied to everything.

⚠ **The header font scales with `--sp-cw`**, exactly as the body font already did. A
fixed header size inside a proportionally-compressing column ellipsises — and a
header that has ellipsised no longer names its column, which is its only job.
Verified: 5/5 viewports with zero clipped headers.

⚠ `spColAssigned` is **«الموظف» / «Staff»**, not «الموظف المسؤول» / «Assigned To».
The 104px column compresses to ~62px and the long label clipped at every width below
1920px. The content is a short name (Reem/Gannh), so widening the column for the
*label* alone would waste space on every row.

### Tag tone — three tones, and only two of them coloured
Every tag rendered as the same muted grey pill, so «confirmed» — a state the whole
page is organised around — was typographically identical to any other label the store
happens to attach. `_spTagTone(tag)` derives a tone from the tag TEXT.

⚠ **Display-only, derived, never stored.** Shopify tags are free text written by
staff and by apps, so an unrecognised tag must keep working exactly as before: the
default branch is the existing neutral pill, **not** an error state. 15 cases lock
this, including `VIP`, `soulia`, the empty string and `null` all staying neutral.

⚠ **Matched on the text lowercased and with emoji stripped** — «✅ 🥇 تم التأكيد» and
«confirmed» are the same meaning in this store.

⚠ **Only three tones, two coloured.** Colouring every tag would restate the
categorical-palette mistake the vault strip documents: with every pill coloured, none
of them is a signal.

⚠ **Pre-existing dark-mode defect fixed here**: `.sp-tag` inks with
`var(--text-muted)` and had **no dark-mode override**, so it painted rgb(30,41,59) —
a near-black — on the rgb(30,40,32) card: **1.34:1**, against the 4.5:1 floor. An
untoned tag was effectively invisible. Confirmed against the unmodified file (same
two colours), so it is not a regression from the tone work. Now 4.95:1.

### The items popover closed when you scrolled it
`.mov-items-popover` is `max-height:340px;overflow-y:auto`, so a long order scrolls
inside it — and `_closeMovItemsPopover` was bound **directly** as a capture-phase
`scroll` listener. That inner scroll therefore closed the very panel being read: **an
order with enough items to need the scrollbar was the one order whose list could not
be read to the end.**

`_movItemsPopoverScroll` guards on the event's origin (`pop.contains(e.target)`),
exactly as `_movItemsPopoverOutside` already guarded mousedown. Page scroll still
closes it — the anchor moves away.

⚠ **Both registration sites and the removal must use the same reference.** There are
two `addEventListener` sites (Movements + Shopify) and one `removeEventListener`; a
mismatch leaks the listener instead of removing it.

### الأصناف popover — the code is a chip, and stock is stated
The code rendered as «كود CUS-K-MB» — a label word plus a value in ordinary muted
prose, so the code (the part actually copied, searched and matched against the
warehouse) had no more standing than the word in front of it. It is a bordered
monospace chip now.

⚠ **`unicode-bidi:isolate` on the code is required, not decoration** — it is a
Latin+dash run inside an Arabic line and its dashes reorder without isolation. Same
rule as the vault journal and the printed invoice. **Never "fix" a mis-rendered code
by reordering it.**

**Available stock is now stated** («المتاح 12»), which is what the picker used to
leave the screen to find out. ⚠ **This is NOT the green "in stock" tick round 1
rejected**, and the distinction is the point: that was a status BADGE repeated on
every row, which buries the row that blocks the order. This is the available NUMBER,
stated quietly beside the code — and it is shown **only when the inventory index is
ready and the item is linked**, or every item would read «المتاح 0» because the
stock had not loaded. The red/amber warning lines still carry every actual problem.

⚠ **`.mip-code` is shared with the Movements popover**, so both renderers emit the
chip — changing one alone leaves the other with an unframed code.

### عمود الخصم — the code became a mark, and the column gave back 40px

The column was **124px** but the badge that usually renders in it is «−6%». Measured
badge widths against that 124px:

| what the row has | badge | column unused |
|---|---|---|
| «−6%» | 43.2px | **80.8px** |
| «−38%» | 48.5px | 75.5px |
| «−EGP 190» | 66.9px | 57.1px |
| «−8% SAVE10» | 85.9px | 38.1px |
| «—» (no discount) | 12.7px | **111.3px** |

So the column was mostly empty on every row, and it was taking that width from
twelve other columns that `--sp-cw` compresses on any screen below ~1900px.

**The real problem is that the code is a variable-length string in a fixed narrow
column.** No width fits `SAVE10`, `BOWDINING` and `WELCOMEBACK2026`. Two fixes were
built and measured before the third; both are recorded because both look reasonable
until rendered:

⚠ **Wrapping the code to a second line is wrong.** `.disc-badge` is a capsule —
`border-radius:24px` with `overflow:hidden` — and a capsule reads as one object only
on one line. Dropped to a second line its rounded ends split into two half-pills and
the code pill (a solid dark fill) became a detached block hanging under the amount
and outside the cell. It also pushed the row 44px → **45px**, breaking the table's
rhythm for exactly the rows that had a code.

⚠ **Truncating the code is worse.** «BOWDINING» clipped to «BOWDIN…» reads as a
*different* code, and identifying which code was applied is the pill's whole purpose.

**What shipped:** the cell states the *fact* that a code was used, at a width
identical on every row — the code pill becomes a fixed-width tag glyph — and the
code's **text** lives in the badge's `title`/`aria-label` and in the detail panel,
which is where a reader who wants the identity is going anyway.

Measured after: `SAVE10`, `BOWDINING` and `WELCOMEBACK2026` all render at **64.8px**,
one line, inside the new **84px** column. The column gave back **40px** to the rest
of the table.

⚠ **Applied to `#mov-table` as well as the Shopify table.** سجل المعاملات has the same
variable-length codes in a 64px column; leaving it on the old rules would make the two
tables state the same fact in two different shapes — the drift this shared component
exists to end.

⚠ **The glyph is painted as a CSS `mask` in `currentColor`**, not as an `<img>` or an
inline SVG fill, so it follows the pill's ink in light and dark mode without a second
copy of the artwork and without a hardcoded fill that would go invisible on one theme.

⚠ **A multi-code row must stay distinguishable from a single-code one** — they were
two visibly different pills before. The count follows the glyph, fed by `data-n` on
`.db-multi`. The code *names* stay in the markup for the non-table contexts that
render them in full.

⚠ **The badge scales with `--sp-cw`.** It is a fixed-size object, so unlike the text
columns it did not compress with the table — measured 54px inside a 51.8px cell at the
0.616 floor, i.e. painting onto الإجمالي next door. Its padding, its figure's
font-size and the glyph all now follow the same `clamp(.86, var(--sp-cw,1), 1)` curve
the table-wide font rule uses.

⚠ `SP_COL_W.discount` and the `.sp-c-disc` CSS width must move together — 84 in both.

### Verification
- **61 browser assertions** over the SHIPPED code (Chrome, functions extracted from
  `index.html`, never copied): the scroll guard, the popover's code chip / stock line
  / warnings / 25-item scrolling, all three tag tones with **real composited-pixel**
  contrast in light AND dark, header clipping + tracking across 5 viewports, and the discount badge in BOTH
  tables (constant width whatever the code length, never two lines, code text still
  reachable in title/aria-label).
  ⚠ Contrast is measured from a **screenshot pixel**, not from the rgba() value — the
  pill fills are translucent, so the raw colour is not what the eye sees.
- **11 viewports swept, 2560px → 960px**: zero overflow across all 12 columns, zero
  document horizontal overflow, row height a constant 44px, `--sp-cw` 1.000 → 0.600.
- **JS/CSS width agreement checked mechanically** — all 15 `SP_COL_W` entries match
  their `.sp-c-*` rule.
- ⚠ **Revert-checked**: restoring the direct `_closeMovItemsPopover` scroll binding
  fails the inner-scroll case.

### Still open
- **The mobile cards show no tag tone** — `_spTagTone` is wired into the table
  renderer only, so the two views state the same tags with different emphasis.
- **The tone lists are Arabic/English keyword sets**, not a managed vocabulary. A
  store that invents a new confirmation wording gets a neutral pill until the list
  is extended — which is the safe direction, but it is a hand-kept list.

---

## Shopify Orders — Operational Filters + Shared Columns (Sep 8, 2026)

Two changes to صفحة شوبيفاي: the filter surface was replaced, and three columns
were folded into the components سجل المعاملات already uses.

### The old filters answered a question nobody was asking
The page carried **three** overlapping summaries: a four-card KPI strip (اليوم ·
أوردر صحيح / ملغي / الإجمالي / يحتاج متابعة), five status chips (الكل / يحتاج
تواصل / جاهز للتسجيل / متابعة مع العميل / طلب غير مؤكد), and a «جاهز للتسجيل /
يحتاج متابعة» priority row above the table. All three described **where an order
sat in the confirmation flow** — which the smart-status column on every row
already states — while the questions actually asked of this page («مين دفع؟ مين
لسه؟ إيه اللي واقف على المخزن؟») had no control at all.

Replaced by **`SP_FILTERS`** — four cards, each a toggle that also states its own
numbers:

| key | الفلتر | Lead KPI |
|---|---|---|
| `deposit-paid` | مدفوع ديبوزت | المُحصَّل — cash already in hand |
| `no-deposit` | بدون عربون | قيمة معرّضة + الأقدم |
| `cancelled-orders` | ملغية | قيمة مفقودة + مستحق ردّه |
| `stock-blocked` | متعطل على المخزون | قيمة موقوفة + وحدات ناقصة / غير مربوط |

⚠ **`key` is the stored/compared value** (`_shopifyStatusFilter`). Renaming one
silently disables that filter — it matches no definition and `test()` is never
reached. Same code-vs-label split as `CANCEL_REASONS` / `CARRIERS`.

### The counting order is load-bearing
`renderShopifyOrders` runs **tab → search → date → draw cards → apply filter**.
The cards count the list *before* the active filter. Counting them after would
make every inactive card read 0 the moment one filter is on, so the cards would
stop being a map of the work and become an echo of the click just made. A test
locks this; reverting it fails.

⚠ **An unknown filter key is CLEARED, not applied.** A renamed entry (or a value
from an older build) would otherwise filter the list to zero, which reads as «لا
توجد أوردرات» rather than «this filter is broken».

⚠ **`_spStockBlock` returns null while `inventoryCache` is empty.** Without that
guard every order reads as stock-blocked because nothing resolves — measured: 5
of 5 falsely flagged. Same class as the Bosta tracking-number echo check.

⚠ **The inventory index is built once per render** (`_spCtx.inv`) and handed to
all four cards; each card's `test()` and its KPIs both need it, so building it
per card walks `inventoryCache` 8× per render.

⚠ **`_spLookupInvItem` mirrors `_spValidateBulkSelection`** (code, then `_id`,
then lowercased name). If the two disagree, an order reads as stock-blocked here
and sends fine — or reads clean and is refused at send.

Deposit detection delegates to **`_spDetectDepositAndMethod`**, the same helper
the deposit chips and the bulk-send use. A second copy would drift and the filter
would disagree with what the send books into the vault.

### الأصناف / الشحن / الخصم now use the Movements components
Each column was its own inline template with its own type scale and its own idea
of an empty cell, so the same three facts had to be re-learnt between the two
tables. They now go through `discBadgeHtml()`, `.mov-items-btn` + a popover, and
`.mov-ship-cell`.

⚠ **`_spDiscountBase` reads the stored `itemsTotal`**, exactly as
`_movDiscountBadge` reads `tx.itemsTotal`. Summing the line items instead is
wrong — a Shopify line carries the unit price, and an order whose lines do not
add up to the order value gets a base far below the truth: a 100 EGP discount on
a 500 EGP order computed against a 100 EGP base prints **«−100%»**, i.e. "the
whole order was free". Caught by a test; reverting it fails.

⚠ **The badge is rendered `size:'sm'` and WITHOUT a `txId`.** `showDiscountDetail`
resolves ids against `transactions`, and an unconfirmed Shopify order is not in
that array — the panel would open empty. `showSpDiscountDetail` resolves against
`_shopifyOrders` and **hands off to the full Movements panel once the order has
become a transaction**, so the richer panel (code usage, audit log) is never
downgraded.

⚠ **The popover CONTENT is deliberately not shared.** `showSpItemsPopover` reuses
the Movements popover's markup, CSS and its single set of teardown listeners, but
renders its own per-item status line — reusing `showMovItemsPopover` directly
would look identical and silently drop every stock / SKU-mismatch warning, which
is the entire reason this column gets opened before confirming. There is
deliberately **no "in stock" line**: a green tick on every row buries the one row
that blocks the order.

⚠ **A Shopify order has no `actualShipCost`**, so the loss sub-line never appears.
That is correct — the customer already paid this figure; do not invent a tariff
to compare against.

### Proportional shrink clips shared components
`_syncSpTableMinWidth` deliberately lets columns shrink rather than scroll
sideways, so at ~1440px the discount cell computes to ~87px against the 124px it
asks for. Inside the badge both pills then shrank and the **code** lost —
«SAVE10» rendered as «SAVE…», and half a code reads as a different code. Fixed
with rules **scoped to `#shopify-orders-table-wrap`** (the shared `.disc-badge`
rules must not move — `#mov-table` depends on them): the amount pill yields
first, the code pill keeps its intrinsic width. The same shrink spilled the items
button over its column edge at 1024px; it now ellipsises its count while the
chevron and warning icon never shrink.

⚠ **`SP_COL_W` must be edited with the CSS widths** (items 82→104, discount
74→124, and discount moved from the shared `.sp-c-num` to its own `.sp-c-disc`).
That JS map re-totals the visible columns to set the table's min-width.

⚠ **`fmtJ` does not round** — the average printed «22,033.333», three decimals of
a currency whose smallest unit is the piastre, in a 74px slot. `Math.round` at
the call site.

### فلتر النجمة — مستقل عمداً، لا كارت خامس
`o.starred` كان موجوداً ويُرسم في عمود المرجع، لكن لم تكن هناك طريقة لعرض المميّز
وحده. أُضيف كـ**شريحة مستقلة** (`_spStarOnly` / `toggleSpStarFilter`) لا كعنصر في
`SP_FILTERS`.

⚠ **الفرق ليس شكلياً.** الكروت الأربعة تصف حالة يستنتجها النظام من البيانات، والنجمة
علامة وضعها موظف بيده. ولو كانت كارتاً خامساً لأقصت غيرها — «مدفوع ديبوزت» **أو**
«مميّز» — بينما السؤال الحقيقي غالباً «المميّزة **من بين** اللي لسه ما دفعتش». فهي
مفتاح يتقاطع مع أي فلتر نشط، وحالته في متغيّر مستقل (دمجه في `_shopifyStatusFilter`
يعني أن اختيار كارت يمسح النجمة والعكس).

⚠ **يُطبَّق بعد رسم الكروت**، فتظل أعدادها معبّرة عن النطاق كاملاً — نفس قاعدة ترتيب
العدّ أعلاه. و`switchShopifyTab` يصفّره مع الفلتر.

### نافذة فلتر التاريخ كانت مبتورة
كانت تظهر ناقصة من الأسفل: صفّا الأزرار يظهران ثم يُقطع حقلا التاريخ و«إلى».

السبب **سببان**، وكلاهما يجعل الحل السابق بلا أثر:
1. `#shopify-orders-table-wrap` يحمل `overflow:hidden` (مطلوب — الجدول يُقصّ عند
   زواياه المدوّرة)، فأي منبثق بداخله يُقصّ معه.
2. ⚠ `.page` تحمل `animation:pageEnter` التي تُحرّك `transform`، و**أي سلف بـtransform
   يصير كتلة احتواء لعناصر `position:fixed`** — فتُنسب إحداثياتها إليه لا إلى نافذة
   المتصفح.

لذلك كان تحويل `position` إلى `fixed` بعد الرسم — وهو ما كان الكود يفعله — عاجزاً:
العنصر ظلّ داخل المُقصّ وداخل كتلة الاحتواء. الحل هو **نقل العنصر إلى `<body>`** عند
الفتح وإعادته عند الإغلاق، بنفس نمط `toggleSpColsMenu`.

⚠ **يُنقل ولا يُستنسخ.** كل الدوال تقرأ `#shopify-date-from` / `#shopify-date-to`
بالـid؛ النسخة تعني حقلين بنفس الـid فيقرأ نصف الكود النسخة الخطأ.

⚠ **المستمع `mousedown` في مرحلة الالتقاط** لا `click`: أزرار الفترة تعيد الرسم، وقد
يُزال الهدف قبل وصول `click` فيُقرأ كنقر خارج النافذة وتُغلق فوراً.

النافذة الآن تنقلب لأعلى إذا ضاقت المساحة تحت الزر، وتُقيَّد داخل الشاشة بهامش 8px،
وتُغلق مع تمرير الزر خارج الشاشة، والزر يبقى مضيئاً بـ`.is-pop-open` (لم تعد النافذة
ابنته فلا توجد علاقة CSS تصف حالته).

### Removed, not left unreachable
The status chips, their mobile quick-buttons and dropdown, the KPI strip, the
priority row, the `_toggleShopifyItems` body-portal, and **13 translation keys**
that no caller could reach. `.sp-filter-dot` survives — `_shopifyStatusBadge`
still uses it.

### Verification
- **56 browser assertions** over the SHIPPED page (Chrome, real
  `renderShopifyOrders`): card counts, all 12 KPI figures, toggle/clear, the
  unfiltered-base counting rule, unknown-key self-heal, all three columns, the
  popover, the discount panel's two paths, English, and the two empty states.
  ⚠ **Revert-checked**: the `itemsTotal` base, the counting order, the inventory
  guard and the unknown-key clear each fail a test when reverted.
- **54 layout assertions** across 8 viewports (1920→380px): no document overflow,
  no card or cell spill, all KPI values render, legible type, plus dark-mode
  contrast ≥4.5:1 and reduced motion.
- **34 assertions** for the star filter and the date popover: the intersection with
  the card filters, that card counts keep describing the full scope, the empty and
  English states, and — for the popover — that it reaches `<body>`, escapes both the
  clipper and the transform containing block, is never duplicated across
  open/close, still applies a range from the portal, and flips up when there is no
  room below. ⚠ **Revert-checked**: removing the `appendChild(pop)` fails 3.
- Backend suite **1032/1033** — the single failure is the pre-existing
  `staff-dashboard.spec.ts` case, confirmed to fail identically with these
  changes stashed.

### Still open
- **The mobile cards do not show discount or shipping**, so the two views state
  different facts about the same order.
- **The date filter still scopes only the table**, not a period label anywhere —
  the old KPI strip was the only thing that named the active period.

---

## Prep Group Orders — Rebuilt as a Picking Workspace (Sep 8, 2026)

`#pu-card-orders-modal` was a 760px single column of order cards, each with a
6-column items **table** whose product image was a 38px thumbnail and whose
quantity was a small amber pill in the 4th column. A picker reading that table
fast has nothing to anchor on: the qty sits between two prices in the same type
size, and the image is too small to identify the product from. **The quantity is
the one number a wrong reading turns into a wrong parcel**, and it was the least
prominent thing on the row.

Rebuilt as `.pw-*` — a two-panel workspace: left navigator (all orders in the
group), right workspace (the one order being picked).

### The quantity is read-only *by construction*
`.pw-qty` is a `<div>`, never an `<input>`. This is a screen for an order that
already exists — the qty is what the customer bought, and the only correct
interaction with it is reading it. The old `puCardItemChange` inline qty/price
editor is not reachable from here.

⚠ **A test asserts the workspace contains zero `<input>`, `<select>` and
`[contenteditable]`.** Adding an editable control here is how a picking screen
silently becomes an order editor.

### `_pwSelId` is an `_id`, never an index
The list re-renders on search, on add and on remove, so an index would point at
a *different order* after any of those — exactly the class of mistake this
screen exists to prevent. `_pwVisible` holds the ids **in display order** and is
what ↑/↓ walk.

⚠ **Selection never wraps.** Running past the last order and silently landing on
the first is how an order gets prepared twice. `pwMoveSelection` clamps.

### Two renderers, one selection
`_pucoRenderOrders()` draws the LEFT panel; `_pwRenderWork()` draws the RIGHT.
`_pucoRenderOrders` calls `_pwRenderWork` — **don't call the right one alone**
after changing which orders exist, or the panels disagree about the selection.

⚠ **`pucoTickOrder` patches the DOM rather than re-rendering.** `_pwRenderWork()`
would rebuild the items grid and reset its scroll position, throwing away where
the picker had got to in a long order.

### The keydown listener is bound ONCE, on `document`
Not per open — a listener added on each open stacks, and one key press then
moves the selection several rows. It is gated on the modal being open, bails
while the invoice panel is on top, and **ignores keys typed into any input**.
The search box forwards ↑/↓ deliberately via its own `onkeydown`
(`pwSearchKeydown`); that is why the document listener must skip inputs, or a
single arrow in the search box steps **two** orders.

### `direction:ltr` moves an element's START EDGE — bidi bit us again
`.pw-item-code` was `direction:ltr`, which printed «كود 33» at the far side of
the card instead of under the product name. Same for the two phone lines. The
value is isolated with `<bdi>` / `unicode-bidi:isolate` and the **line keeps the
page's direction** — the identical rule the vault journal's metadata rows follow.
**Never fix a mis-placed Latin run by flipping its container's direction.**

⚠ Likewise `margin-inline-start:auto` on `.pw-abtn.is-go` threw the primary
action to the opposite end of the bar from every other button in RTL; on narrow
viewports it is reset to 0 and the prepare band takes the full row.

### Other rules
- **Opens on the first order still to be prepared**, not blindly on the first
  row — reopening a half-done group should resume, not restart.
- **Removing the selected order hands the selection to the one that took its
  place**, so the workspace is never empty beside a list that still has orders.
- Below 860px the nav becomes a *view you switch to* (`.pw-show-work`), not a
  squeezed column — shrinking both halves makes neither usable. `pwShowNav()` is
  the back path; the button only exists at that breakpoint.
- `auto-fill` (not `auto-fit`) plus `max-width:560px` per card, so a 1-item order
  gets the same card width as a 9-item one instead of one stretched panel.
- The group progress bar moved into the top bar so it is visible from every
  order. `#puco-progress-fill` / `#puco-progress-count` ids are unchanged, so
  `_pucoUpdateProgress` was not touched.

### Nothing about the workflow changed
Every action is the same function it was: `pucoTickOrder`, `pucoShowInvoice`,
`pucoRemoveFromPrep`, `pucoRestoreFromReady`, `pucoMoveGroupToReady`,
`pucoAddOrder`. Every input id (`#puco-search-input`, `#puco-add-ref-input`,
`#puco-add-suggest`, `#puco-count-badge`) is unchanged. The auto-move-when-all-
ticked, the backend `prep-check` PATCH and `_puSavePrepGroups` are untouched.
**This was a presentation rebuild, not a logic change.**

⚠ The old `#puco-footer` and its `#puco-move-ready-btn` / `#puco-move-prep-btn`
were **deleted** — per-order actions now live in the workspace's own action bar.
`pucoMovePendingToPrep()` survives as a global with no caller.

### Verification
- **85 jsdom assertions** over the SHIPPED renderers extracted from `index.html`
  (never copied): 1/2/4/6/25-item orders, read-only qty, selection, search,
  prepared state, ready-column variant, XSS, a 60-order group.
  ⚠ **Revert-checked**: making the qty an `<input>` and making ↑/↓ wrap fails
  **8** of them.
- **15 real-browser (Chrome headless) checks** of the document keydown listener,
  including "no double-step" from the search box and inertness once closed.
- **18/18 viewport combinations clean** (3 datasets × 500→1920px) on: no document
  overflow, panels inside the shell, internal scrollers, no item spill, actions
  never clipped, qty font ≥22px.
- 127 `.pw-*` rules parse; no emitted class lacks a rule; all 33 `t()` keys exist
  with real `en` values (no empty-string fallback trap).

### Round 2 — completion flow, «n ×», notes (same day)

**The quantity is now «2 ×» anchored to the product photo**, not a labelled QTY
block beside it. A picker reads «this product, this many» in one fixation; a
separate box made the count a third column with no stated relationship to the
image. `.pw-mult` sits on the photo's **outer** corner — `inset-inline-end`, not
`-start`, which in RTL lands it on top of the price column.

⚠ **`.pw-mult` is `direction:ltr` and that is correct here**, unlike on a text
line: the box **is** a Latin expression (digit then `×`), not Arabic prose with a
number in it, and being `inline-flex` its own start edge is all that moves. Left
in RTL flow the two spans swap and it renders «× 2».

**The prepare control moved into the header, beside the order number**, and the
footer band was deleted. Two controls for one decision is how an order gets
ticked by accident, so there is exactly one — a test asserts that.

### Completed orders sink; the next pending one opens
`_pwOrderForDisplay` puts still-to-pick first and completed last. A **single**
divider is drawn above the completed run.

⚠ **There is deliberately no «PENDING» heading.** The top of the list is the
default state, and naming a default costs a line and teaches nothing. Only the
exception group is labelled.

⚠ **The sort runs on a COPY and is stable.** `group.orders` is the stored
membership that `_puSavePrepGroups` persists — sorting it in place would rewrite
the saved group on every tick. Stability keeps entry order inside each half.

⚠ **The auto-advance target is computed BEFORE the re-render**, from the pre-move
list, so "the next one" means the next one the picker had in front of them — not
whatever slid into that row afterwards. It only fires when the order **just
completed was the selected one**: ticking some other order, or un-ticking, leaves
the picker where they are. `_pwNextPending` returns `null` on the last order
rather than jumping somewhere arbitrary.

⚠ **`_pwFlipRender` is FLIP, not a hand-rolled slide**: measure every card,
re-render, measure again, transform each back to where it was, release. The
browser animates a *real* layout change, so the cards below close the gap
themselves and nothing can drift out of sync with the list it is animating.
~340ms plus a one-shot ring on the finished card — `prefers-reduced-motion`
skips both. **No confetti: this is a daily operations tool, not gamification.**

### Order notes are shown where the packing happens
`notes` (the order's own note) and the last three `comments` render under the
customer chips. Both already travel with the order and neither is in
`LIST_EXCLUDED_FIELDS`, so this needed **no request and no backend change**. A
picker who cannot see «بدون كيس» packs it wrong, and that instruction used to be
two screens away. The order note is tinted (an instruction); comments stay
neutral (a conversation). Overflow is **stated** («+4 أقدم — افتح الفاتورة»), not
silently truncated.

### Hold Space to peek at the invoice
Calls the same `pucoShowInvoice` the button does — a shortcut, not a new
capability.

⚠ **Held, not tapped**, because Space is also how a focused button is activated,
and a tap must keep doing that. ⚠ **`e.repeat` is load-bearing**: the OS fires
keydown continuously while held, and starting a fresh timer on each one means the
invoice never opens. ⚠ **keyup, `blur` and `visibilitychange` all cancel** — a
keyup the page never sees would otherwise leave the timer armed and open the
invoice later, over whatever the user did next.

### Also fixed
- **«Code Code 28»** — the label was printed twice on the item code line.
- **`_PW_NOTE_SVG` was declared below its only consumer.** `const` is not
  hoisted; it now sits above `_pwOrderCardHtml`.

### Round-2 verification
- **57 new jsdom assertions** (142 with round 1): completion ordering, sort-on-a-
  copy, stability, `_pwNextPending` in five states, the multiplier's read-only
  markup, notes/escaping/Latin digits, the ready-column variant, selection
  surviving a reorder.
- **25 real-browser assertions** for the tick → reorder → auto-advance chain, the
  FLIP transforms, and every space-hold edge (auto-repeat, early release, blur).
- ⚠ **Revert-checked**: removing the completion sort and making auto-advance take
  the next *row* rather than the next *pending* fails **8** jsdom cases and the
  browser reorder case.
- 15/15 keyboard, 18/18 viewport-layout, 162 `.pw-*` rules, 36 i18n keys with
  real `en` values.

### Round 3 — the prepare button, authored comments, softer motion (same day)

**The Prepared button showed two ticks.** `puTickDone` was `'✅ تم التحضير'`
while the button also draws an SVG check — so the label spelled an icon the
control already had. The emoji is gone from both labels: **an icon is drawn,
never spelled.** A test asserts one `<svg>` and zero tick characters in that
button, because this is easy to reintroduce by "improving" a string.

The button also had no press response. It now depresses 1px on `:active`, the
check strokes itself in over 240ms, and the whole control settles once
(`pw-tick-fire`). ⚠ **The press class is added BEFORE the re-render**, on the
element the user actually clicked — the reorder replaces that node a frame later,
so an animation started after it would play on nothing.

### Comments were rendering with no author and no date
⚠ **Both writers store `employee` and `timestamp`** (`addComment` and the
invoice's `saveInvoiceComment`). Round 2 read `c.by`/`c.at`, which exist nowhere,
so every comment showed a blank byline. `createdAt` is a **time-only string**
(`'10:14 ص'`), so it is a display fallback only and must never be parsed as a date.

Comments now render as a thread: avatar, author, timestamp, text.
`_pwAuthorAvatar` uses the author's real photo when a matching user is loaded and
falls back to coloured initials. ⚠ **The match is by NAME, not id** — that is all
a comment stores — so an unmatched author still renders as initials rather than
vanishing. `_pwAvatarBg` is hue-only (fixed S and L), so no avatar out-shouts the
amber count or the green tick, and the same person keeps the same colour.

⚠ **EVERY comment renders, not a slice.** A truncated thread hides the newest
instruction behind a "+3 more" the picker has no reason to click. The list
scrolls instead, capped at 168px so the **items grid stays above the fold** —
notes are context, the products are the job.

The two panels are separate on purpose and each states its audience («واردة مع
الطلب» / «تظهر للموظفين فقط»): the customer's note is an instruction that came
with the order, the internal thread is the team talking to each other, and acting
on the wrong one is a real packing error.

### Motion
- **Switching orders fades and lifts** (`.pw-in`, 260ms, items 45ms behind the
  header) instead of snapping. ⚠ **Only `opacity`/`transform`** — anything
  animating height stutters on a long grid.
- ⚠ **A same-order re-render neither animates nor scrolls.** `_pwRenderWork`
  keeps `data-pw-order` and restores `.pw-items-wrap.scrollTop`, so ticking a box
  or a note arriving does not throw the picker back to the top of a long order.
- **Hold-Space is 550ms → 260ms.** Still unreachable by a tap (a deliberate press
  is ~90–150ms) but no longer reads as lag.
- **Releasing the key closes the peek**, fading out over 190ms. ⚠ Only when the
  hold is what opened it (`_pwPeekOpen`) — an invoice opened with the button must
  survive a stray Space. ⚠ The fade class is added and removed on the **shared**
  `#inv-detail-overlay`, so no other caller's timing changes.

### Round-3 verification
- **158 jsdom assertions** (85 + 73): author/timestamp fields, avatars, initials,
  colour stability, the untruncated thread, the count badge, both panels, and the
  single-tick guard.
- **30 real-browser assertions**, adding: the peek opens, marks itself the opener,
  closes on release, clears its flag, and does **not** close a button-opened
  invoice.
- ⚠ **Revert-checked**: restoring `c.by`/`c.at`, re-truncating the thread and
  putting the emoji back fails **4** cases.
- 15/15 keyboard, 18/18 viewport-layout, 199 `.pw-*` rules, 40 i18n keys with
  real `en` values and no orphans.

### Round 4 — product photos, comment photos, notes into the header (same day)

**كل صور المنتجات كانت مربّعات رمادية.** الشبكة وبطاقات التنقّل كلتاهما كانت تقرأ
`it.imageUrl` وحده — وهي **لقطة وقت البيع**، والحقل أُضيف للـDTO متأخراً فكل سطر
كُتب قبله وصل فارغاً لأن الـwhitelist pipe كان يحذفه بصمت (نفس ما يشرحه
`backfillItemImages`). والنتيجة أن **الشخص الوحيد الذي يعرّف المنتج بصورته لا
باسمه** — من يجهّز الطلب — كان يرى أيقونة بديلة على كل صنف.

`_pwItemImgUrl(it)` يحلّها: اللقطة أولاً، ثم كتالوج المنتجات الحيّ بالـ`productId`
ثم بالـ`code` ثم بالاسم. نفس ترتيب `_movItemProductImg` و`backfillItemImages`، حتى
لا يعرض جدول الحركات ومساحة التحضير صورتين مختلفتين لنفس السطر.

⚠ **اللقطة تسبق الكتالوج ولا تُستبدل به.** لو تغيّرت صورة منتج بعد البيع، الفاتورة
المطبوعة والمسلَّمة للعميل تبقى صادقة؛ الكتالوج يملأ الفراغ فقط.

⚠ **كود `SHOPIFY` نائب ولا يُطابَق.** سطور Shopify تحمله حرفياً، فمطابقته تعني أن
كل سطر Shopify يأخذ صورة أول منتج كوده كذلك. يُتخطّى ويُجرَّب الاسم بدلاً منه.

⚠ **بطاقات التنقّل كانت مصابة بنفس العلّة** — ثلاثة مربّعات رمادية متطابقة على كل
بطاقة، والصورة هي ما يميّز طلباً عن آخر في نظرة سريعة.

⚠ **`productThumbHtml` يقبل `http(s)` فقط** ولا يقبل `data:` رغم أن `sanitizeUrl`
يسمح بها. لم يُغيَّر — 14 موقع نداء يعتمد عليه، وصور المنتجات الحقيقية كلها `http`.
المهم للاختبارات: مُثبِّتة `data:` لن تُرسم.

**صور المعلّقين تعمل من قاعدة البيانات.** `_pwAuthorAvatar` كان صحيحاً بالفعل
(يطابق بالاسم على `users[].avatar`)؛ ما يظهر كأحرف أولى هو **موظف بلا صورة في
حسابه** — وهي النتيجة الصحيحة. ⚠ ولاحظ أن `users` تُملأ من `/users` للأدمن ومن
`/users/mentionable` لغيره، **وكلاهما يُرجع `avatar`** — فلا يوجد مسار يفقد الصورة.

### الملاحظات انتقلت إلى الهيدر كشريحة صغيرة
كانت لوحتين كبيرتين داخل الهيدر تأخذان أكثر من نصف ارتفاعه وتدفعان شبكة الأصناف
تحت الطيّة. **الأصناف هي العمل والملاحظات سياق له**، فالسياق لا يجوز أن يزيح
المهمة. صارت `<details>` بشريحة واحدة تحمل الأيقونة والعدد.

⚠ **ليست إخفاءً للمحتوى.** العدد ظاهر دائماً، و**وجود ملاحظة عميل يلوّن الشريحة
كهرمانياً** (`is-warn`) — «بدون كيس» تعليمة تُفسد الطلب إن فاتت، فوجودها يجب أن
يُرى قبل قرار الفتح. التعليقات الداخلية وحدها تُبقي الشريحة محايدة. المخفيّ هو
النص، لا وجوده.

⚠ **`<details>` أصلية لا لوحة يدوية**: توسيع بالكيبورد وحالة `open` مجاناً، ويقرأها
قارئ الشاشة كعنصر قابل للطي دون أي ARIA إضافي.

⚠ **حدّ الارتفاع على اللوحات لا على الشبكة.** وضعه على `.pw-notes-grid` كان يقطع
آخر تعليق في منتصف سطره — وسطر نصفه ظاهر يُقرأ كعطل لا كقائمة تُمرَّر. الحدّ الآن
على `.pw-cmt-list` و`.pw-note-body`، وهما يمرّران أصلاً.

#### التحقق (Round 4)
- **37 تأكيداً في المتصفح** على الدوال المشحونة: المطابقة بالـid/الكود/الاسم، أسبقية
  اللقطة، تجاهل كود `SHOPIFY`، أن الصور **تُحمَّل فعلاً** (`naturalWidth > 0`) لا أن
  الوسم موجود فقط، صور المعلّقين والأحرف الأولى، والشريحة (مطويّة ابتداءً، العدد
  ظاهر، التلوين الكهرماني، أصغر من اسم العميل، وأن الأصناف تبقى فوق الطيّة).
- ⚠ **مُختبَر بالرجوع**: إعادة القراءة من `it.imageUrl` وحده تُسقط **4** حالات
  وتُرجع **صفر** صورة — وهو بالضبط ما تعرضه لقطة الشاشة المبلَّغ عنها.

### Round 5 — التعليقات مرئية دائماً، وهيدر مكثّف، وحقل إضافة (same day)

**طيّ الملاحظات في الجولة السابقة كان خطأً وأُلغي.** «FAST DELIVERY» و«بدون كيس»
تعليمات تُغيّر ما يفعله المُجهّز، **وتعليمة خلف نقرة هي تعليمة لم تصل**. المشكلة
الحقيقية لم تكن ظهور الملاحظات بل حجمها، فالحلّ تكثيفها لا إخفاؤها.

⚠ **العتبة القديمة «هيدر < 260px» أُبطلت** — وُضعت والملاحظات مخفيّة. الشرط الصحيح
علاقة لا رقم: **الأصناف — وهي العمل — تأخذ مساحة أكبر من الهيدر**، وهذا ما يختبره
`test_prep.js` الآن. القياس بعد التكثيف: هيدر 339px مقابل شبكة 435px.

⚠ **السقف على اللوحات لا على الشبكة** (`.pw-cmt-list` / `.pw-note-body` = 104px).
وضعه على `.pw-notes-grid` كان يقطع آخر تعليق في منتصف سطره، وسطر نصفه ظاهر يُقرأ
كعطل لا كقائمة تُمرَّر.

⚠ **الخيط يفتح على الأحدث.** `_pwRenderWork` و`_pwRefreshThread` كلاهما يضبط
`scrollTop = scrollHeight`: أول ما يُرى عند فتح الطلب يجب أن يكون آخر تعليمة وصلت،
لا أول تعليق كُتب قبل يومين.

### البيانات الثانوية في الهيدر
- **الاسم والهاتف على سطر واحد** (`.pw-cust-idline`) — الهاتف بيان تعريفي يُقرأ مع
  الاسم، وإفراده بسطر كان يكلّف سطراً كاملاً لبيانٍ نادر الاستعمال أثناء التجهيز.
  صار رابط `tel:` بما أنه على الموبايل فعل لا نص.
- **الحالة · الشحن · الموظف صارت سطراً نصّياً بفواصل** (`.pw-cust-meta`) لا شرائح:
  هي **سياق لا قرار**، وحدودُ الشرائح كانت تمنحها ثقلاً يساوي المال والملاحظات.
- ⚠ **ما يحمل مبلغاً يبقى شريحة ملوّنة** (خصم / مدفوع): رقم يُقرأ في لمحة لا يصحّ
  أن يذوب في سطر رمادي.
- ⚠ **`unicode-bidi:isolate` على رقم الهاتف، لا `direction:ltr`** — قلب اتجاه
  العنصر ينقل حافته الأولى للطرف المقابل فيبتعد الرقم عن الاسم الذي يخصّه.

### حقل إضافة التعليق — نفس مسار الفاتورة
`pwAddComment` تكتب بنفس شكل `addInvoiceComment` (`employee` + `timestamp` +
`createdAt`) وعلى نفس النقطة `POST /transactions/:id/comments`، وتستدعي
`processMentionsInComment`. ⚠ **أي اختلاف في الشكل يعني تعليقاً بلا كاتب أو بلا
تاريخ في كل شاشة أخرى تقرأ نفس المصفوفة** — وهو بالضبط عطل `c.by`/`c.at` الموثّق
في الجولة الثالثة، من الاتجاه المعاكس.

⚠ **لوحة التعليقات تُرسم حتى بلا تعليق واحد** — لأنها تحمل حقل الكتابة. إخفاؤها عند
الفراغ يجعل أول تعليق على أي طلب مستحيلاً من هنا.

⚠ **`_pwRefreshThread` لا `_pwRenderWork()`**: الأخيرة تعيد بناء شبكة الأصناف
وتُصفّر تمريرها فتضيع نقطة المُجهّز في طلب طويل — نفس السبب الذي يجعل
`pucoTickOrder` تُرقّع الـDOM. **مُختبَر بالرجوع**: استبدالها يُسقط الحالة.

⚠ **عند فشل الحفظ يُعاد الاستعلام عن الحقل بعد إعادة الرسم.** `_pwRefreshThread`
استبدل `.pw-notes` كاملةً، فالمرجع الملتقط قبلها صار عقدة منفصلة عن المستند —
الكتابة فيه تنجح بصمت ولا تظهر، فيفقد المستخدم نصّه على عطل شبكة. **مُختبَر
بالرجوع**: استعادة المرجع القديم تُسقط الحالة.

⚠ **Enter يُرسل وShift+Enter سطر جديد، و`stopPropagation` إلزامي**: المودال يستمع
لـ↑/↓ والمسافة، وبدونه كل ضغطة أثناء الكتابة تُحرّك الاختيار أو تفتح الفاتورة.

⚠ **`box-sizing:border-box` + `width:auto`**: القاعدة العامة `input,select,textarea
{width:100%;padding:8px 12px}` بلا border-box تجعل الحقل يفيض خارج صفّه ويدفع زر
الإرسال خارج اللوحة. ونفس القاعدة على الموبايل (`min-height:40px`) تُبطل النموّ
التلقائي، فتُلغى صراحةً.

### Round 6 — عمود جانبي للتعليمات، وتأكيد المنشن (same day)

**الملاحظات كانت تمتدّ بعرض الهيدر كاملاً بينما يمين منطقة الأصناف فارغ** — إهدار
مساحة مرّتين: عرضٌ لا تحتاجه أسطر قصيرة، وارتفاعٌ يُقتطع من الأصناف. صار جسم
المساحة `.pw-body2` شبكة عمودين: `.pw-side` للتعليمات و`.pw-items-wrap` للأصناف.

⚠ **الفصل عمودي لا أفقي.** الحدّ بين «ما يُقرأ» و«ما يُجهَّز» صار حدّاً بصرياً
صريحاً بدل شريطين فوق بعضهما يتنازعان الارتفاع نفسه.

⚠ **`minmax(0,…)` على كلا العمودين**: العمود الشبكي الافتراضي `min-width:auto`
فيرفض أن يصغر تحت عرض محتواه، وبطاقة صنف عريضة كانت تدفع الشبكة خارج الحاوية بدل
أن تلتفّ.

⚠ **`.pw-side` يمرّر بنفسه.** لو مرّر الجسم كله لغابت التعليمات فور النزول لأصناف
طلب طويل — وهي المعلومة التي يجب أن تظل أمام العين طوال التجهيز.

⚠ **السقف بالبكسل على الخيط أُزيل** (`flex:1;max-height:none`). كان ضرورةً حين
كانت اللوحة داخل الهيدر؛ في العمود يملأ الخيط ما تبقى ويمرّر داخله، فلا يُدفع حقل
الكتابة خارج الشاشة مهما طال — مُختبَر بخيط من 30 تعليقاً. ملاحظة العميل تبقى
مسقوفة (170px) لأنها قد تكون فقرة كاملة ولا يجوز أن تزيح الخيط.

⚠ **268px للعمود و290px لأدنى بطاقة**، وهما رقم واحد لا رقمان: كل بكسل في العمود
يُقتطع من عرض الأصناف. عند 320px كانت بطاقة واحدة في الصفّ تترك نصف المنطقة
فارغاً؛ 290 تسمح ببطاقتين.

⚠ **تحت 1040px يتحوّل العمودان إلى صفّين** والتعليمات فوق — تُقرأ قبل بدء التجهيز.
عمود 268px داخل نصف شاشة يترك للأصناف عرضاً لا يكفي بطاقة واحدة.

### المنشن — يعمل، وله شرط غير بديهي
`pwAddComment` تستدعي `processMentionsInComment` كما تفعل الفاتورة. مُختبَر: منشن
واحد، عدّة منشنات، صيغة `@Name_With_Underscore`، وتجاهل منشن الذات.

⚠ **الشرط**: `processMentionsInComment` تُغادر صامتةً إن لم يكن الطلب موجوداً في
مصفوفة `transactions`. هو موجود عملياً — طلبات مجموعة التحضير مبيعات تأتي من
`/transactions/pickup-orders` وهي نفسها المحمّلة عند الإقلاع — لكن أي شاشة مستقبلية
تعرض طلباً **ليس** في تلك المصفوفة ستفقد الإشعار بلا خطأ. اختبار يثبّت السلوك.

### Round 7 — ملاحظة محايدة، وقت مختصر، وصورة الكاتب في كل مكان (same day)

**ملاحظة العميل لم تعد صفراء.** كانت `#fffdf5` بحدّ كهرماني وأيقونة كهرمانية —
لونٌ تنبيهي على لوحة تظهر في **كل** طلب، والتنبيه الدائم يتوقّف عن كونه تنبيهاً.
تُميَّز الآن بأيقونتها وعنوانها فقط، وهو فرق كافٍ لأن اللوحتين متجاورتان دائماً
ولا تُقرأ إحداهما بمعزل عن الأخرى.

### الوقت: مختصر، بلغة النظام، أسفل النصّ
كان «08 سبتمبر 2026 · 02:43 م» — 21 حرفاً تزاحم اسم الكاتب على سطر واحد داخل عمود
ضيّق، والسنة تُطبع على تعليق كُتب اليوم.

`_pwWhen` صار تصعيدياً: `الآن · 25 د · 5 س · السبت 20:23 · 30 يوليو · 4 مارس 2024`
(وبالإنجليزية `now · 25m · 5h · Sat 20:23 · 30 Jul`). ⚠ **كل مستوى يظهر فقط حين
يعجز الأدنى عن التمييز** — الساعة تكفي داخل اليوم، واسم اليوم داخل الأسبوع،
والسنة لا تُطبع إلا لسنة أخرى.

⚠ **`-u-nu-latn` إلزامي** — `ar-EG` وحدها تُخرج أرقاماً عربية-هندية، الفخّ المتكرّر
في هذا الملف. و**التاريخ الكامل يبقى في `title`** (`_pwWhenFull`) فلا يضيع.

⚠ **الوقت انتقل أسفل النصّ في نهاية السطر**، لا بجوار الاسم: هو أقلّ المعلومات
أهمية في التعليق فلا يصحّ أن يأخذ نصف السطر الأول، وفي عمود ضيّق كان يُقصّ الاسم
أو يُقصّ هو. `margin-inline-start:auto` + `align-self:flex-end` يتبعان اتجاه
الصفحة — ⚠ لا `right` ولا `left` مثبّتة، و`isolate` لا `direction:ltr`.

### صورة الكاتب — كانت تسقط لنصف المستخدمين
⚠ **`users.find(x => (x.name || x.username) === name)` تفحص حقلاً واحداً**: إن كان
للمستخدم `name` فالـ`username` لا يُقارَن أبداً. والتعليقات تُكتب بـ
`currentUser.name || currentUser.username`، فأي تعليق مخزّن باسم المستخدم لا يطابق
صاحبه ويظهر بأحرف أولى رغم وجود صورته. `_pwFindUser` تفحص القيمتين، بعد
`trim().toLowerCase()` لأن الأسماء تُكتب يدوياً.

⚠ **`onerror="this.remove()"` كانت تترك دائرة ملوّنة فارغة** — أسوأ من الأحرف
الأولى لأنها لا تقول من صاحب التعليق إطلاقاً. الاحتياطي الآن مرسوم تحت الصورة
ويظهر عند فشلها.

⚠ **بطاقة المنشن كانت تعرض أيقونة `@` واحدة لكل المُرسِلين**، بينما بطاقتها
الشقيقة («تعليق جديد على متابعة») في القائمة نفسها تعرض `userAvatarHtml` — بطاقتان
متجاورتان تصفان الحدث نفسه بشكلين. صارت تعرض صورة المُرسِل، **بالبحث بالـid ثم
بالاسم** لأن الإشعارات المخزّنة قبل وجود `fromUserId` لا تحمل id.

#### التحقق (Round 7)
- **31 تأكيداً** في `test_r7.js`: أن اللوحة لم تعد دافئة اللون (فحص RGB لا اسم
  صنف)، الشكل المختصر في اللغتين مع بقاء التاريخ في `title`، موضع الوقت أسفل النصّ
  وفي نهاية السطر وبخطّ أصغر، والصور — بالاسم، باسم المستخدم، بلا صورة، ولكاتب
  مجهول، ومع صورة معطوبة، وفي بطاقة المنشن بالـid وبالاسم.
- ⚠ **مُختبَر بالرجوع**: إعادة المطابقة بحقل واحد وإعادة أيقونة `@` تُسقط **4**
  حالات — أبرزها أن تعليقاً مخزّناً باسم المستخدم يفقد صورته تماماً.

#### التحقق (Round 6)
- **85 تأكيداً** في `test_prep2` (27 جديداً): بنية العمودين، أن الملاحظات غادرت
  الهيدر، أن العمودين يملآن العرض بلا فراغ، أن الأصناف تأخذ النصيب الأكبر، بطاقتان
  في الصفّ، وأن خيطاً من 30 تعليقاً لا يدفع حقل الكتابة خارج الشاشة — على 6 مقاسات
  مع تبديل التكديس تحت 1040px.
- **10 تأكيدات** في `test_mention.js` لمسار المنشن كاملاً.

#### التحقق (Round 5)
- **58 تأكيداً في المتصفح**: أن الملاحظات لم تعد `<details>`، أن كل تعليق يُقرأ بلا
  نقرة، تكثيف الهيدر (سطر واحد للاسم والهاتف، سطر نصّي للسياق، شرائح للمال فقط)،
  ومسار الإضافة كاملاً — الشكل المرسَل، الظهور الفوري، بقاء شبكة الأصناف كما هي،
  التراجع عند الفشل مع إعادة النص، Enter/Shift+Enter، وألّا تصل ضغطات الكتابة إلى
  اختصارات المودال — على 5 مقاسات.
- ⚠ **مُختبَر بالرجوع**: إعادة `_pwRenderWork()` مكان `_pwRefreshThread`، وإعادة
  المرجع القديم للحقل، تُسقط حالتين.

### Still open
- **`backfillItemImages` لم يُشغَّل** — الإصلاح هنا وقت العرض، فالمعاملات القديمة
  لا تزال تحمل `imageUrl` فارغاً في قاعدة البيانات. تشغيله يجعل الفواتير المطبوعة
  (وهي لا تمرّ بهذا الحلّ) تعرض الصور أيضاً.
- **صورة المعلّق تُطابَق بالاسم** — وهو كل ما يخزّنه التعليق. متطابقا الاسم يتشاركان
  الصورة، وتغيير اسم موظف يفصله عن تعليقاته القديمة.
- **The nav list renders every order in the group** — fine at the observed sizes
  (largest real group is a few dozen), but a 500-order group would want
  windowing.
- **`pucoAddOrder` does not select the order it just added**; it lands in the
  list and the picker clicks it.
- **A very long thread scrolls inside a 168px box.** That keeps the items visible,
  but a 40-comment order is a lot of scrolling in a small panel.
- **The hold-Space hint is desktop-only wording.** There is no touch equivalent
  for the peek; the «عرض الفاتورة» button is the touch path.

---

## The Dashboard Opened on a White Page (Sep 8, 2026)

Reported as «الصفحة بتفتح ببطء» on the online build. Three independent defects, measured before anything was written.

### The splash screen was lying
`#splash-screen` faded out on a **fixed CSS timer** — `animation-delay:1.6s` — and its percentage counter was a `requestAnimationFrame` loop counting to 100% over 1500ms. **Neither was connected to the data.** `showApp()` does `await loadAllData()` before rendering anything, so on any network slower than the animation the splash finished, revealed an empty shell, and the user sat on a **white page** with no indication anything was still happening. On a fast connection it looked fine, which is why it survived.

The `animation-delay` is gone. `_bootProgress(pct, step)` / `_bootDone()` are driven by the real load, and `dismissSplash()` is now the only thing that hides it.

⚠ **`minDelay` is a floor, not a cap.** A fast connection would otherwise flash the splash for 200ms — visual noise, not information. A slow load is never cut short; that is the entire point.

⚠ **The bar never moves backwards** (`_bootPct` is a monotonic floor). Progress that retreats reads as something breaking.

⚠ **A 20s safety timeout force-hides it.** An exception anywhere in the boot path before `_bootDone()` would otherwise leave the splash covering the app permanently — trading a slow page for a dead one.

⚠ **`BOOT_REQUEST_COUNT` must match the `Promise.all` in `loadAllData`.** Add or remove a request there without updating it and the bar stalls short of the end or jumps.

### `bostaRawResponse` was 77% of the boot payload
Measured against the real backup: `GET /transactions` is **9.45 MB over 587 rows**, and **7.26 MB of that (77%) is `bostaRawResponse`** — the carrier's raw API response stored whole per shipment — plus 0.49 MB of `bostaStatusIgnoredEvents`.

It is read by **exactly one screen**: the order timeline in `renderInvoiceViewPage` (`tx.bostaRawResponse?.TransitEvents`). The list never touches it, so every user downloaded it on every page load.

`LIST_EXCLUDED_FIELDS` projects both out of `findAll` / `findArchived` / `findPickupOrders`. Verified against the live database: **same 583 rows, 9.45 MB → 1.68 MB (82.2% smaller)**, with exactly those two fields dropped and no other field lost.

⚠ **`findById` is deliberately NOT projected.** The invoice page calls `_ivHydrateFull(id)` on open, which fetches the full record and merges it into the in-memory row. **The render does not await it** — the invoice paints immediately from list data and the timeline fills in when the response lands, guarded by a check that the user is still on that invoice so a late reply can't paint over a different one. `_fullyHydrated` marks the row so reopening costs no second request.

⚠ **Any screen needing these fields must go through `GET /transactions/:id`.** Do not "fix" a missing field by deleting the projection.

### Two awaits blocked the first paint for no reason
`await syncUsersStatus()` in `showApp` and `await refreshMentionsFromServer()` in `loadAllData` each added a full round-trip **before the first page render**. Neither result is needed to draw a page — one fills a presence strip the socket takes over anyway, the other a header badge. Both now run detached, with `buildNotifications()` called again when the mentions reply arrives.

### The loading state is now a skeleton, never a sentence
«جاري تحميل المستخدمين...» read as a stuck state and collapsed to nothing when the avatars arrived. Replaced by shaped skeletons, and data arrives through `revealData(el, {stagger:true})` — a 340ms rise that plays across children in sequence so a table reads as *being built* rather than snapping into place.

⚠ **Only `transform` and `opacity` are animated** — the two properties the compositor handles without re-layout. Anything animating `height`/`width`/`top` stutters on a table of hundreds of rows.

⚠ **`will-change` is cleared on `animationend`.** Left on hundreds of rows it holds a GPU layer per row and costs more memory than it saves.

⚠ **`prefers-reduced-motion` is honoured and is not optional.** Animation is disabled and content stays **visible** (`opacity:1`) — a reduced-motion rule that only removes the animation while leaving the `from` state would hide the data permanently. `countUp` writes the final value directly. Verified in a reduced-motion browser context.

### زر «آخر تحديث» — `refreshBtnHtml(page)` / `refreshPageData(page)`
Refetches the current page's data and shows when it last succeeded.

⚠ **It must never call `location.reload()`.** `index.html` is served `no-store` (see "Forced Update on Deploy"), so a reload re-downloads the whole ~4.5MB shell and discards filters, sort and page state. It refetches data and re-renders.

⚠ **The timestamp lives in memory, not `localStorage`.** "Last update" is a question about this session; persisted, a freshly-opened tab would claim «منذ ٣ دقائق».

⚠ `is-busy` sets `pointer-events:none` — verified that **5 rapid clicks fire exactly one fetch**. `finally` always clears it, so a failure can't leave the button stuck.

⚠ One shared interval refreshes the label, not one per button — per-button timers keep running after their button leaves the DOM.

### Verification
- Backend: **819/820 tests pass** (the one failure is in `staff-dashboard.spec.ts`, untracked pre-existing work — it fails **15** tests without these changes and 1 with them). A new case locks the projection: the list excludes the fields *and* `findById` does not.
- `node dist/main.js` → *Nest application successfully started* — per the nullable-`@Prop` rule, `nest build` alone does not prove a service change resolves.
- Browser-verified (Playwright, served over HTTP since `API_BASE` is relative): with data held open, the splash **stays visible at 12% showing «جارٍ التجهيز…» through 5 seconds** where the old build faded at 1.6s; with staggered responses the bar climbs 16→25→34→47→56→65→74→100%. Console errors compared against `HEAD`: **no new errors** once the mock returns correctly-shaped `duty-board` data.

### Still open
- **`/transactions` is still fetched whole** and paginated client-side, though now at 1.68 MB rather than 9.45 MB. The backend already supports `page`/`limit`; this remains the growth ceiling.
- **`renderDutyBoard` assumes `onDuty`/`nextUp`/`onLeave` are arrays** and throws on a malformed response. Pre-existing, not touched here.
- The reveal animation is wired into the dashboard only; other pages still snap in.

---

## Shopify Webhooks — Four of Six Were Thrown Away (Aug 28, 2026)

Six webhooks are registered in Shopify. `shopify.controller.ts` handled **two**. The other four
(`orders/edited`, `orders/cancelled`, `fulfillments/create`, `fulfillments/update`) arrived, passed
HMAC verification, and fell through to `return { received: true }` — **200 OK, so Shopify never
retried and nothing recorded the drop.** Same class as the `catch (_) {}` failures above.

Measured from the local log before building anything: **92 `orders/updated` against 24
`orders/create`** — ~4 updates per order. `handleOrderUpdate` is the hottest path in the module,
not an edge case. Zero of the other four appear, but that log stops in July on a machine with no
Docker, so it is not evidence of absence — hence the unhandled-topic `logger.warn`.

### The one rule all four fixes follow
**Record the event; never derive the financial decision from it.** A confirmed order has a
transaction behind it: stock deducted, vault moved, possibly a Bosta shipment. Reversing that runs
through `performCancellation`. A webhook must not trigger it.

### The address was overwritten on a shipped order
`handleOrderUpdate` wrote `shippingAddress` with no guard, **including onto a transaction already
handed to Bosta** — and `updateOne` pushed it to the invoice too. The system then displayed one
address while the parcel travelled to another, with nothing on screen showing the divergence.

⚠ **Bosta has no endpoint to edit a live shipment** — only `POST /deliveries` and
`PUT /deliveries/:id/terminate`. Auto-forwarding the new address is impossible, and attempting it
fails silently while implying the problem was handled. So: **before shipping → update; after
shipping → keep the shipped address and record `addressChangeConflict`.**

`bostaShippedAddress` freezes what Bosta actually received, set in `createOrder` beside
`bostaOriginalCod`. **Without it there is no way to detect a divergence at all.**

⚠ **The ShopifyOrder record still tracks Shopify.** The order row and the transaction diverging is
exactly what makes the conflict displayable instead of erased. Don't "fix" that into agreement.

### Items and totals are frozen after confirmation
The deposit was already frozen post-confirmation; `items`/`total`/`shipCost` were not — so a
confirmed order's stored value drifted from the transaction its stock and vault entries were built
on. (The transaction itself was never updated, so invoices were safe; the defect was the silent
disagreement.) Now `valueChangeConflict`, on the same rule as the deposit.

⚠ **`orders/edited` is a different topic from `orders/updated`.** It fires for the official Edit
order flow (add/remove line, change qty) and was never handled — so item edits reached nothing.
It routes to the same handler, which freezes rather than silently rewrites.

### Cancellation splits by whether a transaction exists
- No transaction → nothing moved; cancel directly, `cancelledBy: 'Shopify'`.
- Live transaction → **`shopifyCancelConflict`, and nothing is cancelled.** `shipped` is captured
  at detection because it changes the required action: a parcel already out must be stopped at
  Bosta first.

`SHOPIFY_CANCELLED_CODE` is a real code so "cancelled on Shopify" stays countable in the
cancellations report rather than blending into manual cancellations. It carries `systemOnly: true`:
filtered out of `cancelReasonsFor()` and **rejected by `resolveShopifyCancelReason`** — otherwise a
staff member could label their own manual cancellation as a Shopify one and corrupt the very count
the code exists for.

### Fulfillment webhooks are mostly our own echo
⚠ **`BostaService.createOrder` calls `shopifyAdmin.fulfillOrder` on success**, so the event bounces
straight back. Acting on it indiscriminately is a loop. `handleFulfillment` compares the tracking
number against `bostaTrackingNumber`/`bostaOrderId` and **writes nothing unless the shipment is
genuinely foreign** — created from the Shopify dashboard, outside the system's tracking.

⚠ **The tracking-number check is load-bearing on its own.** If the webhook wins a race against the
`bostaOrderId` write, a `bostaOrderId`-only check flags our own shipment as external — a false
alarm on every order shipped. A test locks this.

### Resolution is a human acknowledgement
`resolveShopifyConflict(id, kind, by)` — `address | cancel | fulfillment`. It sets `resolved` and
nothing else: **no address is edited, no transaction cancelled.** The system cannot know whether
someone phoned Bosta. A fresh conflict reopens the flag, because a second change is its own event.

⚠ Every handler is try/catch and **never throws** — an error makes Shopify retry and then disable
the webhook entirely.

### Verification
- 20 cases across `shopify-address-conflict.service.spec.ts` and `shopify-webhooks.service.spec.ts`.
- **Each fix was reverted and the tests confirmed to fail** (2, then 1 for the tracking-only echo),
  then restored — the `returns.spec.ts` trap is passing tests that never exercise the real code.
- ⚠ Both specs need **`export {}`**: same-named top-level helpers in two spec files collide as
  `TS2393` and neither suite runs.
- Full suite **672 tests / 35 suites** (was 652/33); `node dist/main.js` → *Nest application
  successfully started* — three new `@Prop`s, and `nest build` alone does not prove that.

### Still open
- **`fixCorruptedStatuses` and the pre-fix rows are untouched** — this is additive, no backfill.
- **The conflict banners are invoice-page only.** A manager who never opens the invoice sees
  nothing; routing them into الإشعارات (the assigned employee is already on the order) is the
  obvious next step.
- **No `orders/delete` or `refunds/create` handler** — neither is registered in Shopify today.

---

## Backup Lost Every Employee Account, and There Was No Auto-Backup (Aug 28, 2026)

Two independent defects in the same system.

### `users` was captured and then thrown away
`BACKUP_COLLECTIONS` has always included `users`, and a real backup file holds all 6 accounts with their `role`, `perms` and `jobTitle`. But **both** restore paths dropped them:
- `restoreBackup` step 1 filtered `users` out of the wipe list, and step 2 `continue`d past it.
- `SECTION_COLLECTIONS` had no entry for it, so selective restore could not reach it either.

So a restore onto a clean database produced the full transaction history with **no employee accounts at all** — and 470 `employeeperformancelogs` rows whose `employeeId` resolved to nobody, so the Performance Hub came back empty even though its data had been captured perfectly. The original comment («never restored — restoring it would clobber current accounts/passwords») described a real risk; the fix is to merge rather than to skip.

### `restoreUsersMerge` — the three rules that make it safe on a live system
Matched on **`username`**, not `_id`: that is what login and every `findByUsername` use, and it carries the unique index. Matching on `_id` alone would insert a duplicate for a user whose id differs between databases, and the unique index would then reject it — silently losing that employee.

1. **An account absent from the backup is left alone, never deleted.** Someone hired after the backup must not lose their login because last week's data was restored — and that could be the admin running the restore.
2. **Credentials are only written when CREATING an account.** `password`/`plainPassword`/`totpSecret` are never overwritten on an existing one: a restore is not a password reset, and reverting one hands back a credential the user believes is retired.
3. **Security state is never restored** (`loginAttempts`, `lockedAt`, `trustedDevices`, `lastLogin`) — it describes this machine's live session history, so writing a month-old lockout over it would either resurrect a lifted lock or clear a current one.

What *is* restored is identity and authorisation — name, role, perms, jobTitle, phone, avatar, isActive — which is exactly what was missing. On insert the backup's own `_id` is preserved: `employeeperformancelogs.employeeId` and `shopifyorders.assignedTo` store `User._id` **as a string**, so a regenerated id would orphan every point and assignment belonging to that person.

⚠ **The selective path needed the same guard.** It does `deleteMany({})` then `insertMany`, which on the accounts table would log everyone out for the duration and permanently if the insert failed. `col === 'users'` routes to the merge there too. **Any new restore path must do the same — `users` must never be `deleteMany`'d.**

⚠ `users` stays **out of `ALLOWED_COLLECTIONS`**: restoring is safe only because it merges, and clear-data has no merge path.

⚠ `migrateDoc('users')` defaulted **`active`** — a field the schema does not have (it is `isActive`). A backup predating the field restored an account every `isActive` check then read as inactive.

### There was no automatic backup at all
`ScheduleModule` was running three other crons; nothing scheduled a backup. A backup happened only when a human opened Settings and pressed the button, so a quiet week left no recovery point.

`@Cron('0 0 3 * * *', {name:'nightly-backup'})` — 03:00, outside working hours and an hour clear of the 07:00 order-audit cron so the two never contend for the database. It never throws: a scheduler that dies takes every later run with it.

### Pruning: `backup_auto_` is a filename prefix, not just a flag
`AUTO_BACKUP_KEEP = 10`. ⚠ **Only scheduler-created files are ever deleted.** A manual backup is usually taken deliberately right before something risky — rotating one away would destroy exactly the file the user wanted — and `resetSelectiveData`'s pre-wipe safety backup is manual for the same reason. The marker lives in the **filename** so the distinction survives a lost or hand-edited `registry.json`; the registry's `auto` flag is only a secondary signal.

Pruning is wrapped in try/catch: it is housekeeping, and its failure must not invalidate the backup just taken.

`getBackupList()` now filters to files that actually exist on disk — the registry is an index, not the truth, and a pruned or hand-deleted row was previously offered as restorable and failed only once picked.

### Tests
`settings-backup-coverage.spec.ts` asserted `expect(sectionCols).not.toContain('users')` — it was locking in the bug. Replaced by three cases: users must be backed up *and* sectioned; users must never be in `ALLOWED_COLLECTIONS`; and users must share a section with `employeeperformancelogs`/`employeeshifts`, since restoring points without the accounts they belong to yields a leaderboard of unreadable ids.

**Pre-existing, not caused by this and not fixed here:** 230 of the 470 performance-log rows belong to 4 deleted accounts. `getDashboardStats` only lists users who have a shift, so they never surfaced; the points remain in the append-only log.

---

## The Date-Window Bug — `date-window.util.ts` (Aug 28, 2026)

Found by the KPI drill-down's proof line on its very first run: June 2026 reported purchases of **22,860** against a true **61,300**. One invoice (ref `010`, **38,440**, dated 30 June) was invisible to the report.

### `date` is not reliably `YYYY-MM-DD`
It is written from whatever the client sends. `VaultService.addEntry` was `dto.date || new Date().toISOString().split('T')[0]` — **the fallback is truncated, the caller's value was stored verbatim** — and `TransactionsService.create` did `create({ ...dto, ...carrier })`, spreading the client's `date` straight through. So real data is mixed:

| Collection | ISO-timestamped |
|---|---|
| `transactions.date` | **326 / 521 (63%)** |
| `vaultentries.date` | 10 / 766 (every one a **manual** `MAN-*` entry) |
| `supplierledgerentries.date` | 5 / 19 |
| `expenses.date`, `supplierreturnorders.returnDate` | 0 (clean) |

### Both JS `<=` and Mongo `$lte` compare strings bytewise
```
'2026-06-30T00:39:12.745Z' <= '2026-06-30'   →   FALSE
```
The timestamped string is *longer*, so it sorts **after** the bare date. **The last day of every period silently dropped every timestamped row on it.** It reads as missing data rather than a date bug — the totals stay self-consistent and nothing looks broken, which is why it survived.

⚠ **The frontend was already correct.** `index.html` filters with `tx.date.slice(0, 10) < from` (and the same for expenses), so before this the two layers *disagreed*: صفحة الحركات and صفحة التقارير could list different transactions for the same month. The backend was the outlier — which is what makes this a correction, not a behaviour change.

### Two helpers, because half the callers are Mongo
`inDateWindow(value, from, to)` truncates and compares — for JS filtering.

`dateWindowQuery(from, to)` is for Mongo, which cannot truncate a stored field in a plain `find`. It widens the **bound** instead: `$lte` becomes **`to + '￿'`**, which sorts after every possible time suffix on that day but before the next day.

⚠ **Never "simplify" that back to a bare `$lte: to`** — that is the bug. A test asserts the two forms agree on all ten boundary probes; if they diverge, JS-filtered and Mongo-filtered reports scope different periods.

`normalizeDateOnly` is the write-side companion, applied in `VaultService.addEntry` and `TransactionsService.create` so **new** rows stop joining the mixed state. **Not a migration** — existing rows keep their format and both helpers accept either.

### Six read sites + two bucketing defects
`getReports` (JS) · both expense filters in `transactions.controller.ts` (JS — two byte-identical copies) · `getSettledSupplierReturns` (Mongo) · `VaultService.findAll` (Mongo — the main vault log) · vault analytics current+previous windows · vault cashflow.

Two **separate** defects in the same area, found while fixing the queries — including the row would have still lost it downstream:
- `getCashflow` keyed `dailyByDate[e.date]` on the **raw** date, so a timestamped entry got its own bucket that no day key ever matches — the amount vanished from the chart.
- `getAnalytics` did the same, which inflated `daysWithEntries` (the divisor for `dailyAverage`) and could print a raw ISO string as the `bestDay`/`worstDay` label.

Both now bucket on `dateOnly(e.date)`.

⚠ **`getDashboard` has no date window at all** (it is all-time), so it was never affected. Don't "fix" it.

### Measured purely additive — this is what made it safe to ship
Across all 12 months of 2026 against the real backup: **adds 1 row, removes 0.** It can only restore rows that were being dropped; it can never exclude one that used to count. June purchases went 22,860 → **61,300**; May, July and August are byte-identical.

Verified by 20 cases in `test/unit/date-window.spec.ts` (the June regression first), 34 assertions against the compiled helper over real backup data, and the full suite: **578 tests, 29 suites, all passing.** `node dist/main.js` confirms *Nest application successfully started* — per the nullable-`@Prop` rule, `nest build` alone does not prove this.

### Still open
The **historical rows are not migrated** — 341 of them still hold timestamps. Reads are correct either way now, so this is cosmetic rather than a correctness issue, but a one-off normalising script would let the helpers eventually retire. `supplierledgerentries.date` (5 rows) has **no** date-window reader today; if one is added, it must use these helpers.

---

## KPI Drill-Down — «الرقم ده جاي منين؟» (Aug 28, 2026)

Three KPI cards in التقارير (المصاريف / المشتريات / المرتجعات) now open the rows that produced their number. Before this, a card asserted `142,743` with no way to verify it: checking meant opening صفحة المصاريف, re-filtering by hand, summing, and then getting a **different** figure — because the card counts `معتمد` only and nothing on screen said so. **The click is the evidence, not a convenience.**

### The list must equal the card — that constraint drives everything
A drill-down that shows a total different from the number clicked is worse than none: it discredits both figures instead of explaining one. So every list ends with a **proof line** stating the row sum and whether it matches. The tolerance is 0.5 (decimal accumulation), and a mismatch renders red rather than being hidden.

### No new endpoint — and the cost of that
`transactions` / `expenses` / `returnRequests` / `supplierReturns` are all in memory from `loadAllData`, so the panel opens with **zero requests**. The price is that the filter rules are a **hand-kept mirror** of the backend's — same convention as `getRetRefundCeiling` and `CANCEL_REASONS`. Changing a rule in `getReports` (or the expense filter in `transactions.controller.ts`) without changing `_rd*Rows` desyncs the list from the card, and the proof line is what makes that visible.

### ⚠ Each card dates its rows by a different field. This is not an oversight.
| Card | Source | Date field |
|---|---|---|
| المصاريف | `expenses`, `status==='معتمد'` | `date` |
| المشتريات | `transactions` type مشتريات | `date` |
| … minus | `supplierReturns` مكتمل, `!reversal` | `returnDate` |
| المرتجعات | `returnRequests` معتمد, `!reversedAt` | **`createdAt`** |

`_rdReturnInPeriod` is separate from `_rdInPeriod` because the backend compares `createdAt` as a **`Date` against UTC bounds**, while transactions/expenses are compared as **raw strings**. Using one helper for both makes the rows stop matching the card.

### ⚠ It surfaced a real backend bug — since fixed
The proof line failed on its first run against June 2026. Cause: **63% of transactions (326/521) store `date` as a full ISO timestamp**, and raw-string compare made `'2026-06-30T00:39:12.745Z' <= '2026-06-30'` **false**, dropping the last day of every period. See **The Date-Window Bug** below for the fix.

`_rdInPeriod` now compares on the **day** (first 10 chars), matching the corrected backend. **The two must always move together** — that is exactly what the proof line detects.

### The panel
`openRepKpiDrill(key)` → header (the figure, period, row count) → **the rule, stated in words** → search → sortable table → proof line + pagination. Reuses the shared `renderPagination()` and the `.cxr-tbl` conventions.

- **المشتريات renders two groups** — الفواتير (+) and مرتجعات الموردين (−). The KPI is a *net* figure; showing one merged list makes the sum come out below the visible invoices with nothing explaining the gap.
- **Supplier-return value comes from `SupplierReturnOrder.total`, not the مرتجع مشتريات transaction** — that one is created with `total = refundAmount` only, so a return settled as debt-offset or credit has total 0 and would deduct nothing. Same reasoning as `getSettledSupplierReturns`.
- **A row opens its document and closes the panel** (`openOrderView`, which already handles the masked-purchase case for non-admins). Expense rows are **not** clickable: `openExpenseModal` refuses approved expenses, and every row here is approved by definition.
- **Return rows open `returnTxId`** — the transaction created at approval. An approved return has no standalone page.
- ⚠ **The ⓘ button carries `event.stopPropagation()`** — without it a click opens both dialogs.
- ⚠ **`_rdRenderTable()` redraws only `<thead>`/`<tbody>`/pager.** Re-rendering the card per keystroke blurs the search box. Same rule as `_cxrRenderTable`.
- ⚠ **Sorting runs on `.slice()`** — sorting `_rdRows` in place would permanently reorder the array the proof line reads from.
- ⚠ **Column order is duplicated** between the `<thead>` literal and the row template; reordering one alone shifts every column under the wrong header.
- ⚠ **`closeModal()` calls `_rdRelease()`.** Backdrop and ESC bypass `closeRepKpiDrill()`, so clearing state only there would retain hundreds of records. `_rdRelease` must **not** call `closeModal` — that direction is the recursion.
- Filtered-to-zero and no-rows are **distinct** empty states, per the `LOAD_FAIL` three-state rule.
- Cards are `role="button"` + `tabindex="0"` with Enter/Space; the affordance is a chevron at `.35` opacity, not a colour — it sits beside eleven non-drillable siblings.

### Only three cards, deliberately
The other nine (متوسط الفاتورة, الربح الصافي, …) are **derived from formulas, not backed by rows** — a list behind them would be meaningless. `REP_DRILL_KPIS` is the gate; adding a card there without a `REP_DRILL_META` entry renders a clickable card that opens nothing.

### Verification
Not spot-checked — the shipped `_rd*Rows` functions were extracted from `index.html` and run against real backup data across **18 periods (54 comparisons), all matching** the backend's own transcribed rules, plus 25 jsdom assertions covering render, search, sort, paging, row-click and state release. This is how the June discrepancy above was found.

---

## Carrier Registry — `CARRIERS` (Aug 28, 2026)

The shipping company was a **free-text name** (`tx.shipCo`) copied out of `settings.shipCos[].name`, and the three paths that create a sale disagreed completely:

| Path | Carrier | Tariff |
|---|---|---|
| سجل المعاملات (manual) | **required**, a name | read from settings, written as a bare number |
| `ShopifyService.approveOrder` | **never written at all** | `shipping_lines[0].price` — what the *customer* paid |
| `BostaService.createOrder` | **never read or written** | — |

So an order labelled «Mylerz» could be shipped through Bosta and nothing anywhere disagreed; and every confirmed Shopify sale carried no company, while the manual form refused to save without one.

### The reports were already written and starved of data
`order-audit.service.ts` **already** grouped shipping cost per company and reported the highest-shipping order. That code worked; its input was empty. Shopify is most of the volume, so the per-company breakdown was almost entirely one «غير محدد» row. ⚠ **Fixing the data fixed the panel — no new report was written.**

### `backend/src/shared/carriers.constants.ts` is the single source of truth
⚠ **`code` is the stored value** (`tx.carrierCode`) — it lands in Mongo, the shipping breakdown and the archive export. **Never rename one**; add a new code and leave the old one so historical rows keep resolving. `ar`/`en` are display-only. Same split as `CANCEL_REASONS`, `PRODUCT_COLORS.name` and `JOB_TITLE_GROUPS`.

⚠ **`index.html` carries a hand-kept mirror** (`CARRIERS` + helpers, just above `RET_VAULT_SEGMENTS`). The backend validates every submitted code against **its own** copy.

**`integration: 'bosta' | 'none'` is what makes the system aware of a *connected* carrier.** It decides whether the «إرسال إلى Bosta» action exists — **not** whether the carrier may be selected. A carrier with `'none'` is fully usable for recording and reporting; it is simply handed over manually. Adding a second integrated carrier means adding its code plus its own send path; **no existing branch changes.** This is what makes the system multi-carrier rather than Bosta-with-extras.

### `resolveCarrierForWrite` is the only place a carrier is resolved
In `TransactionsService`, called by both `create()` and `update()`. Its rules:
- **Only sales carry a carrier.** A purchase has no outbound shipment, and one would put supplier invoices into the shipping report.
- **An unknown *code* is rejected, an unknown *name* is not.** A rejected save leaves the operator on screen to fix it; dropping it files the shipment under «غير محدد» with nobody aware. But a legacy free-text name is data we cannot reject — it keeps `carrierCode: ''` and is bucketed as unspecified.
- **`shipCo` is DERIVED and still written.** Every consumer that renders it verbatim (invoice view, pickup prep group, archive export) keeps working untouched, so **no backfill is required**.

⚠ **`update()` re-freezes the tariff**, falling back to the stored values for fields absent from the DTO — an unrelated edit (e.g. the client name) must leave the shipping record exactly as it was.

### `shipTariff` — why the price is frozen on the transaction
`shipCost` alone is a bare number with no explanation: editing a carrier's price in Settings left old invoices at the old figure and new ones at the new one, with **nothing recording that a rate change had happened**. Two invoices, same carrier, same zone, different cost, and no answer to "why".

`source` is the load-bearing field: `'settings'` (the configured tariff) · `'manual'` (an operator override — **visible in reports instead of hidden**) · `'shopify'` (what the *customer* was charged, which is a different quantity from what the carrier costs us).

⚠ `@Prop({ type: Object })` is mandatory — an object `@Prop` without it throws `CannotDetermineTypeError` at module load and takes the whole API down.

### The picker is shown before sending, with a default pre-selected
`settings.defaultCarrierCode` pre-selects, so the ordinary single-carrier case stays **one click** while a second carrier is one click away. The picker is **always rendered** — the default decides only what starts selected, never that the question is skipped.

- It shows **each carrier's tariff for this order's zone**, so the operator sees the cost *before* confirming. Same "state the impact before the click" rule as the cancellation dialogs.
- ⚠ `cityToShipZoneFront()` mirrors the backend's `cityToShipZone` — **keep the two in agreement**, or the operator is quoted one figure and the invoice records another.
- ⚠ `.cpk-opt input` is `position:absolute;opacity:0`, not a bare radio — see [[global_input_width_breaks_radios]].
- **Bulk send takes one carrier for the whole batch, and the dialog says so.** Read **before** the button is disabled, so a rejected pick leaves the dialog open. Same rules as bulk cancel.
- A settings row whose name matches no registry entry is **not offered** in the pickers (the backend would reject it) and is marked «غير معروفة» in the settings table instead of silently failing at save.

### Where the shipping price comes from — two sources, never mixed
The confirm dialog showed **«Shipping EGP 120»** in the summary (from Shopify) while the carrier tiles below offered **145 / 135** (from the Settings tariff) — none of which would ever be written. Two numbers on one screen and nothing saying which wins.

| Entry path | The price is | Behaviour |
|---|---|---|
| **Manual** (سجل المعاملات) | the carrier's tariff in Settings for the selected zone | **per-carrier** — changes as you pick, because that figure *is* what gets charged |
| **Shopify** | `shipping_lines[0].price` — what the customer already paid at checkout | **fixed** — identical for every carrier; `approveOrder` writes `order.shipCost` through untouched |

`_carrierPickerHtml(idp, code, zone, priceOpts)` takes `fixedPrice` (Shopify: one true figure on every tile) or `hidePrice` (bulk: each order keeps its own amount, so any single figure would be wrong for most rows), plus a `priceNote` naming the source. **Never render per-carrier settings tariffs on a Shopify order** — no tariff replaces what the customer already paid.

⚠ **`priceOrigin` on `resolveCarrierForWrite` exists for the edit path.** A Shopify amount is not drawn from any tariff, so comparing it against one is meaningless — without the override, editing an unrelated field (the client's name) re-ran the check, found 120 ≠ 110, and relabelled `shipTariff.source` as `'manual'`: **fabricating an operator override that never happened** and corrupting the one signal reports use to spot genuine off-tariff pricing. Scoped to `tx.source === 'shopify'`, so a manual sale still reports a real override. 4 cases in `transactions.service.spec.ts`.

### `shipRowPrice` — one resolver, and why `??` is load-bearing
`getShipCost` (new transaction) and `updateEditShipCost` (edit modal) each carried their own copy of:

```js
co.cairo || co.cairoPrice || settings.cairoPrice || 0
```

⚠ **`||` treats 0 as "missing"**, so a carrier deliberately priced at **0** — free shipping, or customer pickup — silently inherited the global default and **charged for a shipment that was free**. A configured 0 is a real tariff. Both now call `shipRowPrice(co, zone)`, which uses `??` at every step, so the two can no longer drift. Same falsy class as the `t()` empty-string trap.

### Deliberately additive
`carrierCode` defaults to `''` on every pre-existing row, and reports bucket those under `LEGACY_CARRIER_CODE` («غير محدد») rather than dropping them — **so shipping totals always equal what actually shipped**, and a shrinking «غير محدد» bucket is the adoption metric. `SettingsService.getSettings()` backfills `shipCos[].code` and `defaultCarrierCode` from the legacy names on read.

⚠ `ShopifyModule` now imports **`SettingsModule`** (not `forwardRef` — Settings does not depend on Shopify, so this adds no cycle). `nest build` does not prove this resolves; **only `node dist/main.js` does.** Verified: *Nest application successfully started*.

### Still open (measured, not fixed)
- **`shipCost` still conflates two quantities**: what the customer was charged (Shopify) and what the carrier costs us (manual). `shipTariff.source` now records *which* it is, so the split into `shipCharged` vs `shipCost` is the next step and is no longer blind.
- **`actualShipCost` is read but never written on the sales path.** `order-audit`'s `shipCostOf` prefers it, so that branch is always false and the report measures the estimated tariff while calling it actual.
- **`cityToShipZone` is still Cairo/Giza vs everything else**, while the city picker stores a precise `shippingBostaCity`. Finer zones are possible; changing the zone keys would invalidate every stored `shipZone`, so they must be added, never renamed.
- **Bosta still does not check `carrierCode`.** Gating the send on `integration === 'bosta'` (and stamping the carrier on success) is stage 5.

---

## Structured Cancellations — `CANCEL_REASONS` (Aug 28, 2026)

There are **two** ways an order dies, they had nothing in common, and neither could be counted:

| Path | Where | Reason field | Was |
|---|---|---|---|
| `shopify` | صفحة شوبيفاي, order still `pending` | `cancelReason` | free text, **optional**, usually empty |
| `transaction` | سجل المعاملات (direct admin, or request→approve) | `cancelReason` | free text, required, unconstrained |
| `transaction` (bulk) | شريط التحديد في الحركات → «إلغاء» | `cancelReason` | a bare `showPrompt` — no list at all |

Free text on both sides means «العميل غير مستجيب», «عميل مش راد» and «لا يرد» are **three rows** in any report that groups by reason — so the question "why do we lose orders?" had no answer at all. The reason is now a **code**; the Arabic label is derived at render.

### The stage is the expensive part, not the count
The two paths cost different amounts, so they are counted separately and never merged into one number:
- **`shopify`** — nothing moved. No stock deducted, no vault entry, no invoice. The cost is the lost sale.
- **`transaction`** — `performCancellation` had to *reverse* real effects: refund the deposit out of (or back into) the vault, write reversing inventory movements, and unwind the supplier payable.

A rising `transaction` share means orders are being caught **too late**, which is the one operational reading this panel exists to give. `cancelStage` is stored on the transaction for exactly this.

### `backend/src/shared/cancellation.constants.ts` is the single source of truth
18 reasons in 5 groups. Each carries `stages: ['shopify'|'transaction']` — **a reason is not valid everywhere**: `test-order` is shopify-only (by the time it is a transaction it has moved cash, and calling that a test files a real loss as noise), while `delivery-failed` / `data-entry-error` / `supplier-cancelled` are transaction-only. The service validates the code *against the stage*, not just against the list.

⚠ **`code` is the stored value** — it lands in Mongo, the reports breakdown and the archive export. **Never rename one**; add a new code and leave the old one in the list so historical rows keep resolving to a label. `ar`/`en` are display-only. Same split as `PRODUCT_COLORS.name` / `JOB_TITLE_GROUPS`.

⚠ **`index.html` carries a hand-kept mirror of the list** (`CANCEL_REASONS` / `CANCEL_REASON_GROUPS`, just under `RET_VAULT_SEGMENTS`). The backend validates every submitted code against **its own** copy, so a code added on one side only is either un-choosable or rejected at save with «سبب الإلغاء غير معروف». Same convention as the global-search scorers and `getRetRefundCeiling`.

### Additive, not a migration — this is what makes it deployable
`cancelReason` (the free-text field) is **still written**, now DERIVED via `cancelReasonSummary(code, note)` → `«الصنف غير متوفر — الفرع أغلق»`. Every existing consumer that renders it verbatim — the invoice view, the archive export, the vault note — keeps working untouched, and **no backfill is required**. The new `cancelReasonCode` / `cancelReasonNote` / `cancelStage` sit alongside it.

A caller that sends **only free text still works** and lands with an empty code; the report buckets those under `LEGACY_CANCEL_REASON_CODE` («غير محدد») rather than dropping them, **so the reason totals always equal the number of cancellations that actually happened**. A shrinking «غير محدد» bucket is also the adoption metric. Internal callers that pass only prose (the failed-delivery close-out, `performCancellation`'s COD path) were deliberately left alone for this reason.

### The reason must survive approval
`requestCancel` validates **at submission**, not at approval — a bad reason must be rejected while the requester is still on screen to fix it — and stores the code on `cancelRequest`. `approveCancel` then carries it through to `performCancellation`. **The approver decides *whether*, not *why*.** Dropping the code here would send every request→approve cancellation to «غير محدد» and turn the report into a measure of which path was used rather than of what went wrong.

### `other` requires a note
An «سبب آخر» with no detail is precisely the unusable row this system exists to stop, so it is the one code where the note is mandatory — enforced on **both** layers, and inline at the field rather than as a toast (the dialog is what the user is looking at).

### The dialogs now state the impact *before* the click
`cancelImpactHtml(tx)` mirrors `performCancellation`: it names the vault movement, the stock reversal and the removal from reports. Two rules it follows:
- **Only the `deposit` moves.** The unpaid remainder was never collected, so it must not be shown as if it were — the same lesson as the `payStatus`-vs-cash incident above.
- ⚠ **Every amount is wrapped in `<bdi>`.** `fmtJ` emits a Latin run inside Arabic prose; without isolation the sign attaches to the currency. Never "fix" that by reordering the string.

The Shopify dialog's message was «سيُستبعد من الإحصائيات», which understated it in one direction and overstated it in another; it now says plainly that nothing touched stock or the vault and the order can be restored.

`_shopifyActionModal` gained an opt-in **`reasonStage`** — it renders the structured picker and hands `onConfirm` a `{code, note}` object instead of a string. The legacy `showReason` free-text path is untouched, because that modal is shared with non-cancellation actions on the same page. Validation runs **before** the button is disabled and the modal removed, so a rejected pick leaves the dialog open with its error rather than vanishing having done nothing.

### Who may cancel a Shopify order — `shopify-cancel` / `shopify-cancel-request`
Cancelling a pending Shopify order was `@Roles('admin')` on both layers, so it could not be delegated at all: either someone held the admin account or nobody could cancel. Now two perms, and they are **different levels of authority, not two names for one**:

| Perm | What the click does |
|---|---|
| `shopify-cancel` | Cancels immediately. The order is gone. |
| `shopify-cancel-request` | Files a request. A manager decides in الموافقات. |

`canCancelShopifyOrder()` wins when a user somehow holds both — the stronger authority already contains the weaker, and routing such a user through approvals would send a manager a request they could have skipped. `shopifyCancelMenuLabel()` switches the menu text accordingly: **«إلغاء الأوردر» on a button that only files a request is the wording that makes staff believe an order is cancelled when it is still live.**

⚠ **A pending request does NOT cancel anything.** `cancelled` stays false and the order keeps its `pending` status, so it remains in everyone's list. Letting the request itself remove the order from view would hand the requester the exact effect of the permission they were not granted. A `.sp-status-badge` on the row says a request is pending, so nobody works an order that is awaiting a decision.

⚠ **`approve-cancel` / `reject-cancel` stay `@Roles('admin')` and are deliberately NOT derived from `shopify-cancel`.** The request→approve step exists to put a second person between a staff member and the cancellation; if approval used the same perm, a holder could approve their own request and the gate would be decorative. Same rule supplier-returns' approve/reject already follows.

- The **requester's reason is carried through approval unchanged** — the approver decides *whether*, not *why*. `cancelledBy` is set to the requester (they made the operational decision) while `cancelRequest.reviewedBy` records who authorised it. Dropping the code here would send every approved request to «غير محدد» in the cancellations report.
- The reason is **validated at submission**, not at approval, so a bad reason is rejected while the requester is still on screen. `resolveShopifyCancelReason` is shared by the direct and request paths so the two cannot drift into accepting different reasons for the same action.
- `restoreOrder` clears `cancelRequest`, or a restored order keeps an 'معتمد' request and الموافقات keeps listing a cancellation that no longer exists.
- Approvals integration: a new `shopify-cancel` kind in `buildApprRow`, its own filters, and the count folded into the existing «طلبات إلغاء» KPI and the sidebar badge. ⚠ The sort comparator special-cases which kinds carry `_status`/`_sortDate` — a kind omitted from `_hasOwnStatus` silently falls back to `a.status`/`a.createdAt`, which a Shopify order does not have for its request.
- ⚠ **The approvals page fetches `/shopify/orders` itself on entry.** `_shopifyOrders` is filled by the Shopify page, which a manager arriving straight at الموافقات may never have opened — without this the requests are simply invisible.
- Tests: `test/integration/shopify-cancel-approval.service.spec.ts` (13 cases). It `jest.mock`s `employee-scoring.service` and `require`s ShopifyService lazily — ts-jest type-checks every transitively imported file under stricter settings than the build tsconfig, so an unrelated typing issue there would fail this suite for reasons that have nothing to do with cancellations.

### Bulk cancel was the worst offender
The selection-bar «إلغاء» called the generic `showPrompt('أدخل سبب الإلغاء:')`, so **every bulk cancellation landed with an empty code** — and bulk is how large clean-ups happen, so that one call site could have swamped the entire «غير محدد» bucket on its own. It is now a real modal with the same picker.

- **One reason applies to the whole selection, and the dialog says so.** A single confirmation cannot honestly ask "why?" per row; if the reasons differ, they are separate actions. Leaving that unstated would let the operator assume each invoice kept its own reason.
- The impact panel is **aggregated and split by direction** — purchases return cash to the vault while sales pay it back out, so netting them into one figure would describe neither. Same rule as the single dialog: only the `deposit` moves.
- Transactions in the selection that cannot be cancelled are **counted and named as skipped**, not silently dropped.
- **Partial failure is reported** (`cxbDonePartial`). The loop cancels one at a time; a bare success toast would hide that some rows moved vault and stock while others did not.
- `lockDismiss: true` — a multi-row irreversible action with a required field is exactly what must not die to a stray backdrop click.

### Every cancel dialog names its subject — `cancelSubjectHtml`
All three dialogs used to open with a title and a paragraph and **never showed the order number**. On a page of 25 rows that is one misclick from cancelling the wrong order, and the confirmation could not catch it because it never said which order it meant.

`cancelSubjectHtml({ref, name, total})` is one component shared by all of them: the **reference leads at 1.15rem** — it is the identity, not the fourth label on the second line — with the customer/supplier and value as muted meta beneath. It replaced the transaction dialog's 2-line label/value block, which said the same things in the wrong order of importance.

⚠ **Bulk cancel deliberately does not use it.** It has no single subject and its title already states the count; a subject header there printed the same number three times on one screen. The `count` branch and its `cxsCount` key were removed rather than left unreachable — a key no caller can reach reads as a live feature.

`cancelActorHtml()` adds a small muted «بواسطة {name}» at the foot. `cancelledBy` was always recorded, so this is not new data — it makes the attribution visible **at the moment it is created** rather than only afterwards in the report.

The Shopify lead line was cut from a full sentence about statistics and restorability to «لا أثر على المخزون أو الخزنة — يمكن استرجاعه.» The full vault/stock effect is in the الأثر panel directly below, so the lead no longer has to carry it in prose.

### The picker is radio cards, not a `<select>`
The entire point is that the operator **sees** the standard list instead of typing whatever comes to mind, and a dropdown hides the options behind a click. ⚠ `.crp-opt input` is `position:absolute;opacity:0` rather than a bare radio — the global `input,select{width:100%}` rule crushes bare radios; see [[global_input_width_breaks_radios]].

### The report — tab «الإلغاءات», perm `reports-cancellations`
`buildCancellationsReport(from, to)` in `TransactionsService`, returned as `cancellations` on `GET /transactions/reports`. No new endpoint and no extra request — the panel is a pure function of the report already fetched.

⚠ **`getReports` filters `transactions` to `cancelled: {$ne:true}`, so the rows this panel needs are absent from that array by construction.** It runs its own query. Do not "optimise" it by reusing the caller's list — it would always return zero.

⚠ **Cancellations are dated by `cancelledAt`, not `date`.** A cancellation is an event in the period it *occurred* in; bucketing an August cancellation of a June order into June makes the current period look clean and silently rewrites a closed month. Rows with no `cancelledAt` fall back to `date` rather than being dropped.

- `ShopifyOrder` is registered **schema-only** in `TransactionsModule` (same pattern and same reason as `SupplierReturnOrder`): orders cancelled on the Shopify page never become a transaction, so they are invisible to every other query in the service. ⚠ **Adding it means adding it to `transactions.service.spec.ts`'s test module too** — otherwise all 91 tests fail to compile a module, exactly the `FollowUpsService` trap documented above.
- `refunded` is hard-coded `0` for shopify-stage rows rather than read from a field — nothing was ever taken, so nothing can be returned, and that is what keeps the "cost of cancelling late" comparison honest.
- Reasons are ranked **by count, not by value**: the question is what keeps going wrong, and one large cancelled invoice is not a bigger problem than ten small recurring ones.
- Rendered as a **table with a share meter**, not a pie — 18 ranked slices are unreadable, and the reader needs the exact count and the money beside each. The meter is single-hue for the same reason as the vault strip's: a share of one total is a ratio against a limit, not a categorical palette.
- Wrapped in try/catch — a reporting panel must never take the whole report down.

#### The «آخر الإلغاءات» table
Paginated (25/50/100), sortable on 6 columns, filterable by stage, and searchable — all **client-side**, over data the report already returned. It never refetches.

⚠ **The backend returns the full list, not a top-25 slice.** Paging and sorting a truncated payload would make page 2 and every sort silently wrong — they would reorder 25 arbitrary rows rather than the period's actual cancellations. `MAX_CANCEL_ROWS = 500` bounds the response, and when it bites `recentTruncated` makes the UI **say so** («تُعرض 500 من 640») instead of presenting a partial list as complete.

- **State (`_cxrPage`/`_cxrSortKey`/`_cxrSearch`/`_cxrStageFilter`) lives outside the renderer**, so paging and filters survive a re-render (tab switch, language flip).
- ⚠ **`_cxrRenderTable()` redraws only `<tbody>`, `<thead>` and the pager** — the card shell, filter tabs and search box are written once by `renderCancellationsReport()`. Re-rendering the whole card per keystroke would blur the search input mid-typing.
- ⚠ **Sorting runs on `.slice()`.** Sorting `_cxrRows` in place would permanently reorder the array the KPI and reason panels read from.
- **Search matches the reason's LABEL, not its code** — searching for text you can see must return something (same rule `renderUsers()` follows for job titles).
- **Filtered-to-zero ≠ no cancellations.** The empty state distinguishes them and offers `resetCxrFilters()`, per the `LOAD_FAIL` three-state rule.
- **The operator's note renders as a sub-line, not a tooltip** — it is the only part not derivable from the code, and hover-only text is unreachable on touch. The derived `summary` stays in `title`.
- Reuses the shared **`renderPagination()`**; sort headers follow the vault table's `.is-sorted`/`.is-asc` convention, with the label in its own `<span>` so the indicator survives a text update.

**Column alignment and dividers.** ⚠ **`.cxr-tbl thead th` must not set `text-align`.** It did, and at (0,1,1) it outranked the bare `.cxr-num` (0,1,0) — so القيمة and نقد مُرتجع were `start`-aligned in the header while their values were `end`-aligned in the body: the label did not stand over its own column. Alignment is now declared **once per column on `th` and `td` together** (`.cxr-tbl th.cxr-num, .cxr-tbl td.cxr-num`), which makes the two physically unable to disagree. Add a new aligned column the same way — never by styling the `th` alone.

- **`table-layout:fixed` with an explicit width per column** (`.cxr-c-*`). Without it the browser sizes columns from each page's content, so the column boundaries **shift on every page change** — the table looks unstable even though the data is right. Only السبب is `auto`; it is the one variable-length column and carries the note sub-line.
- ⚠ **The fixed widths must be budgeted against the card, not guessed.** A first pass used 462px of fixed columns + 128px of padding + 28% in percentage columns; inside a ~900px card that left السبب **58px**, and below ~840px it computed negative. Fixed columns are now 424px with 7px gutters, keeping السبب ≥87px at 820px and ~300px at 1100px. `min-width:720px` is a **floor** (below it, scrolling beats crushing), never the default — an earlier `min-width:900px` is what pushed the last column off-screen and made sideways scrolling the normal state.
- **Column order is duplicated in two places** — `_cxrRenderTable()`'s `<thead>` and its `<tbody>` row template. They are separate string literals with nothing tying them together, so **reordering one without the other silently shifts every column's data under the wrong header**. Change both together and re-count.
- Consequence: a long value **overflows instead of widening**, so العميل and بواسطة are `.cxr-ell` (ellipsis + full text in `title`).
- **Vertical dividers** via `th + th` / `td + td` — eight columns with none read as one block, worst of all the two adjacent money columns. A hairline, not a full grid: the goal is separating columns, not turning the table into a spreadsheet.
- The two money columns carry a **`.cxr-money` tint** running the full height, which ties each header to its values vertically and compensates for the deliberately light horizontal rules. Same idea as the vault log's hero amount column.
- `applyLang()` re-renders it (every label is in a JS template literal, and `cancelReasonLabel()` reads `currentLang`).

⚠ `reports-cancellations` had to be added to **all three** `hasAnySubPerm` arrays, not just `PERMS`. Those decide the legacy-full-access fallback, so a user granted *only* the new perm would otherwise read as "has no sub-perms" and be handed every tab.

### Not changed
Reasons are **not** editable from Settings. Making them user-editable would let two branches invent different taxonomies for the same event and re-open the drift this closed; if that is wanted it needs a real managed list with codes that outlive their labels.

---

## The Vault Followed `payStatus`, Not Cash — #900001 (Aug 27, 2026)

Purchase #900001 was created with **total 0**, then edited to 7,940. The edit **deducted 7,940 from the vault for a payment that never happened** — while the invoice itself still said `deposit: 0`, `remaining: 7940`, i.e. the whole amount was owed to the supplier. It was corrected by hand (`MAN-007`), so the balance is right; the defect was in the code.

### `payStatus` cannot answer "was this paid?"
`payStatus` is derived: `remaining = max(0, total − deposit)`, then `payStatus = remaining <= 0 ? 'مكتمل' : 'معلق'` — in **both** writers ([index.html](frontend/public/index.html) `saveTx`, and `update()`'s own recompute). So a **zero-total** invoice saves as `مكتمل` with `deposit: 0`: not because anyone paid, but because there is no amount at all. `update()` read that flag as "دُفع للمورد كاملاً" and posted `−totalDelta` to the vault.

**The invariant: the vault moves by cash actually settled (`deposit`), never by what is owed (`total`), and never by a status derived from their difference.**

`isCompleted` now requires `oldDeposit > 0 && oldTotal > 0 && previousRemaining <= 0`, and both branches post **`cashSettledDelta = newDeposit − oldDeposit`** instead of `totalDelta`/`depositDelta`. This also closed a second hole the old code had in the *fully-paid* branch: raising the total on a paid invoice posted the whole difference as cash even when `deposit` never moved — the difference is **new debt**, and it belongs in the supplier ledger (`adjustSupplierLedgerForPayableChange`, measured on `remaining`), which already handled it correctly. Sales had the mirror bug: a 0 → 5,000 edit *added* uncollected cash.

⚠ **`effOldDeposit`/`effNewDeposit` clamp the deposit to the invoice total on a fully-paid invoice** — a paid invoice cannot settle more than it is worth, so a total drop from 5,000 → 4,000 returns 1,000 to the vault rather than reading as an unchanged deposit. The delta is rounded to 2 decimals so float drift can't open a zero-value entry.

The purchase branch's existing recompute of `remaining`/`payStatus` is what makes the bad state **self-healing**: editing such an invoice now flips it to `معلق` with the correct `remaining`.

### Notes
- Vault note wording changed to name what moved — «زيادة سداد مشتريات» / «إضافة تحصيل مبيعات» with `المسدَّد/المحصَّل قبل ← بعد`, not `الإجمالي قبل ← بعد`, which described a figure that no longer drives the entry.
- 9 regression cases in `transactions.service.spec.ts` (`update() — vault follows cash actually settled, never payStatus`) lock in the incident itself, the ledger's 7,940, the `معلق` correction, partial settlement, both fully-paid directions, and the two sales mirrors.
- ⚠ **The spec file was silently uninjectable**: `FollowUpsService` had been added to the service constructor but never to the test module, so all 71 tests in it failed to compile a module. `createMockFollowUpsService` in `test/helpers/mocks.ts` fixes it — **add a mock there whenever a dependency joins `TransactionsService`.**
- **Not changed: zero-total invoices are still creatable.** Blocking them is a separate product decision (a draft/quotation state), and the vault is now correct either way.

---

## Shopify Sales Were Missing From سجل حركة المخزون (Aug 9, 2026)

Orders confirmed from the Shopify page appeared in سجل المعاملات and correctly reduced the stock **balance**, but wrote **no row** to سجل حركة المخزون. Reported against refs `2313` and `2274`.

### Stock balance is derived; the movement log is not
These are two different systems and they fail independently:
- **Balance** — derived on read by `getInventory()`: `opening + purchases + returns − sales + adjustments`. Any non-cancelled `مبيعات` transaction reduces it automatically, whoever wrote it.
- **The log** — a real collection (`InventoryMovement`) whose rows are only ever written by `InventoryMovementsService.record()`, called from **four** places, all inside `TransactionsService`: `create()`, `update()`, `performCancellation()`, restore.

`ShopifyService.approveOrder` creates its transaction with `this.txModel.create({...})` — **it never goes through `TransactionsService.create()`**, so none of those four ran. It hand-replicated every *other* side effect (vault entry, `tx:created`, `inventory:changed`), which is precisely why nothing looked wrong: the emitted `inventory:changed` refreshed the on-screen stock number, so the balance was right and only the audit trail was empty.

⚠ **Any code path that writes a transaction straight to `txModel` inherits this bug.** If you add one, either route it through `TransactionsService.create()` or replicate the movement-logging block — there is no third option, and the UI will not tell you which you chose.

### The snapshot must be taken before the write
`recordInventoryMovementForSale(tx, snapshotBefore, employee)` mirrors `create()`'s block. `snapshotBefore` **must** be the `getInventory()` result captured *before* `txModel.create`, or `qtyBefore` already contains this order's own deduction and every row is off by its own quantity.

Unmatched line items are **named in a warning** here rather than skipped silently as in `create()`: Shopify line items are copied verbatim, so a SKU that matches no product `code` is the likely failure mode and would otherwise be invisible. The whole method is try/catch — the sale and its vault entry are already committed, and a logging failure must not fail the order.

### Backfill: `qtyBefore`/`qtyAfter` are reconstructed, not recovered
`POST /shopify/backfill/inventory-movements` (admin) `{refs:[...], dryRun:false}`. The historical balance was never recorded anywhere, so it is rewound from the present:

```
qtyAfter  = current stock − (Σ qtyDelta of every movement logged after this sale)
qtyBefore = qtyAfter + qty sold
```

⚠ **Do not use `getInventory()` directly as `qtyBefore`** — current stock *already* includes these sales, so that double-counts. The rewind is exact only if no untracked movement happened after the sale, which is why every backfilled row carries a `notes` string saying it was reconstructed. **`sumDeltaAfter` must sum all movement types, including `تسوية مخزون`** — manual adjustments are a term in derived stock (`getManualAdjustmentQtyByProductCode`), so omitting them would skew the rewind.

`dryRun` defaults to **true** (`dryRun !== false`) — a bare `{refs:[…]}` previews and writes nothing. Idempotent: a ref that already has any movement row is skipped, never duplicated.

### Wiring
`ShopifyModule` now imports `InventoryMovementsModule` and `TransactionsModule`, both `forwardRef` — those two were already a cycle and Shopify joins it. `nest build` does not prove this resolves; only starting `dist/main.js` does (see the nullable-`@Prop` section below for why). Verified: *Nest application successfully started*.

**Still open:** cancelling a pre-fix Shopify sale writes a reversing `+qty` row via `performCancellation` with no original `-qty` to match it. Backfilling the ref first avoids this.

---

## A Nullable `@Prop` Without `type` Kills the Whole API (Aug 8, 2026)

`ReturnRequest.reversedAt` was added as `@Prop({ default: null }) reversedAt: string | null`. `nest build` passes — this is **not** a compile error. It throws at *module load*:

```
CannotDetermineTypeError: Cannot determine a type for the "ReturnRequest.reversedAt" field
```

A `T | null` union erases to no usable design-time metadata, so `@nestjs/mongoose` cannot infer the SchemaType and throws while the file is being `require`d — **before `NestFactory` ever binds a port**. Every route dies with it. The visible symptom was «خطأ في الطلب» on login, which reads as an auth bug and is not: `auth.controller.ts` and `app.module.ts` were byte-identical between the working and broken revisions.

**The rule: every nullable `@Prop` states its type.** All six pre-existing ones already did (`product.categoryId`, `product.collectionId`, `category.parentId`, `collection.categoryId`, `settings.startDate`, `settings.endDate`) — `reversedAt` was the only new field that broke the pattern. Object-valued nullables use `type: Object` (`transaction.writeOff`, `supplier-return.settlement`).

⚠ **`npm run build` does not catch this.** The only check that does is actually starting the compiled output — `node dist/main.js`. Do that once before pushing anything that touches a schema.

### The health check was asking the wrong question
`restart: unless-stopped` in [docker-compose.yml](docker-compose.yml) resurrects the container after every crash, so `docker inspect -f '{{.State.Status}}'` reports **`running`** while NestJS is dying in a loop. The build therefore went green over a completely dead API. The check now POSTs to `/api/auth/login` through nginx and accepts any real HTTP status (401 is the expected one) while rejecting `000`/`502`/`504`; the failure branch also prints `RestartCount`, which is what exposes a boot-crash loop at a glance.

---

## Trust & Data-Loss Hardening (Aug 8, 2026)

Three systems whose primitives already existed but were barely adopted: 66 `showConfirm` calls (excellent) against only 11 skeletons, 13 filter-aware empty states, and **178 empty `catch (_) {}` blocks**.

### `LOAD_FAIL` — "couldn't load" is not "there is nothing"
Every boot resource was fetched with `.catch(() => [])`, converting **failure into an empty array**. A backend outage therefore rendered a fully-drawn, entirely-empty app with no error surface anywhere, and the Movements page — which has no fetch and no skeleton of its own, it renders straight off the in-memory array — announced «لا توجد معاملات». Staff read that as *the transaction history was deleted*.

**The rule is three states, never two: loaded-and-empty ≠ filtered-to-zero ≠ failed-to-load.**

`fetchOr(key, promise, fallback)` still returns the empty array (so no `.length` guard downstream changes) but records the failure. Any renderer can then ask `loadFailed('transactions')` and draw `loadErrorState(key, onRetry)`. **The flag clears on a successful retry** — otherwise a page keeps showing an error after the data came back. Applied to Movements, Vault, Complaints and Follow-ups.

⚠ **The vault opens on the current month by default** (`resetVaultFilters`), so an empty vault log is almost always a *filter* result. `_vltEmptyHtml()` now offers `resetVaultFilters()` — which already existed in the code and was never surfaced — instead of claiming the ledger is empty. Complaints had the worst copy: «ستظهر شكاوى العملاء الجديدة هنا تلقائياً» was printed even under an active filter.

### Silent failures that lose real work
`POST /mentions` after an invoice comment and after a follow-up assignment both ended in `catch (_) {}`. The comment saved and appeared, so the user believed they had escalated something — **the tagged colleague was never notified**. `_warnMentionFailed(targets)` names who didn't get it. The wording is a *warning*, not an error: the underlying action genuinely succeeded.

`clearMentionNotifications` / `markAllMentionsRead` cleared local state regardless of the server result, so the badge silently resurrected on next load. Both now bail with a toast instead of faking success.

### `beforeunload` — there was none, anywhere
`txDirty` guarded `navigateTo` only, so F5 / tab-close / browser-back discarded even the protected transaction form. The guard is a **registry** (`registerUnsavedGuard(key, fn)`), so adding a form means registering a predicate — don't edit the listener.

⚠ **Deliberate reloads must call `allowUnload()` first** — the forced-update dialog, backup restore, selective import and selective delete all reload on purpose, and would otherwise hit the browser's "Leave site?" prompt during an operation the user just requested. All five sites are wired.

### `_pmWatchDirty` was never protection
Despite the name, it flipped the save button's label from «حفظ» to «تحديث» and then **removed its own listeners** — no flag, no guard. The app's longest form (~20 fields) was lost to a stray Cancel click or refresh. Now a real `_pmDirty` flag that stays readable for the modal's whole life, guarding Cancel/X (`_pmCancel`, which asks only when something would be lost) and page unload. It runs in **create mode too** — a fully typed new product was the most painful loss and had no watch at all. `_pmClearDirty()` is called from `closeModal()` rather than from each of `saveProduct`'s several exits.

⚠ **Both close buttons must point at `_pmCancel()`, not `closeModal()`.** The header `.modal-x` was still calling `closeModal()` directly after the guard was written — and since `closeModal()` calls `_pmClearDirty()`, the X wiped the flag and destroyed the form with no prompt, defeating the entire feature while «إلغاء» looked like it worked. `lockDismiss:true` already covers the backdrop and ESC paths, so those two need nothing. **Any new dismiss control on this modal goes through `_pmCancel()`.**

⚠ `showConfirm(question, opts)` returns a **Promise&lt;boolean&gt;** — it is not an options object with an `onConfirm` callback.

### Boot: 8 sequential round-trips → 1
`loadAllData` ran 8 requests in parallel and then **7 strictly sequentially**, each awaiting the last for no reason. All 15 are now one `Promise.all`. `isAdmin()` reads only `currentUser` (set at login), not the batch results, so the admin-only fetches join safely. ⚠ `settings.darkMode` and `handleLangPolicy({force:true})` must stay **after** the await — both read the settings loaded in it.

**Still open (measured, not fixed):** `/transactions` is fetched whole — 437 records / ~5MB in the current backup — and paginated client-side, while the backend already supports `page`/`limit` ([transactions.service.ts](backend/src/transactions/transactions.service.ts) `findAll`). This is a growth ceiling, not just latency.

### Removed: «نسخة كاملة» on the invoice page
The `openArchiveExport('invoiceView')` button was dropped from `renderInvoiceViewPage`'s header. Its `EXPORT_REGISTRY` entry and the `xpResInvoice` translation key were deleted with it — a registry entry no button can reach is dead code that reads as a live feature. Everything else in `EXPORT_REGISTRY` is unaffected; **re-adding the button means restoring the registry entry too**, since the engine is driven entirely by that map.

---

## Navigation Trail — `NAV_TRAIL` (Aug 8, 2026)

Every back button in the app carried a **hardcoded** destination: the invoice page always returned to «الحركات» even when opened from the vault, and the supplier profile always to «الموردون». Three links had no back button at all — Shopify order # → متابعة الطلبات, vault ref → invoice, supplier ledger → vault. The root cause: `_doNavigateTo` — the only place `currentPage` changes — recorded nothing, and there is **no `history.back()` anywhere in the file**.

### Why a private stack and not `history.back()`
Three reasons, all binding:
1. **The previous entry cannot be read** from `history`, so the button could not say «الرجوع للخزنة» — and the name is half the value. A back button that doesn't name its destination is a jump into the dark.
2. **A shared link or F5 leaves the browser history empty**, so `history.back()` would eject the user from the app entirely.
3. **`openShopifyOrderFollowup` navigates inside a `setTimeout` and never calls `pushState`** — the real path was never in the browser stack to begin with.

### The one architectural rule
**`_doNavigateTo` is the only place that records.** Do not call `_navTrailPush` from anywhere else. Stateful pages (invoice / supplier / category / collection) record automatically because every deep-link entry (`openOrderView`, `openSupplierProfile`, `openCategoryProfile`, `openCollectionProfile`) routes through `_doNavigateTo` — verified, all four. The push happens **before** `currentPage = page`, because the snapshot is of the page being *left*.

### `restore` is the whole idea — not just the page id
Returning from an invoice to «ملف مورّد» must reopen **that** supplier on **that** tab, not an empty supplier page. Recording the page name alone produces a button that lands somewhere *resembling* where you were — worse than nothing, because it looks correct. `_navSnapshot(page)` captures `currentSupplierId` + `_spActiveTab`, `currentCategoryId`, `currentCollectionId`, `_invoiceViewTxId`/`Ref`, and vault/Shopify page + filter. `restore()` runs **before** the navigation, because `onPageEnter` reads those globals while drawing.

The snapshot also carries a **real name**: the supplier's own name rather than the generic «مورّد», so the button reads «الرجوع لـمورّد النور». Returning `null` (e.g. `supplier-profile` with no `currentSupplierId`) skips recording — there is no page to go back to.

**To cover a new stateful page: add one `case` to `_navSnapshot`. Nothing else.**

### Two button flavors
- **`navBackBtnHtml({forPage})`** — for pages that already had a back button (invoice view). Falls back to `_NAV_FALLBACK`, which holds **exactly the old hardcoded destination**, so a shared link behaves precisely as before: no regression, and the button never disappears.
- **`<span data-nav-ctx-back="vault"></span>`** — for pages that are ordinary sidebar destinations (vault, follow-ups). A permanent back button there is meaningless, but arriving from elsewhere left no way back. The slot fills **only when a real trail exists** and stays empty on a normal visit. It deliberately does **not** fall back — «الرجوع للوحة التحكم» in the vault is an invention nobody asked for. **To cover a new page: add the `<span>` to its header, and no JS.**

### زر «للأعلى» — `#to-top` (Aug 8, 2026)
One global button in `<body>` (not per page), shown after scrolling past two viewports.

⚠ **The page scrolls on `window`, not on `#main`.** `#main` has no `overflow-y` and no fixed height — it is a plain block with `margin-top`. A pre-existing `main.scrollTo({top:0})` in the file is therefore a **no-op**; don't copy it. `scrollToTop()` uses `window.scrollTo`.

- **The threshold is relative** (`innerHeight * 2`, floor 600px), not a fixed pixel count: "have I actually travelled far from the top?" is a relative question. A short viewport reveals the button sooner, a tall one later. The 600px floor keeps it off pages that barely scroll.
- ⚠ **Measured inside `requestAnimationFrame`, never in the listener.** A scroll handler that reads `scrollY` directly forces layout on every frame — on a table with hundreds of rows that is a visible stutter. `{passive:true}` for the same reason.
- **`_ttTick()` is also called from `_doNavigateTo`** — switching pages fires no scroll event, so a button left visible would linger on a short page.
- Deliberately quiet: 42px circle, `opacity:.92`, no label, no brand colour. A coloured FAB competes with page content permanently in exchange for occasional utility.
- Positioned with **`inset-inline-end`** so it follows page direction automatically — never hardcode `left`/`right` here (same rule as the back-arrow component above). On mobile it clears the 104px reserved bottom strip.
- The label lives in `title`/`aria-label` and is owned by **`syncToTopLabel()`**, called from `applyLang()`. It carries no `data-i18n-title` on purpose — the icon-only button would otherwise be re-labelled by the sweep.

### Traps this had to handle
- **`popstate` pops, it does not push.** Without that line the browser's own back button grows the stack every press, and the in-app button starts pointing at where you just came from.
- **A←B←A does not grow the stack.** If the destination equals the top of the stack, that is an implicit back — pop instead of push. Depth is capped at 5.
- **`_navTrailSuspended` during `navBack`** — a return is not a departure and must not be recorded as one.
- ⚠ **The three static back buttons carried `data-i18n-title`**, so the `applyLang()` sweep would overwrite the dynamic label. `_navSyncBackBtn` **removes both i18n attributes** on first sync and becomes the sole owner of that text. It is called from `_doNavigateTo` (after `onPageEnter`, covering navigation, deep links and browser-back in one line) and from `applyLang()`.

---

## Reports Charts — Rebuilt as a Design System (`REP_VIZ`) (Aug 8, 2026)

The المبيعات والمشتريات tab drew four charts, each with its own hardcoded hexes (`#16a34a` / `#1565c0` / `#6d28d9` / `#dc2626`), 9px axis ticks and the default black tooltip with no currency. Rebuilt around **`REP_VIZ`** — one palette, one set of axis/tooltip builders, three canvas plugins — plus two form changes and one real data bug.

### `chart-low` («المنتجات الراكدة») was drawing data it could not contain
`lowItems` sorted **`productProfits`** ascending and took ten. `productProfits` is accumulated in `getReports` from **sold line items**, so a product with zero sales is absent from it *by construction* — the genuinely dead stock was structurally invisible, and what rendered was the ten worst *sold* items: in practice ten identical full-width bars on a 0→1 axis.

Replaced by **`stagnantStock`** (`TransactionsService.buildStagnantStock`), which starts from **inventory**, not sales:
- Stock comes from **`getInventory()`**, not a third derivation. That method and `getAvailableQtyByProductCode` are the only two places stock is computed (see the comment at `returnedItemQtyForStock`); a third would drift from both.
- **`allTx` is captured before the `from`/`to` filters rebind `transactions`.** «آخر بيع» is a lifetime fact — scoping it to the period reports every product as never-sold the moment the user picks «اليوم».
- Filters to `current > 0`: a discontinued item at zero stock ties up no cash and needs no decision.
- Sorted by **`frozenValue`** (stock × buyPrice), because the question the panel answers is "which pile of dead cash do I clear first", not "which sold fewest".
- Wrapped in try/catch — a reporting panel must not take the whole report down.
- The panel renders as a **table**, not a chart: `renderStagnantStockPanel` shows stock, age (`.rv-tag.is-cold` at ≥90 days or never) and value. Ten equal bars were never a chart.
- Locked in by 5 cases in `transactions.service.spec.ts` (`getReports — stagnant stock`).

### Two three-bar charts became one waterfall
`chart-salesvspurch` and `chart-profit` spent half the viewport on six numbers, shared a meaningless «المبلغ» legend, and the first plotted **الفرق** — a value derived from the other two bars — as their peer. `renderMoneyFlowChart` replaces both: المبيعات → −تكلفة البضاعة → =إجمالي الربح → −المصاريف → =صافي الربح.
- **`kind` is read off the direction of each span**, never hardcoded, so a period where the margins invert cannot paint a rising bar in the "money left" colour.
- **`repWaterfallLinks` takes an explicit `links` array.** A subtotal bar restarts at zero, so consecutive bars do not simply chain — inferring the connector height from the data is wrong for two of the four links.
- `borderRadius` is **per bar**: 4px on data ends only. A checkpoint bar is anchored to the baseline, so rounding its foot floats it off the axis; a floating drain bar rounds both ends.
- The **هامش الربح الإجمالي / هامش صافي الربح** ratios beneath it exist nowhere else in the page and are the reading of the chart.

### The palette is validated, not chosen
`REP_VIZ_PALETTE` holds **two selected sets** (light + dark) checked against the actual card surfaces (`#f8fafb` / `#161d18`) for lightness band, chroma floor, CVD separation, normal-vision separation and contrast. Worst adjacent CVD ΔE is 20.7 light / 22.0 dark against a target of 8. **The dark column is stepped for the dark surface — it is not the light hexes reused.** Change one and both must be re-validated.

⚠ **The palette lives in JS because it is painted onto a `<canvas>`, which cannot read CSS custom properties.** Anything rendered as DOM (`.rv-*` tables, tags, share bars) stays on the app tokens. This is also why **`toggleDarkMode()` re-renders the tab** — canvases do not inherit a theme class.

### Canvas has the same bidi trap as the DOM
`repValueLabels` sets **`ctx.direction = 'ltr'`** before drawing. The canvas inherits the page's RTL direction, and a leading `−` is bidi-neutral, so `'− 236,412'` painted as `236,412 −` — the same class of bug the write-off dialog fixed with `<bdi>`, one layer down. **Don't "fix" this by reordering the string.**

### Other rules this layer follows
- **A label that would overflow is dropped, not clipped** (and neighbouring vertical labels drop on collision) — the value stays reachable in the tooltip and the table view.
- **Every canvas chart has a table twin** via `rvToggleTable(key, btn)`, which also `resize()`s the chart on the way back: a canvas that was `display:none` has no measurable box.
- **`.rv-toggle[hidden]` etc. must be listed in the `[hidden]{display:none}` rule** — `[hidden]` is only a UA `display:none` and loses to `display:inline-flex`. This is the same specificity trap as [[global_input_width_breaks_radios]].
- **Single series → no legend** (the card title names it); two series → legend always.
- Truncation is **stated in the UI** («تُعرض أعلى 6 صنف من 23») rather than silent.
- Product names **wrap to two lines** (`rvWrapLabel`); the old `substring(0,12)+'...'` destroyed them outright.

### Not done
The reports page is **not localized** — new strings here are raw Arabic, matching the rest of the tab. If Reports is localized later, this section and the `stgs*`-style key convention are the model.

---

## Vault Page Chrome — Compacted (Aug 8, 2026)

Everything above the log took **~660px**: a 5-card KPI grid (136px for five numbers), an always-open manual-settlement form (214px), and a filter card (199px). On a 1080p screen the log started below the fold. Now **~160px**.

### Five equal cards had no hierarchy and hid the ratios
`.seg-card` rendered all five at `font-size:1.4rem`, so «إجمالي الرصيد» looked exactly as important as فودافون كاش (11,673). And the four segments are **parts of one whole** with nothing in the design saying so. `.vb-strip` is one row: the total is the lead figure, and each segment carries a 3px **meter of its share of the total** (`--primary-pale` track, `--accent` fill).

⚠ **The meter is deliberately single-hue, not a colored stacked bar.** The four-hue categorical version was built and **failed the validator**: blue↔violet, adjacent, scored CVD ΔE 4.5 and normal-vision 15.0 — indistinguishable. Reordering fixed it but would have forced the segment order to change in every dropdown in the app. A share-of-total is *one ratio against a limit*, which is a meter — no categorical palette needed. Don't "improve" this into a stacked bar without re-running `validate_palette.js`.

The tile values use **proportional figures, not `tabular-nums`** — they sit in a row, not a column, and tabular digits make a large standalone number look loose.

### `renderVaultSegs` built its labels as hardcoded Arabic
That is why «كاش / تحويل بنكي / إجمالي الرصيد» stayed Arabic on the English UI while the rest of the page translated. Labels are now `t()` keys (`paymentMethodCash`, …). The same sweep covered the tabs, the toolbar buttons, the lock screen, and the whole settlement form — all previously untagged. `applyLang()` now also re-runs `renderVaultSegs()` and `_vltSyncPeriodLabel()`.

### Manual settlement moved to the toolbar
A rare action held 214px of the page's best space permanently. It is now a `#vault-settle-btn` in `.vault-actions` opening a one-line panel. **Every field id is unchanged** — `addVaultEntry` and `_validateVaultAmountInput` read the same DOM; this was a layout move, not a logic change. The admin gate moved from the panel to the button (the panel is `[hidden]` by default, so gating it with `style.display` no longer means anything).

«الطريقة» has exactly two values, so it is a segmented toggle; **`<select id="vault-method">` survives, `hidden`, as `addVaultEntry`'s single source of truth**, written by `_vltSetMethod`. `.vb-settle select[hidden]{display:none!important}` is required for the same reason as the user modal's role select — see [[global_input_width_breaks_radios]].

### `--fw-num` is what number weight means here
`.amt-num` sets `font-weight:var(--fw-num)` (**500**), so every `fmtJ` figure in the app renders at 500 regardless of the weight on its container — the vault strip's `.vb-t-val{font-weight:700}` never reaches the digits. The log's amount column had `font-weight:700` written directly on `.amt-num`, which is why it read heavier than the KPI figures. It now uses `var(--fw-num)` too; the column's emphasis comes from its tinted band, its two borders, its larger size and its red/green — not from extra weight. **Don't hardcode a weight on `.amt-num` anywhere.**

### «المبلغ مطلوب» was an alarm, not a correction
`_validateVaultAmountInput` runs on `oninput`, so clearing the field mid-edit painted it red and shouted "required" before the user had made any mistake. It now takes **`strict`** — only `addVaultEntry` passes it, so "required" appears on a save attempt. Format and value errors stay immediate because those *are* errors. **The return value is unchanged in both modes** (empty is still invalid), so no caller's control flow moved. The three messages went through `t()`; they were hardcoded Arabic.

The toolbar button's `$` icon was replaced — the currency here is EGP, and a dollar sign described a foreign currency instead of the action. Its open state is a light `.is-on` tint rather than `btn-primary`: a full green fill made it shout beside four outline siblings for what is not the toolbar's primary action.

### Field widths are explicit because the global rule fights them
`input,select{width:100%}` (~line 428) is why `0.00` sat in a 430px box. Every control in `.vb-settle`/`.vb-filters` sets `width:auto` plus an explicit width sized to its content (amount 118px, segment 150px, description/note flex).

### The filter row, and why the date control owns the Search button
Search / status / segment / type are **client-side** (`renderVaultTable`); only the date range hits the server (`loadVaultLog`). So the five preset buttons, both date inputs and «بحث» — a whole row — collapse into one period dropdown, and «بحث» becomes its Apply. The card's title and subtitle were deleted: 34px that repeated what the fields already said.

⚠ `.vault-quick-btns` / `.vault-quick-btn` and the `.vault-filter-card` class are **kept**: `_clearVaultQuickBtns`, `resetVaultFilters` and `unlockVault`'s non-admin gate all select on them. `_vltSyncPeriodLabel` mirrors the active preset onto the button, and **removes `data-i18n` when a custom range is showing** so the `applyLang` sweep can't overwrite the dates with a stale key.

`cashPulseAll`'s anchor moved from `#vault-segs .seg-card:last-child` to `.vb-tile.is-total` (old selector kept as a fallback).

---

## Vault Log Table — Rebuilt Around the Amount (Aug 8, 2026)

`#vault-table` had **11 columns and no running balance**. Two of them (`METHOD`, `SEGMENT`) printed the same value on nearly every row, the description — the only column carrying meaning — was clipped at `max-width:200px`, and the header rendered half English / half Arabic. Now **9 columns**, with المبلغ as the hero.

### `SEGMENT` was a duplicate of `METHOD`, not a coincidence
`addSystemEntry` computes `const seg = resolveVaultSegmentFromPaymentMethod(method)` — the segment is a *function* of the method, so the column carried zero information for every system-generated entry. But `addEntry` (manual) takes `seg` and `method` as **independent inputs** (`method: dto.method || 'يدوي'`), so they *can* differ. The merged «الخزنة» column therefore shows the **segment** and adds the method as a sub-line **only when the two differ** — lossless, and collapsed to one line in the normal case. **Don't re-add a second column for this.**

### The date column was hiding backdated entries
It stacked `v.date` (business date) over `v.createdAt` (posting date) with no labels, so an entry made 12 days after the fact looked identical to a same-day one. Now: business date on top, and either the posting *time* or a **«قُيّد بعد N يوم»** badge when they differ.

⚠ **`_vltDayGap` reads UTC parts, not local ones.** The backend generates `date` via `new Date().toISOString().split('T')[0]` — a **UTC** date — so comparing it against a locally-read `createdAt` put a false "1 day late" badge on every entry posted after UTC midnight. A plain `YYYY-MM-DD` string is parsed from its digits (`new Date('2026-08-07')` is UTC midnight, which shifts a day in any negative-offset zone).

### `الرصيد بعد` is admin-only, and it is the *total*
`balance` is written as `settings.vaultBalance` — the **total across all four segments**, not the segment's own balance (`balCash`/`balVodafone`/… hold those). The header tooltip says so. `openVaultTransactionDetail` already gated this figure behind `isAdmin()`, so the column would have been a way around that: `renderVaultTable` toggles **`#vault-table.no-bal`**, which hides `.vlt-bal-col` in CSS. Hiding via CSS rather than omitting the `<td>` keeps the column count fixed at 9.

### The hero column
`.vlt-hero` on the amount `<th>` and `<td>`: hairline borders both sides, a neutral tint, larger tabular numerals, and **`.amt-cur{display:none}`** — `fmtJ` emits `EGP` on every row, so 683 repetitions were replaced by one `المبلغ (EGP)` in the header. This also fixed `−EGP 33`, where the sign attached to the currency instead of the number. The totals bar keeps its `EGP` but puts the sign **inside** `.amt-num`.

### Other rules
- **The first cell must stay the plain-text txNo** — `_applyPendingVaultTx` (the arrival point from the supplier-ledger link) matches `tr.cells[0].textContent`.
- **A sortable `<th>`'s label goes in its own `<span data-i18n>`**, never on the `<th>` — `applyLang` sets `textContent` and would delete the `.vlt-sort-ind` arrow.
- `vaultSortKey` starts as `''` = **server order**, so nothing about the initial render changed; sorting begins only on a click. The comparator runs on `data.slice()` — without it, an unfiltered sort would permanently reorder `vaultLog` itself.
- The totals bar sums **`data`** (the whole filtered result), not `pageData` — an in/out total over 30 of 683 rows is worse than none.
- «مكتملة» is ~99% of rows, so it renders as a `.vlt-ok` dot with a tooltip; **only non-completed statuses get a full badge**.
- `accountingJustification` moved from a 160px column of truncated text (auto-generated narration mixed with free-typed junk) to a ⓘ tooltip in the البيان cell.
- **Filter `<option>` values stay Arabic** — `renderVaultTable` compares them to `v.source`/`v.status` directly. Only the labels carry `data-i18n`. Display goes through `_vltSrcLabel` / `_vltStatusLabel` / `_vltSegLabel`, following the "never translate a value that is also logic" rule.
- `applyLang()` now re-renders the vault page; every row string is built in a JS template literal.
- Two pre-existing bugs fixed alongside: the mobile card computed its sign from `v.amount` instead of `normalizeVaultSignedAmount`, so a **«رد مرتجع» showed green (+) on mobile and red (−) on desktop for the same entry**; and `openVaultTransactionDetail` extracted the amount by running `/>(.+?)<\/td>/` over `formatVaultAmountCellHtml`'s HTML — it now calls the new **`formatVaultAmountHtml(v)`**, which returns the span alone.

### Round 2 — journal entry, single-line rows, modal (same day)

**The garbled «الإثبات المحاسبي» was never a text problem.** The stored string is `الخزنة (Instapay) ترتفع 2750 ج — …`; it *rendered* as `… (Instapay) الخزنة`. Cause: on the English UI `applyLang` sets `document.dir = 'ltr'`, so every stored Arabic string is laid out in an LTR paragraph and its runs reorder. The same bug put the colon on the wrong side of every `المبلغ:` label. **Fix by isolation, never by editing the text** — `dir="auto"` on each container holding stored prose, `<bdi>`/`unicode-bidi:isolate` around Latin and numeric runs. Same rule as the write-off dialog above.

**`_vltJournal(v)` builds a double-entry journal from the data, not from the stored sentence.** The prose is written at creation time and cannot be improved retroactively; deriving the entry at render time makes it work on all 683 legacy rows with **no migration and no backend change** (`generateVaultTexts` is untouched). The stored text survives underneath as a historical note.

The key simplification: **the vault side is always decided by the sign of `normalizeVaultSignedAmount`** — cash in ⇒ vault is debited, cash out ⇒ vault is credited. The source type only picks the *counter-account*, so `VLT_COUNTER_ACCOUNT` is one flat map instead of nine debit/credit pairs. This is what makes «رد مرتجع» correct: it is stored **positive** but is a real cash outflow, and the normalizer already flips it, so the journal comes out `Dr مردودات مبيعات / Cr الخزنة` without a special case. Account names are `t()` keys and follow the UI language (ar: `ح/ ذمم مدينة — عملاء`, en: `Accounts receivable`); `vltAcctPrefix` is the `ح/ ` prefix, empty in English. An unmapped source returns `null` and falls back to the stored text.

**The ⓘ icon read as an error.** `ICONS.info` in this file is a circle + vertical line + dot — pixel-identical in shape to an alert. Replaced with `ICON('note')` (a document), muted to `opacity:.4` and lifted on row hover. It is now shown on **every** row (the journal is always derivable), not only when `accountingJustification` is non-empty.

**Rows are single-line.** البيان and التاريخ each stacked two `<div>`s, doubling row height. Both are now one flex line; only `.vlt-stmt-desc` flexes and ellipses, everything else is `flex-shrink:0` so the badge never gets clipped before the text. The backdating badge shortened to `+12d` / `+12 يوم` with the full sentence in its `title`.

**An empty ref cell is deliberate.** Manual entries have no reference by definition; a `—` on every one of them is noise.

### Round 3 — two falsy/aliasing traps (same day)

**`t()` cannot express "empty in English".** `vltAcctPrefix:{ar:'ح/ ',en:''}` looked correct but `t()` evaluates `entry[currentLang] || entry.ar` — `''` is falsy, so English fell through to Arabic and every English account name printed as `ح/ Vault — Instapay`. The prefix is now baked into the Arabic strings themselves. **Never define a translation key whose value is legitimately the empty string in one language**; a scan confirms no other key in the file does this.

**`entityLabel` is not a supplier name.** The backend writes it as `customer || supplier` (`vault.service.ts`), so `_vaultTxSupplierLinkHtml`'s `tx.supplier || tx.entityLabel` put the label «المورد / Supplier» in front of customer names. `customer` and `supplier` are separate schema fields: `_vaultTxPartyLabel(tx)` reads them in order and falls back to the neutral «الطرف / Party» only when the name came from `entityLabel` (whose type is genuinely unknown). The supplier-profile link is now built **only** when the name actually came from `tx.supplier` — a customer whose name coincides with a supplier's must not open that supplier's file.

**`المرجع` links to the invoice.** A vault entry stores `ref` as text, not a transaction id, and not every ref is a transaction ref (`012` is a supplier-ledger doc, `900001-SRET` a supplier return). `_vltRefHtml` resolves against the boot-time `transactions` global and renders a link **only on a match** — otherwise plain text, never a dead link. The `<a>` carries `event.stopPropagation()` so it doesn't also fire the row's detail modal.

**The journal renders as a real journal**: an `الحساب | مدين | دائن` header, the amount placed **under its column** (the other side shows a muted `—`), the credit account indented, and a `الإجمالي` proof row showing both columns equal. The earlier version put مدين/دائن as a 44px side label, which left a gap between the label and the account and never showed that the entry balances.

⚠ **In a metadata row, isolate the value with `<bdi>`; never set `direction:ltr` on the cell.** Flipping the cell's direction moves its *start edge* to the opposite side, so `#2340` shot to the far end of the row, away from its label. `<bdi>` (`unicode-bidi:isolate`) renders the Latin run correctly while alignment stays tied to the row's direction. This is the same isolation rule as the write-off dialog, applied to layout rather than text.

**Amount / Balance after now sit before Statement**, and the sign lives inside `.amt-num` in *all three* renderers (`formatVaultAmountHtml`, the modal hero, the totals bar) — `'−' + fmtJ(x)` produced `−EGP 12,000`, attaching the sign to the currency. The table's frame and hairline column dividers are on `#vault-log-table-wrap`, not `<table>`: a `border-radius` on the table itself does not clip its content during horizontal scroll. The backdating badge is grey, not amber — it is context, not an alert.

**The detail modal was rebuilt around why it gets opened** — amount (hero) → what it was → the journal → identity metadata → actions — replacing an eight-field `grid grid-2` in arbitrary order. `_vtxRow(label, value, ltr)` renders each metadata row as flex label/value, which is what removed `المبلغ:EGP 2,750`: the colon and the value were in the same text run. `#${tx.ref || '—'}` used to print a literal `#—`; the row is now omitted when there is no ref. `_vaultTxSupplierLinkHtml` returns **the value only** now — the caller supplies the label.

---

## User Modal — Rebuilt as a Three-Band Frame (Aug 8, 2026)

`openUserModal` put account fields, an avatar URL row, a role `<select>` and all 51 permissions in one scrolling column. On an account with twelve modules expanded, both the title and the save button were off-screen — the two things the user came for. Rebuilt around `.um2-*`: **fixed head / tabbed scroll area / fixed foot**, with `.um2-scroll` as the only scroller.

### `.modal` had to stop being the scroller
`.modal` ships `padding:24px; max-height:90vh; overflow-y:auto`. A sticky head/foot inside a scrolling parent drifts, and the two scrollbars fight. The modal is therefore opened with **`'max-width:760px;padding:0;overflow:hidden;max-height:none'`** so `.um2` (`height:min(86vh,720px)`) becomes the frame. `.perm-sys-body` carries its own `max-height:min(60vh,520px)` for other contexts, so `.um2 .perm-sys-body` resets it to `none` — otherwise the permissions list gets a second, nested scrollbar.

### The role `<select>` icons never rendered
Each `<option>` embedded an SVG; browsers strip markup inside `<option>`, so all three icons were dead code. Replaced by `UM_ROLE_CARDS` → three `.um2-role` radio cards. **The `<select id="um-role">` still exists, `hidden`, as `saveUser`'s single source of truth** — `_umPickRole()` writes it and then calls `applyPermTemplate(role, false)`. `applyPermTemplate`'s `syncRoleSelect` branch now also lights the matching card, since the select it used to update is invisible.

`.um2 select[hidden]{display:none!important}` is deliberate: the global `input,select{width:100%}` rule (~line 428) makes a bare `[hidden]` fragile — the same class of trap as [[global_input_width_breaks_radios]], which is also why `.um2-role input` is `position:absolute;opacity:0` rather than a bare radio.

### `refreshPermModules` is the one update path
It already recomputed the master checkbox and per-module count; it now also toggles **`.some`** (partially granted → tinted head) alongside the existing `.full`, and updates the tab badge, footer count and coverage meter. All four lookups are null-guarded because `renderPermSystem` may render outside this modal. **Add any new permission counter here, not to a second listener.**

`.some`/`.full` tint the module head with `--primary-pale`. Twelve identical grey rows differing only by a `2/3` badge made "what can this user do" a reading task across twelve counters; colour answers it at a glance.

### Validation must reveal the field it names
The form is tabbed, so a toast saying «اسم المستخدم مطلوب» while the Permissions tab is open points at an input the user cannot see. `saveUser`'s five guards go through a local **`fail(msg, tab, focusSel)`** that switches tabs, focuses and scrolls the field, then toasts. **Any new validation here must use `fail`, not a bare `toast`.**

### Job templates — `JOB_TEMPLATES` (Aug 8, 2026)
`ROLE_TEMPLATES` answers *how much authority* (staff/viewer/admin); `JOB_TEMPLATES` answers *which job*. A محاسب and an أمين مخزن are both `staff` yet need disjoint permission sets, and picking those by hand out of 51 checkboxes is where mistakes get made. Nine presets: `operations` · `sales` · `support` · `warehouse` · `fulfillment` · `accountant` · `cashier` · `purchasing` · `marketing`.

The old `.perm-sys-templates` strip held viewer/staff/admin — which the role cards now own — so it was **replaced** by the job chips rather than extended. Each entry carries `role`, the tier it implies, so `applyJobTemplate` also moves the role card via the shared **`_umSetRole()`**; the two controls can never contradict each other. `applyPermTemplate` clears `.perm-tpl-btn.is-on` for the same reason — a tier preset is not a job preset.

**Rules for adding a preset:**
- Every string must exist in `PERMS` or it is silently dropped on save.
- Grant the READ tab any write action depends on — `suppliers-pay` without `suppliers-tab-invoices` is a button onto a page the user cannot open.
- **`suppliers-*` money actions and `users`/`settings` stay out of every preset below `admin`.** Cash movement is a deliberate per-account grant; see "Supplier Account Permissions".

### Job titles — Arabic labels, English values (Aug 8, 2026)
`JOB_TITLE_OPTIONS` was 19 flat English strings in an all-Arabic UI. Now `JOB_TITLE_GROUPS` — five `<optgroup>`s (الإدارة / المبيعات وخدمة العملاء / المخزن والتشغيل / المالية والمشتريات / التسويق والمحتوى).

⚠ **`value` stays English and is what Mongo stores.** It is already on every existing account, feeds the users table, and is what `isCustomJobTitle` matches against — translating it would orphan every saved `jobTitle`. `ar` is display-only, resolved by **`jobTitleLabel(v)`**, exactly the `PRODUCT_COLORS.name` / `PM_COLOR_AR` split. `JOB_TITLE_OPTIONS` is now derived (`flatMap`) so the old flat list keeps working.

Applied at all three display sites (users table cell, mobile card badge, header/profile-menu) — and **`renderUsers`' filter matches both the stored English and the Arabic label**, or searching for the text you can see would return nothing.

`_umOnJobTitleChange` keeps the custom free-text toggle and adds a suggestion strip (`#um-job-tpl-hint`). It **offers** the preset behind an «تطبيق» button and never applies it silently — the admin may have hand-tuned the checkboxes, and a job title is a label, not an authority decision. It stays hidden when the modal opens on an already-saved title; it is a prompt about a change you just made, not a standing nag. Note the three top titles map to `tpl:'admin'`, which lives in **`ROLE_TEMPLATES`, not `JOB_TEMPLATES`** — `_umOnJobTitleChange` resolves both, so don't assume `tpl` is always a `JOB_TEMPLATES` key.

### Other notes
- **`lockDismiss: true`** plus a `.modal-x` header button — same rule as the product modal: a long form must not die to a stray backdrop click. Both implicit paths (backdrop `_onModalOverlayClick`, global ESC) already honour the flag.
- Live avatar preview: `_umSyncAvatar()` on the URL and name inputs keeps **both** circles (header + form row) in step; `_umAvatarFallback()` swaps a broken `<img>` for initials. It uses `escHtml` (encodes `"`), not `esc`, because the URL lands in an attribute.
- `autoSetPerms()` is now unreferenced by this modal (its `<select onchange>` is gone) but is kept as a global.
- Every field id (`#um-username`, `#um-name`, `#um-password`, `#um-phone`, `#um-avatar`, `#um-jobtitle-*`, `#um-role`) and the `.perm-cb` markup are unchanged — **`saveUser` reads the same DOM it always did.** This was a layout rebuild, not a logic change.

---

## Customer Returns — Phase 0 Hardening (Aug 8, 2026)

The return pipeline had a validation service that never ran, an unbounded refund, and no way to undo a return in the reports. All three tiers of the audit were fixed; the exchange module is a separate phase.

### `ReturnsValidationService` was 213 lines of dead code
It was registered as a provider **and exported**, and injected **nowhere** — so every check it advertised with a `CRITICAL` comment was inert. `ReturnsService.create()` now calls it. Two of its methods were **deleted rather than wired**: `validateExchangeInventoryAvailability` always reported `available: 0`, and `generateApprovalAuditReport` returned hardcoded `true` flags. Both read as verification while verifying nothing — worse than absent.

**The load-bearing rule: ceilings come from the stored invoice, never from the payload.** `computeRefundCeiling` values each returned line at the original invoice's unit price (`total/qty`, not `price` — a line discounted at entry has the concession baked into `total`). Submitted prices are sanity-checked within 10% and otherwise ignored. Fabricated items were previously accepted **and added to stock**, so this was a stock-inflation primitive, not just a bad record.

### The refund was whatever was typed
Only `> 0` was checked. `assertRefundWithinCeiling` caps at `min(effectiveItemsValue, amountPaid − alreadyRefunded)`, with `REFUND_ROUNDING_TOLERANCE = 1` because line totals round independently of the invoice total. **An invoice-level discount is allocated proportionally** (the Shopify/Odoo rule) — refunding the undiscounted line total hands back money never collected, and the reports then subtract that inflated figure from net sales.

### Reversal: `reversedAt`, not `status`
Cancelling a `مرتجع` transaction gave the stock back (inventory is derived from non-cancelled transactions) and reversed the vault — but left the `ReturnRequest` at `معتمد`, so **both** report queries kept subtracting it from net sales forever. A reversed return **keeps status `معتمد`**; `reversedAt` is what excludes it, mirroring `SupplierReturnOrder.reversal`. The status check alone is not enough — this is the same trap documented for supplier returns.

`markReturnRequestReversed` lives in **`TransactionsService`**, writing through the `ReturnRequest` model it already injects. It cannot call `ReturnsService`: `ReturnsModule` imports `TransactionsModule`, so that direction is a module cycle. It matches on `returnTxId` first, then `returnTxRef` (written at creation, so it survives a failed second save), and **never throws** — a cancellation whose money already moved must not fail on a back-reference update.

### Approval order is deliberate — do not "simplify" it
`validate → flip status → create transaction → revert status on failure`.
- Old order (flip, then create, no compensation) left `معتمد` with no transaction: counted by reports, backed by nothing.
- **Creating the transaction first is worse**, not better: cash and stock would already have moved while the request still read `معلق`, so a retry refunds twice.
Everything is **re-validated at approval**, because the request may have sat pending while another return consumed the same units.

### Partial returns, and why the ref is sequenced
The old `create()` blocked *any* second return on an invoice, so a 5-item invoice was one-shot forever. Replaced by the cumulative per-item rule (`assertQtyWithinRemaining`) — which was already written in the dead file. Consequence: `{ref}-RET` would now collide, and `assertRetailRefForPersist` **skips uniqueness entirely for type `مرتجع`** (it early-returns for anything that isn't مبيعات/مشتريات), so nothing downstream would catch it. Refs are therefore `-RET`, `-RET-2`, `-RET-3`… from `sequence`, recomputed at approval so two requests created before either was approved cannot both take `-RET`.

### `condition: سليم | تالف` is logic, not a label
A تالف unit is refunded but **must not re-enter sellable stock**. Both derived-stock loops (`getAvailableQtyByProductCode`, `getInventory`) go through **`returnedItemQtyForStock`** — they are the only two places stock is computed, and if they disagree the oversell guard and the inventory screen report different on-hand figures for the same product. Empty/absent condition means سليم, so every pre-existing return keeps its behaviour.

Profit follows: `computeReturnedProfitLoss` (extracted from two byte-identical copies) charges a سليم return the **margin** and a تالف return the **whole price** — the cost is lost too, since the goods never came back. No expense record is created: cash left the vault and no stock returned, so the loss is already recognised by the vault + derived-inventory figures. That is why `ExpensesModule`/`ExpensesService` — injected and never used — were removed.

### `returns.constants.ts` is the single source of truth
Reasons, conditions, the vault label map and `normalizeVaultAccountLabel` lived in **three** files, and had already drifted: the DTO accepted six reasons while the service accepted three, so the three exchange reasons passed DTO validation and were then rejected generically. `RETURN_ONLY_REASONS` / `EXCHANGE_ONLY_REASONS` are separate on purpose — a refund justified by «رغبة العميل بصنف آخر» is a contradiction.

### Exchange is refused explicitly, not downgraded
`requestKind: 'exchange'` now throws. Silently coercing it to `'return'` would refund a customer who asked to swap an item. **The real blocker is `assertRetailRefForPersist`**: `create()` calls it unconditionally ([transactions.service.ts](backend/src/transactions/transactions.service.ts)) and a `مبيعات` ref must be digits-only, so a `-EXC` replacement sale **cannot be created at all**. That is why the frontend still renders `-EXC`/`isExchangeSalePendingCollect` for legacy rows while nothing can create one.

### Frontend
`GET /returns/returnable/:transactionId` reports sold/returned/remaining per line plus refundable cash. It is declared **before** `:id` — Nest matches in declaration order.

`getRetRefundCeiling()` mirrors `computeRefundCeiling` (⚠ **keep both in sync**, same convention as the global-search scorers). It exists so the operator sees the cap *before* submitting; the server re-derives and is the authority. Eligibility moved from "a return exists" to `isInvoiceFullyReturned(tx) || _retRefundableCash(tx) <= 0` — in **three** places: `isSaleEligibleForReturnShortcut`, `selectReturnInvoice`, and the invoice-card list (that third one was still blocking on the old rule after the first two were fixed). `_retActiveRequestsFor` must filter `reversedAt` exactly as the backend does.

`renderReturnItems` re-renders on every toggle, so it reads the typed refund back and keeps it when it still fits the new ceiling — otherwise changing a condition silently wiped the amount. Removed the orphan `#ret-exchange-summary` div (rendered, never filled).

`damagedValue` is **discount-adjusted, on the same basis as the refund** — it is the slice of the refund that bought back nothing sellable. Reporting it gross while capping the refund net made the two disagree (100 vs 90 at a 10% discount).

### Tests
- `test/integration/returns.service.spec.ts` (29 cases) — each rule in isolation, against the **real** services.
- `test/integration/returns-flow.service.spec.ts` — one invoice, **cumulative**: two partial returns then a reversal, over a stateful in-memory store. This is not redundant with the above: the `damagedValue` basis bug passed all 29 isolated cases, because none combined an invoice discount with a تالف unit. Keep a cumulative case when adding rules here.
- Reversal, damaged-stock and the report query shape are in `transactions.service.spec.ts`.

⚠ The pre-existing `test/unit/returns.spec.ts` / `returns-extended.spec.ts` (and `inventory-stock`, `dashboard-kpi`) define local helper functions and assert on **those** — they pass whether or not the service works. Don't trust them as coverage.

### Still open (deliberately not in Phase 0)
- **Customers are keyed by `tx.client` (name), not phone** ([index.html](frontend/public/index.html) `renderClients`) — same name merges, spelling variants split, and returns don't affect customer totals at all. Changing the key touches every customer figure and needs a merge/migration plan; it is Phase 4 with `CustomerLedger`.
- `actualShipCost` is **recorded and displayed, not charged** — deducting it from the refund is a policy decision.
- `vaultCollectAccount`, `exchangeItems`, `exchangeTotal`, `priceDifference` remain writer-less until the exchange module.

---

## Supplier Ledger ↔ Vault Cross-Link (Aug 7, 2026)

A statement row saying «خرجت 12,000 من خزنة كاش» with no verifiable trace is unusable for an audit. The two records are now linked in both directions.

### `vaultTxNo` is denormalised on purpose
The entry already carried `vaultEntryId`, but a Mongo id is unreadable on a printed statement and would cost one lookup per row. `VaultEntry.txNo` (e.g. `TXN-007`) is assigned once at creation and never changes, so copying it onto the ledger entry cannot go stale. Set in `postBalanceAdjustment` (from the vault doc it just created) and in `postReturnSettlement`.

**The refund row is the one that needed it most.** `refund-paid` is `amount: 0` — the return already offset the debt — so it renders with «—» in *both* the debit and credit columns: a line that says cash moved while showing no figure and no reference.

Its cash moves through a مرتجع مشتريات transaction created deep inside `TransactionsService`, so the caller never holds the vault doc. `postReturnSettlement` therefore takes **`refundTxRef`** and resolves the vault entry itself via `VaultService.findLatestByRef` — **SupplierLedgerService already injects VaultService, while SupplierReturnsService does not**, and adding VaultModule there would have risked an import cycle. The lookup is wrapped in try/catch: a missing back-reference must never fail a settlement whose money has already moved.

### Not in the المرجع column — deliberately
That column shows `refNo || sourceRef`, i.e. the **document** the row belongs to (invoice / return / the supplier's own receipt or cheque number, per `refNo`'s schema comment). The vault operation number is *our internal* identity. Merging the two loses one of them the moment a real supplier receipt is entered. The link lives in the description's sub-line instead, beside «من خزنة كاش» where the vault context already was.

### Navigation
`openVaultTx(txNo)` sets `_pendingVaultTx` and navigates; **`loadVaultLog()` applies it after the fetch**, because the click arrives before the vault page has any rows to filter. This also handles the locked vault for free — the request simply stays pending until the unlock triggers a load. `_applyPendingVaultTx` filters, flashes the row (`.vault-row-flash`) and scrolls to it; if the operation is outside the loaded date range it says so rather than landing the user on an empty table.

Reverse direction: the vault transaction detail modal links back to the supplier profile (`_vaultTxSupplierLinkHtml`). Vault entries store the supplier **name** (`supplier`/`entityLabel`), not an id, so the match is by name — an unmatched name renders as plain text rather than a dead link.

### Backfill
`POST /supplier-ledger/backfill/vault-tx-no` (admin, `{dryRun:false}` to commit) copies `txNo` onto rows written before the field existed. It touches no amount, balance or date; a row whose vault entry no longer exists is **reported**, never guessed at.

---

## Write-off Dialog — Redesigned (Aug 7, 2026)

`openWriteOffModal` (إقفال متبقي الفاتورة) posts an irreversible `invoice-write-off` ledger entry. It was styled like a notification: a **success-green** panel, the amount buried mid-sentence, and the one line that actually prevents a wrong click («لا يخرج أي مبلغ من الخزنة») rendered as the smallest, lowest-contrast text on screen. Rebuilt around the decision:

- **The remaining amount is the hero** (`.wo-hero-amt`), in the same red the invoices table uses for المتبقي so the two screens stay visually linked, with invoice total + paid beneath it and the supplier name above.
- **No green before the fact.** Green is for "done", not "about to". The panel is now neutral (`--bg-alt` + border); `--primary` survives only on the vault icon.
- **`<bdi>` around every amount.** `fmtJ` emits a Latin run (`EGP 1,392`) inside Arabic prose, and neutral characters (`.`, `:`) resolve to the edge of that run — which is why the old dialog rendered `1,392 EGP .` with a space before the period. The source string never had that space; **do not "fix" this class of bug by editing the text**, isolate the run.
- **Reason field**: four quick-pick chips (`_woPickReason`) plus free text, because the reason lands in the debt ledger and pure free text makes it un-groupable in reports. The `<input>` stays the single source of truth, so `confirmWriteOff` reads one value. Validation is now **inline at the field** (`#write-off-err`), not a toast, and the field autofocuses.
- **`lockDismiss: true`** — a required field plus a non-undoable ledger write is the worst possible thing to lose to a stray backdrop click.
- The confirm button carries the figure («إقفال 1,392 EGP»), the standard safeguard for irreversible amounts.

`.modal-head` / `.modal-x` are the generic header + close-button classes (renamed from `.pm-modal-x`); reuse them on any dialog that sets `lockDismiss`.

---

## Product Modal — Dismiss Lock & Duplicate (Aug 7, 2026)

### `openModal(html, style, {lockDismiss:true})`
`#modal-overlay` used to close on any backdrop click (`onclick="if(event.target===this)closeModal()"`), which silently discarded the longest form in the app. The overlay now calls **`_onModalOverlayClick(event)`**, which honours a `_modalDismissLocked` flag.

- **The lock is on the dismiss path, not on `closeModal()`.** Every X/Cancel button calls `closeModal()` directly and is deliberately unaffected — do not "fix" this by guarding inside `closeModal`, or the buttons stop working too.
- **`closeModal()` clears the flag.** Every modal in the app reuses this one overlay, so a lock left set would make the *next*, unrelated modal undismissable. `openModal` also re-sets it from `opts` on every open.
- A locked backdrop click **shakes the modal** (`.modal.is-locked-shake`) and toasts `modalLockedHint` once per open. Doing nothing at all reads as a frozen app; the shake is the feature, not decoration. `void box.offsetWidth` between class removal and re-add is what restarts the animation on repeated clicks.
- The product modal also gained a header **`.pm-modal-x`** — with backdrop dismissal gone, the only other exit was the Cancel button, which is below the fold on a long form.

**There are exactly two implicit close paths, and both must go through `_modalRejectDismiss()`:** the backdrop click, and the **global ESC handler** (~line 63007, the `keydown` listener whose last branch is `qs('#modal-overlay').classList.contains('active')`). Locking only the backdrop leaves the form one keystroke from being wiped. Any new implicit path must call `_modalRejectDismiss()` rather than reimplementing the shake.

`closeReferenceDetail()` and `closeProductCard()` used to hide the overlay with a bare `classList.remove('active')`, skipping `closeModal()` — that leaves the `.pm-sel` dropdown panel (which lives on `<body>`) orphaned and the dismiss lock set. Both now call `closeModal()`. **Never hide `#modal-overlay` directly.**

### التصنيف والمجموعة اختياريان (Aug 7, 2026)
`saveProduct` used to hard-block on `!categoryId` / `!collectionId`. Both are now optional, like Supplier — the `*` is gone from the labels, the empty option reads «— بدون —» (`optNone`) in both the template and `_pmPopulateCollections`, and the two guards plus their `errCategoryRequired`/`errCollectionRequired` keys were deleted. The backend already had both as `@IsOptional()`, and `syncCollectionLink` only runs when a collection is set, so an untagged product simply shows «—» in the taxonomy columns and never appears under a category profile. Clearing the category still resets and disables the collection select (`_pmOnCategoryChange` → `_pmPopulateCollections('','')`), so no orphan `collectionId` can be saved.

### `openProductModal(id, draft)` — duplicate mode
`duplicateProduct(id)` **opens a prefilled form; it never POSTs.** Writing directly would bypass the name/code uniqueness checks and the staff OTP-approval flow in `saveProduct`.

The function separates two previously-conflated things:
- **`p`** — the render source (existing product *or* the draft). Every field, `<option selected>`, color/feature pill and the collections dropdown populate through the normal template path.
- **`isEdit`** — `!!source` alone. It drives `isLocked`, the system-info + history panels, the title, the save-button label, `_pmWatchDirty`, and the id passed to `saveProduct`.

Prefilling by typing into the DOM *after* `openModal` (as `_ssPrefillProductModal` does) does not work well here: `_pmEnhanceSelects` replaces every `<select>` with a custom button whose label is built at open time, so a later `sel.value = …` leaves a stale visible label. Rendering from `p` avoids the whole class of problem.

A copy inherits specs but **not identity**: `code` is emptied (unique — the server generates it on save), `openingBalance` is 0 (stock is not duplicated), and `activityLog`/`editRequest`/`createdBy`/timestamps are stripped. `_pmCopyName()` appends "نسخة" and then " 2", " 3"… because product names are unique in Mongo. `draft._sourceName` only feeds the `.pm-dup-banner` — `saveProduct` builds its body from the DOM, so nothing from the draft object reaches the API.

---

## Product Palette & Features — `PRODUCT_COLORS` / `PRODUCT_FEATURES` (Aug 7, 2026)

The 9-color palette became **31 colors**, and a new **المميزات (`features`)** multi-select was added to the product modal.

### Waterproof is a feature, not a material
`PRODUCT_MATERIALS` is a list of *substances* — each has an icon (`PM_MATERIAL_ICONS`) and a care line (`PM_CARE`), and a product has exactly **one**. Putting `Waterproof` there would make a product either Cotton *or* Waterproof and would leave it with no care instructions. Features are a separate `string[]` that **co-exists** with `material` and accumulates without limit. **Don't add properties (waterproof, anti-slip, machine washable) to `PRODUCT_MATERIALS`.**

### One entry, four derived things
`PRODUCT_COLORS` entries are `{key, name, ar, abbr, hex, light?, group}`:
- **`name` is the stored value** — it goes into MongoDB, into the filter `Set`s, and into the generated product code. **Never translate it.** `ar` is display-only, resolved at render by `_pmColorLabel()` / `_pmFeatureLabel()`.
- `PM_COLOR_AR` and `PM_COLOR_ABBR` are now **`Object.fromEntries(PRODUCT_COLORS.map(…))`** — adding a color is one line, not three.
- **`key` exists because `name` can contain a space.** The old pill id was `pm-color-${name}`, which `querySelector` cannot look up once "Off White" exists. `_pmToggleColor(name, checked, el)` now takes the element from `onchange` and only falls back to the id.
- ⚠ **`COLOR_ABBR` in [products.service.ts](backend/src/products/products.service.ts) is a hand-kept mirror of `abbr`.** The server generates the real code, the client only previews it (`_pmSlugPreview`) — if a color is missing server-side, both fall back to `name.slice(0,3)` *differently* and the saved code won't match what the user saw. Abbreviations must stay unique.

Colors and features both render through `_pmColorPillsHtml(selected, mode)` / `_pmFeaturePillsHtml(selected, mode)` — `mode:'pm'` for the product modal (enforces the 3-color cap via `_pmToggleColor`), `mode:'ss'` for the manufacturing spec sheet (free selection, read from `.ss-color-chk` / `.ss-feat-chk`). Both group the pills by `PRODUCT_COLOR_GROUPS` / `PRODUCT_FEATURE_GROUPS`; 31 chips in one flex row is unreadable.

### Filtering: features are AND, colors are OR
In `_fxMatchSpecs`, selecting two colors matches a product carrying **either** (one product is sold in several colors), but selecting two features requires **both** — "waterproof *and* anti-slip" is a conjunction. `fxState.inv/prod` gained a `feature: new Set()` which must be added in **all five** places the state is constructed (init, `resetFxFilters` ×2, `fxResetAll` ×2), plus `_fxOnDrawerChange`, `fxRemoveChip`, `_fxBuildChips`.

### The store description prints features grouped, in its own language
`_pmBuildDescription` emits **three sections** — `المواصفات` (material/size/colors/pattern/code), `المميزات`, then `تعليمات العناية`. Features are **one line per group**, built by `_pmFeatureGroupLines(features, lang)`:

```
المميزات

أداء وحماية: مقاوم للماء - مقاوم للبقع
عناية: قابل للغسل بالغسالة
استخدام: مناسب للاستخدام الخارجي - آمن مع الحيوانات الأليفة
صحة واستدامة: صناعة يدوية - صديق للبيئة
```

- ⚠ **Group labels come from `PRODUCT_FEATURE_GROUPS[].ar/.en` keyed on the `lang` argument, never from `_pmGroupLabel()`** — that helper follows `currentLang` (the UI), while the description has its own language (`_pmDescLang`). An Arabic-UI user generating an English store description is the normal case, not the edge case. The same rule already governs colors (`PM_COLOR_AR`) and materials (`PM_MATERIAL_AR`).
- Order comes from `PRODUCT_FEATURE_GROUPS` / `PRODUCT_FEATURES`, **not from click order**, so two products with the same features produce byte-identical blocks.
- Values not in `PRODUCT_FEATURES` (a CSV import can carry anything) are collected under `أخرى` / `Other` rather than silently dropped.
- Each section header is printed **only when it has lines under it** — a product with features but no material/size used to emit a bare `المواصفات` heading with nothing beneath it.
- English group labels are Title Case to match the other description labels (`Available Colors`, `Product Code`); those same strings are the pill-picker captions.

### Where `features` had to be wired
Product modal + `saveProduct`, store-description generator (`_pmCollectSpecs` → `_pmBuildDescription`, `PM_DESC_L10N.features`), filter drawer, inventory item detail (`.inv-spec-feat` chips), print field-picker (`_pmPrintFieldRows`, `show` is per-product so the bulk picker unions them), Excel export/import (`المميزات` column), spec sheet + `_ssPrefillProductModal`, edit-history formatting, and backend: schema, **all four DTOs** (unknown props are stripped by the whitelist pipe, so a missing DTO field silently drops the data), both `TRACKED_LABELS` maps, `importProducts`' inline type, the restore defaults in `settings.service.ts`, and `searchProducts` (`w: 0.28`, so searching "waterproof" finds them).

---

## Global Search — Relevance Ranking (Aug 7, 2026)

The header search (`#global-search` → `GET /api/search`) went from **boolean matching + a hardcoded section order** to a scored relevance engine. Searching `mar` used to list COMPLAINTS first (matched mid-word inside a customer name) above products literally named `Marronella` / `Marina` / `Maroon`.

### What was actually wrong
1. **Section order was a constant array**, not a function of match quality — `renderSearchDropdown`'s `preferred = ['nav','complaint','product',…]`. Complaints were pinned second regardless of how weakly they matched. (Deleted; do not reintroduce a fixed priority list.)
2. **Every backend search was boolean.** `matchesTokens(blob, tokens)` joined all fields into one blob and asked "does it contain every token?" — a hit in `notes` counted exactly as much as an exact `code`.
3. **`searchProducts` / `searchOrdersByText` `break`-ed at 50 matches in DB order.** The best match could be record #51 and never appear at all. Both now collect every match, sort by score, then `topN()`.

### The engine (`backend/src/search/search.service.ts`)
`scoreFields(fields, ctx)` takes `{v, w, primary}` per field. Per token it takes the best `tokenFieldScore × weight` across fields, then averages over tokens. **Returns 0 unless every token matched something** — the same AND semantics `matchesTokens` had, so *recall is unchanged; only ordering changed.*

Match grades: field-exact 100 · word-exact 88 · field-prefix 78 · word-prefix 60 · after-`ال` prefix 54 · contains 34. `primary` fields (ref, code, complaintNo, phone) that equal the whole query get `+150`, which pins an exact ref/code to the very top. Multi-token queries get `+15×w` when the query appears as a contiguous phrase.

Small additive adjustments break ties without ever overturning a better textual match (the 78-vs-34 gap dwarfs them): type priors (`TYPE_PRIOR_TEXT` / `TYPE_PRIOR_NUMERIC`, max 9), `recencyBoost` for orders/complaints, `log1p(orders)` for customers, `-8` for inactive products.

**Fuzzy is a fallback, not a mode.** `search()` runs a strict pass; only if it returns *nothing* does it retry with `fuzzy:true` (bounded Damerau-Levenshtein ≤1, or ≤2 for tokens ≥7 chars). **Numeric and phone queries never fuzzy-match** — a ref one digit off is a different order, and opening it would be worse than "no results".

### Frontend mirror — keep the two in sync
`index.html` has `_gsTokenFieldScore` / `_gsScoreFields` with **identical constants**, because nav items (`buildNavSearchItems`) never touch the endpoint and still need comparable scores. **Changing a weight or grade on one side without the other desyncs the "الانتقال إلى" section against every other section.** Both files carry a `⚠` comment saying so.

### `_gsRankResults` must produce the display order
It groups by type, sorts items by score, orders groups by their best score, and returns a **flat array that `searchResults` is replaced with**. This is load-bearing: `handleSearchKeydown` indexes `searchResults` directly, so if array order ≠ visual order the arrow keys jump around. `renderSearchDropdown` therefore just walks the array and emits a `.search-category` header when `item.type` changes — it no longer groups anything itself.

The one exception to pure score ordering: the `nav` section is pinned first when its best score ≥ `_GS_NAV_PIN` (70 — i.e. a prefix match or better). Typing a page name should go to that page; a weak partial match shouldn't outrank real records.

### Arabic specifics
- **`ال` is not part of the word.** `tokenFieldScore` retries each word with the article stripped (grade 54), so `مخزن` matches `المخزن`.
- **`٠-٩` / `۰-۹` → `0-9`** via `toLatinDigits`, applied to both query and fields, so `٢٢٥٤` finds ref `2254`. Frontend uses `_gsNorm` (= `normalizeUiSearch` + digit conversion) rather than editing `normalizeUiSearch`, which many other search boxes share.

### Match highlighting
`_gsHighlight(text, tokens)` wraps matched spans in `<mark class="search-hl">`. It can't just `indexOf` on the raw string — normalization *deletes* characters (diacritics, tatweel) and substitutes others, so match offsets don't line up. `_gsNormMap` builds the normalized string alongside an index map back to the original. Tokens shorter than 2 chars are skipped so a short query doesn't highlight the whole line. Output is still `esc()`-ed per segment — never pass raw text through.

### Tests
`backend/test/unit/search-relevance.spec.ts` (14 cases) mocks the Mongoose chain and locks in the `mar` regression, exact-match pinning, Arabic-Indic digits, fuzzy fallback, and AND semantics.

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

## Offline Archive Export — "نسخة كاملة" on Every Resource (Aug 6, 2026)

Every module now has a **تصدير نسخة كاملة** button producing one multi-sheet `.xlsx` — a browsable offline archive, not a flat table dump. 20 resources, one generic engine.

### Why a new engine rather than more `writeExcel` calls
The 26 pre-existing exporters each emit **one row per record**, so a transaction's items, payments, shipping, and audit trail were unreachable. A transaction has 7 levels of nested data; one row cannot hold them. The archive splits them across joined sheets (الملخص / الفواتير / الأصناف / المدفوعات / الشحن / المرتجعات / السجل), keyed on **المرجع**.

### The registry is the only thing you edit
`EXPORT_REGISTRY` (just below `writeCsv`) has one entry per resource: `title`, `titleKey`, `dated`, `all()`, optional `filtered()`/`selected()`, `dateOf(r)`, `build(rows, meta)`, optional `stats(rows)` / `fileTitle()` / `adminOnly`. **The button, modal, scope/period filtering, OTP gate and file writer are all generic** — adding a resource means adding a registry entry plus `archiveExportBtn('key')` (or an inline button calling `openArchiveExport('key')`). Do not write per-resource export functions.

`build()` returns `[{name, header, rows, numeric:Set<colIndex>}]`. `header` is an explicit Arabic array — **never `Object.keys()`**, or column order silently depends on which optional field the first record happened to have.

### UI follows the language; file content never does
Buttons/modal go through `t()` (ar/en). **The workbook is always Arabic** — headers, sheet names, values, and the الملخص sheet. It is an accounting archive, not a view.

`_xpLabel(key, fallbackAr)` exists because **`t()` returns the key itself when missing**, so the idiomatic `t(k) || fallback` is dead code. Seven registry titles (`invoice`, pickup, pending-sync, complaints, follow-ups, Shopify, approvals) had no `TRANSLATIONS` entry — the sidebar builds those labels from `NAV_ITEMS.label/labelEn`, not `t()`. They now have real `xpRes*` keys; use `_xpLabel` for any new title that might not be translated.

### What the free SheetJS build actually honours — verified, not assumed
The CDN build is **not** SheetJS Pro. Measured by writing files and reading back the sheet XML:
- ✅ `!cols`, `!merges`, `!autofilter`, cell `.z` number formats, and **`wb.Workbook.Views = [{RTL:true}]`** (produces `rightToLeft="1"`).
- ❌ **`ws['!views'] = [{RTL:true}]` is silently dropped** — per-sheet RTL does nothing. RTL must be set at the **workbook** level. Don't "fix" this by adding it back per sheet.
- ❌ `ws['!freeze']` / `!pane` — ignored entirely.
- ❌ **All `ws[addr].s` styling** (the fills/bold/borders in the older `writeExcel` at ~line 62300 and `writeExcelFormatted`) — inert. Those colours have never rendered.

Numbers are written as real numbers (`t:'n'`) with `#,##0.00`, so `SUM()` works in the exported file. Dates use `'ar-EG-u-nu-latn'` — the plain `'ar-EG'` locale emits Arabic-Indic digits (٠-٩), the recurring trap in this codebase.

### Security
- Reuses `requireExportOtp()` — non-admins still need manager approval. No new bypass.
- `users` export is `adminOnly` and **deliberately omits `password`, `plainPassword`, `totpSecret`**. Keep it that way.
- Non-admins get purchase-masked data from `GET /transactions` (`maskTransactionsForRole`). Rather than let a short archive look complete, the الملخص sheet **states this in the file** when the exporter is not an admin.
- `_xpRelease()` nulls `window._xpCtx` on every close/success path — the context holds full record arrays and `closeModal()` only hides the overlay.

### OTP gates must outrank modals — `z-index:1500`
A staff member exporting from the archive dialog saw **only the dimmer**: the OTP prompt opened *behind* the export modal, so the code could not be typed.

Cause: `#export-otp-modal` and the other eight OTP overlays are `.modal-overlay` (`z-index:1300`) declared **early** in the document (~lines 9700–10050), while the generic `#modal-overlay` that `openModal()` reuses is declared **last** (~line 14780). At equal z-index the later DOM node wins, so *any* gate opened from inside a modal lost.

All nine OTP overlays are now pinned to `z-index:1500` (above `.modal-overlay` 1300 and the in-modal `.inv-over-modal`/`#tx-picker-overlay` 1400). **This is not archive-export-specific** — it fixes every "approve from inside a modal" flow. If you add a new OTP/approval overlay, add its id to that rule.

Note the two overlays stay independent (`closeExportOtpModal` touches only `#export-otp-modal`; `closeModal` only `#modal-overlay`), and `_xpRun` reads every modal input **before** calling `requireExportOtp`, so the callback closes over captured values and never re-queries a dialog that may already be gone.

### Two pre-existing bugs fixed along the way
1. **`exportPickupExcel` was dead.** It called `exportToExcel(...)`, a function that **never existed anywhere in the file** — every Pick-Up Orders export threw `ReferenceError`. Now writes via `XLSX` directly, like its working sibling `exportPickupRun`.
2. **`exportClientsCsv` bypassed the OTP gate** that its Excel twin enforced, exporting identical data with no manager approval. Now gated.

---

## Forced Update on Deploy (Aug 6, 2026)

Every deploy now makes each open session show a blocking "يوجد تحديث جديد" dialog whose single button reloads the page. Nobody keeps working on stale JS against a changed API.

### The version comes from CI — it cannot be forgotten
`BUILD_NUMBER` (Jenkins, auto-incrementing) → `--build-arg` → written to `/version.json` **inside the image** by [frontend/Dockerfile](frontend/Dockerfile) at build time. It is **not a committed file**, so there is no manual bump step to skip; rebuilding necessarily changes it. Both Jenkins stages pass it ([Jenkinsfile](Jenkinsfile) build stage via `--build-arg`, deploy stage via the `BUILD_NUMBER=` env prefix consumed by `args:` in [docker-compose.yml](docker-compose.yml)). Local builds fall back to `dev`.

In dev, [frontend/server.js](frontend/server.js) synthesizes the same endpoint from `index.html`'s mtime, so editing the file bumps the version and the dialog can be exercised without Docker. Use `Math.floor(mtimeMs)` — `| 0` wraps it negative (32-bit).

### gzip is now load-bearing too
Because the shell is `no-store`, its full ~4.5MB is re-sent on **every** open and every forced refresh — there is no cached copy to fall back on. [nginx.conf](frontend/nginx.conf) therefore enables gzip (measured: 4,716,601 → ~1,090,000 bytes, **77% less**; verified lossless by SHA-256 round-trip). `server.js` mirrors it with built-in `zlib` (no new dependency, matching its hand-rolled `.env` parser). **Do not remove the gzip block** — nothing will look broken, it just silently costs every user ~3.5MB per page load. `text/html` is deliberately absent from `gzip_types` (nginx always gzips it; listing it warns about a duplicate MIME type).

### The cache fix is load-bearing, not incidental
`index.html` had **no `Cache-Control`**, so browsers applied heuristic caching and a reload could re-serve the *old* build — the dialog would then reappear forever. [nginx.conf](frontend/nginx.conf) now serves both `= /index.html` and `= /version.json` with `no-store`; `server.js` mirrors it for dev. **Do not remove those two `location` blocks** — the whole feature depends on the reload actually fetching new bytes. (The app is one big file with no bundler/hashed assets, so no-store on the shell is sufficient; no Service Worker is involved.)

### Client side (`APP UPDATE / FORCE REFRESH` block, right after `toast()`)
`initAppUpdateWatcher()` is called from `showApp()` **above the deep-link routing block** — that block `return`s early on several paths and would otherwise skip it. It records the version the tab booted with, then re-checks on a 60s interval, on `visibilitychange`, and on window focus. `checkForAppUpdate()` swallows network errors (a blip must not nag; the next tick retries) and only fires when the remote value *differs* from the boot value.

`showUpdateDialog()` appends straight to `<body>` with an inline `z-index:2147483647` rather than going through the modal helpers — it must cover open modals/drawers/toasts. **Deliberately non-dismissible**: no close button, ESC is `preventDefault`ed, Tab is trapped on the one button, and `body.overflow` is locked. `_updDialogShown` is a one-way latch so it never re-shows or flickers.

The reload writes `sessionStorage['soulia_update_reloaded']`; on next boot `_updShowReloadedToast()` consumes it and shows the green "تم التحديث بنجاح — الإصدار X" toast via the normal `toast()`.

**Socket `app:new-version` is an optimization, not the guarantee.** Polling is what makes this work with the socket down; the event just removes the wait. Its payload is ignored — the handler re-reads `/version.json` and compares, so a stray event can't reload an already-current tab. **No backend emitter is wired yet** — see below.

### If you want instant (rather than ≤60s) notification
Emit `app:new-version` from `PresenceGateway.emitEvent()` after a deploy — same mechanism as `settings:lang-policy`. Without it the feature still works fully, just on the poll interval.

### i18n
Six `upd*` keys in `TRANSLATIONS`; the dialog is built in JS so it uses `t()` (not `data-i18n`) and reads `currentLang` for `dir`. It renders in whichever language the user is on — no re-render needed, since it's created at show time and the page reloads immediately after.

---

## Supplier Credit on the Invoice — `creditApplied` (Aug 7, 2026)

A purchase paid from «رصيد لك عند المورد» read as **«تم السداد بالكامل · طريقة الدفع: كاش»** — a cash movement that never happened. `tx.depMethod` still carried whichever vault the *form* had selected, and the settlement block didn't render at all (deposit and remaining are both 0), so `creditApplied` was invisible everywhere.

- `_creditUsed` / `_noCashMoved` in `renderInvoiceViewPage`, mirrored as `_creditUsedM` / `_noCashMovedM` in `showInvoiceDetail` — **two independent renderers, keep both in sync.**
- When nothing left the vault, the payment method is **suppressed, not defaulted** — the same rule the supplier-return branch already stated in a comment: defaulting to a vault "would fabricate a cash movement that never happened". It shows «سداد من الرصيد» instead.
- The `.inv2-credit-note` panel is **blue, not green** (matching `.sl-bal-neg`, the supplier-ledger color for credit). Green means cash was paid; that is exactly what did not happen.
- Validation had the same blind spot: `validateTx` demanded the debt-acknowledgement checkbox from `purDeposit` alone, ignoring credit — so a fully credit-covered invoice was **unsavable**, because `_updatePurchaseDebtState` (which is passed `dep + creditApplied`) had already hidden the checkbox it was asking for. It now computes `creditApplied` with the same triple clamp as `calcTxSummary`/`saveTx`.

---

## Supplier Account Permissions — `suppliers-*` (Aug 7, 2026)

The supplier profile went from **one blanket `suppliers` perm + hard `isAdmin()` gates** to twelve fine-grained perms, enforced on both layers. Same convention as `categories-*` below.

### What was actually broken
1. **Paying a supplier had no gate at all.** `openBulkSupplierPayModal` («سداد دفعة») and the per-invoice «الدفع» (`openCollectMovement`) carried no check, and **`POST /transactions/:id/collect` was JWT-only** — any authenticated user could move cash out of a vault to any supplier. This is the hole the split exists to close.
2. **Everything else was `isAdmin()`**, so a manager could not delegate any of it without handing over the admin account.
3. **All six profile tabs were visible to anyone** who could open the page — سجل المديونية and سجل المدفوعات expose the supplier's full financial position.

### The twelve perms
Reads (one per tab): `suppliers-tab-invoices` · `-pos` · `-sreturns` · `-payments` · `-ledger` · `-activity`
Actions: `suppliers-pay` · `suppliers-deposit` · `suppliers-ledger-adjust` · `suppliers-write-off` · `suppliers-reverse` · `suppliers-returns`

Grouped as the `supplierAccount` module ("حساب المورد (الصلاحيات المالية)") in `PERM_MODULES` — deliberately **split out of `customers`**, which keeps the plain `suppliers` (list/nav) perm: granting "الموردون" and granting "who may move cash to a supplier" are different decisions. `ROLE_TEMPLATES.admin` is `PERMS.slice()`, so it picks all twelve up automatically.

### Actions disable, tabs hide — and that asymmetry is the design
- **An action the user may not perform stays visible but `disabled`**, with a `title` explaining why. A missing button reads as "this feature doesn't exist"; a dimmed one reads as "you need authority", which is the true statement and the one that tells the user to ask a manager. `supLockAttr(allowed)` for template-literal buttons, `supLockEl(el, allowed)` for static markup. CSS: `.btn:disabled,.btn[disabled],.is-perm-locked`.
- **A tab the user may not read is hidden AND not rendered.** Rendering-then-hiding would leave the rows one devtools inspection away, and `renderSpLedgerPanel()` would fire a request that now 403s. `renderSupplierProfile()` therefore computes `_spAllowed` and calls only those panel renderers; the rest get `innerHTML = ''`.
- In `renderSpSupplierReturnsPanel`, **status decides whether an action exists; perm decides whether it's enabled** (`canComplete = r.status === 'معتمد'`, then `supLockAttr(canManageSupReturns())`). Collapsing them back into one flag hides the workflow state from users who can still legitimately see it.

### Frontend helpers (one block under `SUPPLIER ACCOUNT PERMISSIONS`, after `requireCatPerm`)
`supPerm(action)` + `canPaySupplier()` / `canDepositSupplier()` / `canAdjustSupplierLedger()` / `canWriteOffSupplierInv()` / `canReverseSupplierPay()` / `canManageSupReturns()` / `canSeeSupTab(tab)`, plus **`requireSupPerm(action)`** — the in-function guard. Every mutating function starts with it, including the `save*`/`confirm*` half (the `open*` guard only protects the UI path; the save is a separate global). **Add `requireSupPerm` to any new write action here.**

`_spActiveTab` falls back to the first allowed tab when the remembered one is forbidden, and `setSpTab()` refuses a forbidden tab outright — the hidden button is not the guard.

### Two endpoints are type-dependent and cannot use a route decorator
`POST :id/collect` and `POST :id/payments/:paymentId/undo` serve **both** customer collection (money in) and supplier payment (money out). Only the loaded transaction distinguishes them, so the rule lives in `TransactionsService`: `collect()` and `undoSpecificPayment()` take `callerRole` + `callerPerms` and throw `ForbiddenException` on the purchase branch. **Do not "simplify" these into `@RequirePerms` on the route** — it would gate sales collection behind a supplier perm. Undo additionally keeps the *original* admin-only rule for the sales branch, so `suppliers-reverse` never silently widens into sales. Locked in by 6 cases in `transactions.service.spec.ts`.

### Back-compat: the legacy `suppliers` alias
The old blanket string keeps granting the **six read tabs** — exactly what a non-admin holding it could already see — so **no existing account loses access**. It is never an alias for an action: every action was admin-only before, except payment, which is the point. Frontend: `SUP_TAB_ACTIONS` + the last line of `supPerm()`. Backend: six entries in `LEGACY_PERM_ALIASES` ([perms.guard.ts](backend/src/core/guards/perms.guard.ts)). Both must move together.

### Backend
- [supplier-ledger.controller.ts](backend/src/supplier-ledger/supplier-ledger.controller.ts): `PermsGuard` + `@RequirePerms`. The entries list is `suppliers-tab-ledger`; balance-adjustment is `suppliers-deposit`; manual adjustment is `suppliers-ledger-adjust`. ⚠ The **two balance-summary routes stay ungated** — they return one aggregate the KPI strip and suppliers list already show, and gating them blanks those numbers for a user who merely lacks the ledger *tab*.
- [supplier-returns.controller.ts](backend/src/supplier-returns/supplier-returns.controller.ts): writes on `suppliers-returns`; **`approve`/`reject` deliberately stay `@Roles('admin')`** — the submit→approve step exists to put a second person between a staff member and a stock/ledger movement, and folding approval into the creation perm would let one holder approve their own return. GETs stay JWT-only because `GET /supplier-returns` is a boot-time load that also feeds the approvals page.
- `write-off-remaining` → `suppliers-write-off`.

**Not changed:** [suppliers.controller.ts](backend/src/suppliers/suppliers.controller.ts) is still JWT-only for create/update/log — supplier *record* CRUD was outside this change's scope, and it remains an open hole worth closing separately.

---

## Categories Permissions — Fine-Grained `categories-*` (Aug 6, 2026)

The التصنيفات module (Categories / category-profile / collection-profile) went from **all-or-nothing `isAdmin()`** to six granular perms, enforced on both layers.

### What was actually broken
1. **`perm:'categories'` was an orphan.** `NAV_ITEMS` referenced it, but it was absent from `PERMS`, `PERMS_AR` and `PERM_MODULES` — so it had **no checkbox in the users UI and could never be granted**. Categories was admin-only by accident, not design.
2. **12 UI gates were `isAdmin()`, and UI-only.** None of the 8 mutating functions re-checked; all are global and reachable from the console.
3. **Backend read routes were JWT-only** — any logged-in user could `GET /categories`, `/collections`, `/collections/:id/products`. Deep-links `#category-profile/<id>` / `#collection-profile/<id>` bypassed perm checks on **boot and popstate** (the popstate fallback checked `validPages` but not `hasPerm` — for *every* page, not just these).

### The six perms
`categories-view` · `categories-create` · `categories-edit` · `categories-delete` · `categories-assign-products` · `categories-link-suppliers` — grouped as the `categories` module ("التصنيفات والمجموعات") in `PERM_MODULES`, so `renderPermSystem()` renders the accordion/master-checkbox/search for them with **no new UI code**. `ROLE_TEMPLATES.staff` and `.viewer` both gained `categories-view`; `admin` is `PERMS.slice()` so it picks them up automatically.

### Frontend helpers (one block under `CATEGORIES PERMISSIONS`, after `hasPerm`)
`catPerm(action)` + the `canViewCategories()` / `canCreateCategories()` / `canEditCategories()` / `canDeleteCategories()` / `canAssignCatProducts()` / `canLinkCatSuppliers()` wrappers, plus **`requireCatPerm(action)`** — the in-function guard that toasts and returns false. Every mutating function starts with it (`openCategoryModal`, `saveCategory`, `deleteCategoryFromGrid`, `openCollectionModal`, `saveCollection`, `deleteCollection`, `openAssignProductsModal`, `confirmAssignProducts`, `removeCollectionProduct`, `openLinkSupplierModal`, `confirmLinkSupplier`, `unlinkCollectionSupplier`). **Add `requireCatPerm` to any new write action here** — hiding the button is not the guard.

The helpers are `const` arrows (no hoisting) defined ~line 20179; all 44 call sites run later, so there's no TDZ issue — but **don't move the block down**.

### Row menus are per-action, not per-role
`_catRowMenuHtml(c, inline)` / `_colRowMenuHtml(col)` build the ⋮ menu from `canEditCategories()` / `canDeleteCategories()` independently and return `''` when neither applies (dropping the ⋮ entirely). A user with only edit still gets a working menu — don't collapse these back to a single `isAdmin()` ternary.

### Backend (mirrors the `csp-*` convention)
Both controllers now use `@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)` + `@RequirePerms(...)` on **all 17 routes including GETs**, replacing per-route `@Roles('admin')`. `PermsGuard` bypasses unconditionally for `role === 'admin'`, so admin behaviour is unchanged. JWT carries only `{sub, username}` and `jwt.strategy.ts` refetches the user per request — **perm changes apply without re-login**.

`GET /collections/search-products/:partial` is behind `categories-assign-products` (it only feeds the assign picker); `GET /collections/product-links` stays on `categories-view` because the **Products page** taxonomy chips use it too.

### Back-compat: the legacy `'categories'` alias
Both layers treat the old string as an alias for `categories-view` **only** — never a write. Frontend: the last line of `catPerm()`. Backend: `LEGACY_PERM_ALIASES` in [perms.guard.ts](backend/src/core/guards/perms.guard.ts). Both must move together, or the UI shows a page whose API 403s. That map is the place to add future read-only legacy aliases (it's keyed required-perm → older strings); **do not add write perms to it**.

### Cross-page callers that needed gating
`loadProductCollectionMap()` (Products page) and `_ensureSupplierTagSources()` (supplier modal tag picker) both hit categories endpoints for users who may lack `categories-view` — both now bail early rather than firing doomed 403s. `openCategoryProfile()` / `openCollectionProfile()` are gated at the entry point because the **Products page taxonomy chips** deep-link into them. `loadCategoriesPage()` has a `canViewCategories()` backstop since `navigateTo`/`_doNavigateTo` never check perms themselves.

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

### Tabs removed (Aug 8, 2026)
**The Vault page has no tabs.** The التحليلات tab — both charts, its state (`vaultAnalytics`, `vaultCashflow`, `vaultCharts`, `cashflowDays`), `loadVaultAnalytics`, `renderVaultCashflowChart`, `renderVaultSourceChart`, `setCashflowDays` — was deleted, and with one panel left the tab strip and **`switchVaultTab` went with it**. `.vault-toolbar` is `justify-content:flex-end` now: with `.vault-actions` as its only child, `space-between` would have pushed the buttons to the start.

⚠ **`GET /vault/analytics` is still live and must stay** — `loadDashboardTreasury` (the dashboard's treasury card) is its remaining caller. **`GET /vault/cashflow` now has no frontend caller** and is dead server-side; it was left in place rather than removed unasked. Chart.js is still needed (3 other `new Chart(` call sites).

The section below describes the historical two-tab layout and is kept for context only.

#### (historical) Tab 1: نظرة عامة (Overview)
- **Vault Segments**: 4-card display showing account balances (كاش, فودافون كاش, Instapay, تحويل بنكي)
- **Total Balance**: Fifth card showing aggregate balance
- **KPI Cards**: Key metrics (monthly net, trend, daily average, cash velocity)
- **Manual Adjustment**: Form to manually add/withdraw funds with accounting justification
- **Transaction Log**: Full audit trail table with filters and pagination

#### (removed Aug 8, 2026) Tab 2: التحليلات (Analytics)
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

### ~~Tab Navigation Function~~ — deleted Aug 8, 2026
~~**`switchVaultTab(tabName, btn)`**~~ (no longer exists — see "Tabs removed" above)
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

## Automatic Bosta Settlement — «تسويات بوسطة» / «كشف حساب بوسطة» (Oct 7, 2026)

Every Bosta delivery settles itself a minute after DELIVERED: the real fee Bosta charged is read
from the API, the net enters the vault, and a frozen statement is kept on the order. Older orders
settle by selection («جلب السعر الحقيقي وتسوية»). The Excel importer (`carrier-settlement.service.ts`)
and manual collection are untouched.

### Where Bosta's price lives
`GET /deliveries/:id` → `log[]`. The closing entry carries `actionsList.pricing.{after}.priceAfterVat`;
mid-route changes appear as flattened `pricing_priceAfterVat: {before, after}` (e.g. the hub
reclassifying Normal → Large, 108.30 → 114). **The LAST closing price wins.** Measured: 341/341
Bosta-delivered orders carry it; #2638 = 114.00, matching Bosta's dashboard «مستحقات بوسطة».
`parseBostaPricing` / `decideSettlement` in `backend/src/shared/bosta-pricing.util.ts` are pure.

⚠ **`bostaMaterialFee` is never read.** It is 55 on every order, outside `priceAfterVat`, and absent
from the dashboard — the plan's packaging price, not a deduction (18,755 EGP of phantom expenses).

⚠ **A webhook body is not a substitute** — it may lack `log`. The settlement always re-fetches.
⚠ **Wait 60s** (`autoSettleReadDelaySec`): on #2638 the final price was written 232 ms AFTER the
delivery event. The wait is a `carrierSettlement.status:'pending'` marker in Mongo plus a
minute cron — never a `setTimeout`, so a restart loses nothing. No retry beyond that one read.

### The one rule
`net = remaining − priceAfterVat`. net ≥ 0 → `collect()` with **`opts.carrierActual`** (an internal
argument, never a DTO field), which deducts the fee EXACTLY and credits a cheaper carrier to the
vault as `shipSaving`. net < 0 (prepaid order, or fees > what Bosta collected) → the gap leaves the
vault as one `مصروف` entry. Manual collection still deducts the full billed tariff (unchanged).

Decision table (first match): no price → skip · not delivered → skip · Bosta COD ≠ our remaining
(> 0.5) → review · open conflict / ship issue → review · prior collection → review · overcharge >
`autoSettleReviewLimit` (20, inclusive) → review · else settle. A negative net is NOT a stop.
Approval overrides only the price limit.

### Safety
- **Single-flight** via `carrierSettleLock` (top-level string, atomic `findOneAndUpdate`; Mongo cannot
  `$set` inside a null `carrierSettlement`). Stale after 10 min.
- **No retroactive sweep.** `autoSettleSince` is stamped server-side on the first switch-on.
- **Manual collect is refused** while `pending`/`review` (frontend toast + server guard), and
  `confirmCodCollection` excludes any order with an active settlement.
- **Undo** = `TransactionsService.reverseCarrierSettlement` — outflow entry first (by id, via
  `VaultService.removeSystemEntryById`), THEN `reverseCollect`. Order matters: reverseCollect deletes
  the newest تحصيل row. `performCancellation` calls it first and reloads, or its COD reversal would
  subtract the gross COD (510) where the net (396) was booked.
- `reverseCollect` now also restores `shipSaving` and `codCollectionStatus` from the snapshot (old
  snapshots without them are left as they were).
- **Entries are dated**: automatic → delivery date; selection/approval → today (never rewrites a
  closed month).

### «كشف حساب بوسطة» and transfers
Derived on request: + COD collected, − fees, − return-leg fees (`failedDelivery.returnShipCost`
after activation), − transfers, − transfer fees, − booked differences. ⚠ **A Bosta transfer is not
vault income** (each order entered on settlement). `CarrierPayout` books only: the fee as an
approved expense (`رسوم تحويل`, default 25), the return-leg fees not yet in the vault, and — if the
user ticks it — the unexplained difference.

### Frontend
Vault tabs (`switchVaultView`, `_vview`): سجل الخزنة / تسويات بوسطة / كشف حساب بوسطة, shown with
`carrier-settle-view`. Perms: `-view`, `-run`, `-approve`, `-reverse`. `csInvoiceCardHtml` in BOTH
invoice renderers. Settings card in الإعدادات ← الشحن. The failed-delivery dialog pre-fills the return
fee from Bosta (`_csPrefillReturnFee`). Vault choice is per default, per batch, per approval, per
transfer. Reports add `shipSaving` back to profit (backend + both frontend calculations).

### Invoice page: live Bosta data
`GET /carrier-settlements/:txId/bosta-details` reads the delivery LIVE (cached 2 min, read-only,
no customer phone/address) because the stored `bostaRawResponse` lacks `wallet` on most orders.
- **Settlement card** (side column, under الشحن والتسليم): hero = `wallet.cashCycle.deposited_amt`
  (net in the Bosta wallet) with `deposited_at` and `next_cashout_date`; then collected, Bosta fees
  broken down (shipping, insurance, every non-zero extra fee, VAT, discounts/credits), package size,
  tariff and variance. Falls back to the log price when the wallet record is absent.
- ⚠ **Insurance rate comes from `insurancePlanInfo.orderValueFeePercentage`**, not cashCycle's
  `insurance_fees_percentage` — that one is rounded to 2dp (0.005 → "0.01" = a false 1%).
- ⚠ The wallet figure is the authoritative fee: #2205's log says 125.40, the wallet charged 119.70;
  #2191's log says 125.40, the wallet 114.00 after 11.40 of Bosta credits.
- **«من بوسطة» in الشحن والتسليم**: confirmed/delayed, attempt and call counts, last call, hubs,
  package (pieces · type · weight · description), may-open, each attempt (time, courier, hub, COD,
  succeeded/failed with Bosta's `exception.reason`), and package-size changes.

### Order timeline rebuilt
Steps are collected as specs and ordered by the time each one SHOWS (date-only values sit right
after the previous step of that day). Journey read from `bostaRawResponse.timeline[]` —
`TransitEvents` existed on 0 of 358 orders. Delivery time is `state.deliveryTime`, never «last sync».
New steps: deposit, Bosta settlement (replaces the COD step), failed-delivery close, cancellation.
«تم الإرسال للشحن» is dropped once the shipment log exists. Measured: out-of-order 291/358 → 0/370.

### Verification
22 unit cases (`bosta-pricing.spec.ts`, real #2638 fixture; revert-checked); 41 end-to-end checks
on real services against a scratch DB copy (settle, single-flight, approve, undo, cancel, cron,
transfers); 31 browser checks over the shipped `index.html` wired to the real services (timeline
over every order, tabs, preview, vault switch, review, statement, transfer, settings, English,
dark, 390px). `node dist/main.js` starts. Suite 1115/1119 — the 4 failures are pre-existing
`index.html`-extraction specs (staff-dashboard, shopify-order-edit), identical before this change.

---

## Stock Demand Analysis — Rebuilt Answer-First (Oct 5, 2026)

The «تحليل احتياج المخزون» modal (`#demand-planning-modal`, opened from the Shopify page
and from Movements) was redesigned from a canvas mock-up. **Presentation only** — the
server analysis, `_dpBuildOrderPivot`, the PO dialogs, Excel and print are untouched.

- **Seven KPI tiles became one answer** (`.dpx-hero`): «N من M طلب جاهزين للشحن الآن»
  with one block per order (solid = ready, red stripes = waiting), and beside it what
  to buy, the estimated cost (admin-only, as before) and the purchase actions.
  ⚠ **`_dpBuildOrderPivot()` now runs BEFORE the summary** (its later call was removed) —
  the headline is the pivot's ready/missing split. Past 40 orders the blocks become one
  proportional bar, because 40+ blocks are slivers.
- ⚠ **`#dp-new-po-btn` / `#dp-add-po-btn` moved from the footer into the hero**, with the
  SAME ids: `renderDemandPlanning` still enables/disables them by id after rendering the
  summary. Footer keeps Excel + Print only. «إنشاء أمر شراء» is the primary action;
  «أضِفها لأمر شراء قائم» is a link beside it.
- **Required/available/SKU columns became one coverage bar** (`_dpCoverageHtml`):
  `freeToUse` against `required`, shortage striped red. A negative `freeToUse` draws as
  0 available; the detail row states the deficit in words. Sort on that column uses
  `freeToUse`. The table is 6 columns now — **detail and empty rows use `colspan="6"`**.
- **The calculation is one chain of chips** (`_dpCalcBreakdown`): في المخزن − محجوز =
  متاح │ المطلوب ← الناقص + أمان = يُشترى. Each number is its own chip with the operator
  between, so no sign is mixed into RTL prose. The arrow flips with the language.
- **Notices are quiet lines with a drawn icon** (`.dpx-note`); the leading emoji in the
  `dpNotice*` strings is stripped at render, not edited out of the strings.
- Product placeholder is a drawn icon with the photo laid over it (a failed load removes
  the `<img>`), instead of a 📦 emoji.

Verified in Chrome against the real `index.html`: light, dark and 390px mobile — the
headline, block split and tab counts agree with the pivot, no page errors, no overflow.

**Round 2–3 (same day).** ⚠ The panel carried `direction:rtl`, which reversed every English
sentence; it now inherits the document direction. ⚠ Headers were `text-align:right` while
cells followed the document — alignment is now declared on `th` AND `td` together (measured
0–2px in both languages). The modal is a centred ~1120px window (full-screen only ≤820px).
English plurals go through `_dpPluralW` and `{ordersW}/{itemsW}/{unitsW}` placeholders that
the Arabic strings simply do not use.
- **Loading:** `_dpRunAnalysis` opens the window at once in `.is-loading` with a skeleton
  shaped like the answer, and puts the clicked button in a busy state. ⚠ `_dpLoading`
  makes it single-flight — a second click during the request started a duplicate
  analysis (verified: 1 request). On failure the window closes rather than leaving a
  skeleton standing in for an answer that is not coming. Entry points take the button:
  `openShopifyDemandPlanning(this)`.
- **Tabs:** one `.dpx-ink` underline slides to the active tab (`_dpMoveInk`, measured from
  `offsetLeft`, so RTL/LTR both work); panes fade in. Reduced motion disables both.
- **PO dialogs:** their buttons used `.bd-actions`, whose spacing exists only inside
  `.bulk-discount-panel`, so they sat flush against the items box. Now `.dpx-dlg-actions`.

---

## The Printed Invoice — Rebuilt Again, Customer-First (Oct 5, 2026)

Sheet 1 of `buildInvoiceHtml` was redesigned with the owner from a canvas mock-up
(`.iv-*` classes). The policy sheet, `amountToArabicWords` and every call site are
unchanged. **This supersedes parts of "The Printed Invoice — Rebuilt as an A4
Commercial Document" below** — read the reversals before restoring anything from it.

### A real bug: every sales invoice said «لم يُحصّل أي مبلغ»
`paid` came from `exchangeSalePaidDisplayAmount(tx)`, which returns **`fmtJ()` HTML**,
not a number — so `paid > 0` was always false on a sale. Invoice #2545 (300 deposit
on فودافون كاش, 2,130 due) printed "nothing collected" directly above a balance that
had already subtracted the 300. `paid` is now numeric, using that helper's own
exchange-sale rule. ⚠ **Never compare the output of a `fmtJ`-based helper as a number.**

### Reversed on purpose (owner's decision)
- **The terms strip is gone.** «شروط الدفع» printed the same value as «طريقة السداد»,
  and «رقم التتبع» printed `tx.pickupRef` — the **prep-group** ref (601-12SEP), not a
  carrier tracking number. The shipping zone code (`gov`) is internal. The carrier
  now rides on the address label («الشحن مع Bosta»).
- **The signature block is gone**, and so is the operator's name from the footer —
  an internal fact that stays on the transaction.
- **No «SOULIA» beside the logo.** `_invIssuerHtml` no longer falls back to the brand
  name; a legal name that *differs* from the brand still prints when set.

### What the sheet states now
Logo · title · number/dates row · اسم العميل / الهاتف / عنوان التسليم · items with a
**product photo** (`_pwItemImgUrl`: line snapshot first, then the catalogue), qty,
unit price and total · totals + التفقيط · a **payment strip**: total / paid (+ method)
/ remaining. The chip is derived from the money, never from `payStatus`:
`unpaid` (paid 0) · `partial` · `full` (nothing remaining) · `cancel`.
- The method shows only when something was paid. A purchase settled from supplier
  credit names «الرصيد لدى المورد», never a vault.
- ⚠ **A failed photo removes its `<img>`** and the placeholder icon beneath it shows —
  never a broken-image glyph on a customer document.
- ⚠ **`_invPrintTrigger()` replaced the fixed 400/500ms `print()` timers** in
  `printInvoice` and `bulkPrintPDF`: it waits for the images and the web font, capped
  at 4s so a dead URL can never block printing. A fixed timer printed empty thumbnails.
- Font is IBM Plex Sans Arabic for the whole printed document (both sheets).
- ⚠ The CSS lives inside a JS template literal — **no backticks in its comments.**

### Verification
Five invoices rendered through the SHIPPED functions in Chrome (sale partly paid / fully
paid / unpaid, purchase, cancelled): each fits one A4 sheet, no overflow, no errors, the
correct chip and cells. `amount-to-words.spec.ts` 24/24.

---

## Bosta AWB Prints at Its Real Size — A6 (Oct 5, 2026)

The backend requests `requestedAwbType:'A6'` and re-requests when the cached copy
(`bostaAwbType`) is from an older size. The print side was the gap: the PDF opened in
the browser viewer, whose print dialog falls back to the printer's default paper
(A4) and "fit to page", so the label came out scaled.

`printBostaAwb` now renders the PDF with **pdf.js (cdnjs 3.11.174, lazy-loaded)** at
300dpi and prints from a page with `@page{size:<PDF's own size>;margin:0}`, one label
per page, 1:1.
- ⚠ **The size is read from the PDF, never hardcoded**, then snapped to the nearest
  standard (A6 105×148, 100×150, 4×6", A5, A4) within 1.5mm. PDF points round A6 to
  105.2×148.2mm, and that sliver makes some thermal drivers print a blank second label.
- ⚠ pdf.js gets `bytes.slice()` — it can detach the buffer, and the fallback needs it.
- If pdf.js cannot load (offline), it falls back to the raw PDF as before; the user
  then picks «الحجم الفعلي / Actual size» in the print dialog.
- Verified in headless Chrome on the code in `index.html`: an A6 PDF → `@page{size:105mm 148mm}`.

### «خطأ غير متوقع في الخادم» on print — Bosta's reason was being swallowed
`getAwb` rejected its https promise with a plain `Error` on any non-2xx or unparseable
reply, and the global filter turns every non-`HttpException` into a generic 500. Now:
- `requestAwbPdf` makes one call; `getAwb` converts every failure into a
  **`BadRequestException` carrying Bosta's message** and logs each attempt.
- Per Bosta's docs (`/docs/how-to/print-awbs`): `requestedAwbType` is `"A6"` (Zebra)
  or `"A4"` (original), `lang` is `"ar"`/`"en"`; send trackingNumbers OR ids.
  Attempts: **A6/ar → A6/en → A4/ar**; the type received is cached in `bostaAwbType`
  and returned as `awbType`, and the UI toasts when it is not A6.
- If every attempt fails but an older cached copy exists, that copy is returned.
- 5 cases in `test/unit/bosta-awb.spec.ts`. ⚠ It stubs `require('https').request` —
  `jest.spyOn` on an `import * as https` namespace throws «Cannot redefine property».

### The «جارٍ تحميل بوليصة الشحن…» wait
Measured cold, all in sequence: Bosta ~600ms (first print of an order only) + pdf.js
load 250ms + worker start 290ms + `toDataURL` 120ms. Now:
- **`_awbWarm()`** loads pdf.js and one long-lived `PDFWorker` at idle time, called from
  both templates that draw the «طباعة بوليصة Bosta» button. Render: 643ms → **83ms**.
- The label request and the pdf.js load run **in parallel**; `toBlob` + blob URLs
  replace `toDataURL`; the tab prints when its images load, not on a fixed timer.
- `_awbBytesCache` keeps an A6 label per order for the session (reprint = no request).
- **`createOrder` prefetches the label** 4s after a shipment is created
  (`setTimeout` → `getAwb`, never awaited), so even the first print is a cache hit.
  ⚠ Shipments created before this have no cached label until their first print.

### Print log, reprint warning, and «prepared → Bosta → print» in the prep workspace
- **`tx.bostaAwbPrints [{at, by, byId}]`** (`@Prop({type:[Object]})`), appended by
  `POST /shipping/awb/:id/printed` → `recordAwbPrint`. ⚠ The client calls it when the
  print page is READY (`_awbRecordPrint`), never on fetch — the server prefetches labels.
- One log feeds: the timeline step «طباعة البوليصة» (`stepAwb` in
  `buildOrderTimelineSection`, one sub-line per print, counted in the step badge),
  `_awbPrintedMarkHtml` in `_movShipCell` (عمود الشحن), `_pwAwbChipHtml` on prep cards,
  and the reprint warning (`_awbConfirmReprint` → `showConfirm` with date/by/count).
  `printBostaAwb(id, {skipWarn})` now resolves **true/false**.
- **`_bsfMaybeOffer(o)`** — the `#bsf-overlay` dialog (z 1450): ask → sending → sent
  (tracking + «طباعة البوليصة») → printed → closes ~1.4s after the window regains
  focus. Called from BOTH tick paths (`pucoTickOrder`, `puCardPrepTick`) via
  `setTimeout 0` so the list has already advanced. Only for Bosta orders
  (`carrierCode` integration, or a legacy `shipCo` naming Bosta); an order already
  sent but unprinted opens at the print step; sent + printed → no dialog.
  ⚠ The all-prepared «move to Ready» waits on `Promise.all([savePrepCheck, bostaFlow])`.
  ⚠ The prep keydown listener bails while `#bsf-overlay` or a confirm dialog is open.
- ⚠ **`createOrder` moves the order to `Ready` on the server**, so a prep group can
  hold Preparing+prepared AND Ready orders. `confirmPickup` accepts that mix
  (`mixedPreparedAndReady`, an `$or` filter) and still refuses an unprepared order.
  Locally the sent order is NOT moved to Ready, so it stays in its group.
- Tests: `bosta-awb.spec.ts` (+`recordAwbPrint`), `confirm-pickup-mixed.spec.ts` (3).
  18 browser assertions over the shipped `index.html` (dialog states, A6 label, log
  write, both in-memory copies, no repeat offer, non-Bosta skip, reprint cancel, marks,
  timeline).

### Round 3 — printing moved IN-PAGE; the mark moved to the Bosta column
- ⚠ **The label is printed from a hidden `<iframe>` in this page, never a new tab.**
  With a tab, this window went to the background as the tab opened, Chrome throttled
  it, and the tab sat on «جارٍ تحميل بوليصة الشحن…» until the user switched back.
  `_awbPrintInFrame` writes the label page into the frame, waits for the images to
  decode, calls `print()`, and resolves on **`afterprint`** — that is when the
  «تمت طباعة البوليصة» toast shows and the print is logged. Only the pdf.js-offline
  fallback still opens a tab.
- **`_awbPrepare(id)`** fetches + renders into blob images and is cached as a promise,
  so hover (`onpointerenter="_awbPrepareSoon(id)"` on every print button), the prep
  dialog's «sent» step and the click share one piece of work. Measured: prepared →
  **24ms** click-to-dialog; cold with a 150ms server → ~240ms.
  `_awbForget(id)` drops the cache whenever an order is (re)sent — a new shipment has
  a new label. `_awbPrinting` makes a double click open one dialog.
- The printer mark is in **عمود Bosta** (`.mov-bosta-line` beside `_bostaStatusBadge`),
  no longer in Shipping.
- Dialog motion: the card springs in; between steps its height morphs (`.is-morph`)
  and the new step's parts rise in staggered (`.bsf-in`); the success check draws
  (`pathLength=1` + dash); a send→sending / sent→printing toggle does NOT replay the
  entrance (`.no-enter`). The «printed» step runs a 1.6s bar, then closes. All of it
  is off under `prefers-reduced-motion`.
- 26 browser assertions (adds: no tab opened, image decoded before `print()`, timing,
  toast, confirmed reprint, double click, mark in Bosta not Shipping).

### Round 4 — «سجل الشحنة»: every shipment action in the timeline, live
- ⚠ **The bosta* fields cannot tell the story.** A deletion at the carrier wipes
  `bostaOrderId` (four paths: status-sync 404, a delivery update with `isDeleted`,
  admin «mark deleted», the city-fix tool) and a resend OVERWRITES the tracking
  number — so a deleted-and-resent order looked like it was only ever sent once.
- **`tx.shipmentEvents`** — append-only `{type, at, by?, source?, trackingNumber?,
  bostaOrderId?, prevTrackingNumber?}`, `type` ∈ sent | resent | deleted | cancelled
  | printed. Written by `shipEvent()` in every path: `createOrder` (sent/resent —
  decided BEFORE it clears the fields; a resend records the label it replaces),
  all four deletion paths via **`deletedEventPush()`** (only on the transition INTO
  DELETED, so a repeated sync never duplicates it), `cancelOrder`, `recordAwbPrint`.
  `markAsDeleted` / `cancelOrder` now take the operator's name from the controller.
- Timeline: the print-only step became **«سجل الشحنة»** (`_shipmentLogOf` +
  `_SHIP_EV_META`, an icon per event; red + badge «محذوفة» when the last event is a
  deletion). Rows written before the log existed are reconstructed from what survives
  (current shipment, a DELETED status, `bostaAwbPrints`).
- Prints now carry `trackingNumber`, and **`_awbPrintsOf` counts only prints of the
  current label** — after a resend the new label is not «printed before».
- ⚠ **Live sync was broken for every Bosta event**: BostaService emits `tx:updated`
  with `{ _id }` only, and the socket handler returned when `payload.tx` was missing.
  **`_rtFetchTx(id)`** now refetches (coalesced per id, 250ms), merges into both
  in-memory copies, and repaints the table, an open invoice and the prep workspace.
- Tests: `bosta-shipment-events.spec.ts` (7 — incl. sent vs resent through the real
  `createOrder`, no duplicate deletion), 11 browser assertions (order of events,
  legacy reconstruction, per-label prints, a burst of id-only updates → one repaint).

### Round 5 — the search result states the order's REAL state
- The order chip in the header search was `bostaStatusLabel` alone. A shipment
  deleted at Bosta keeps «محذوف من Bosta» forever, so an order back to Ready (or
  already resent and moving) read «Deleted».
- **`_gsOrderStatus(item)`**: cancelled → «ملغي»; a live shipment → its Bosta status;
  otherwise the order's own stage via **`_puDisplayStatus`** (the Movements-table
  rule — Pending / Preparing / Ready / Shipped / Delivered, or «re-ship attempt N»).
  A deleted / rejected label is a quiet note beside the chip, never the status.
  It reads the **live in-memory row first** (follows socket updates), else the
  fields the server now returns: `orderItem` adds `bostaStatus`, `hasShipment`,
  `pickupStatus`, `deliverySource` (all four search `select`s carry them).
- `_SEARCH_BOSTA_LABEL_EN` and the label→colour map were deleted (no caller).
- 11 browser assertions incl. the reported #1973 pair and a deleted-then-resent row.

## Comments — Clickable Links, @ and Product Mentions (Oct 5, 2026)
- **`renderMentionText(text, {mentions})`** is the one comment renderer (invoice page
  and modal, new-transaction form, Shopify order panel, and now the prep workspace
  thread + customer note, which used bare `esc()`). One tokenizer
  (`_CMT_TOKEN_RE`) → product token | URL | @mention; every other run is escaped.
  ⚠ Links are http(s) only (`www.` → https), trailing punctuation stays outside,
  `target=_blank rel=noopener noreferrer nofollow`, `stopPropagation` so a row's
  own click never fires. `{mentions:false}` for a customer note (`@` means nothing).
- **Product mention = `[📦 Name](product:KEY)`** in the stored text — plain and
  readable wherever a comment is shown raw (notifications, exports), drawn here as
  `.cmt-prod`. KEY is the product code, or `id:<_id>` when the code holds a space
  / `)` / `]` (`_pmpKey`). Click → `cmtOpenProduct` → `openInventoryDetail` (المخزن),
  else the product modal; an item no longer found is struck through.
- **Composer tools** (`_cmtToolsHtml(inputId, ctxId)`): «@» inserts `@` and opens the
  existing people list; the box icon opens **`openProductMentionPicker`** — search
  over `inventoryCache` (live balance «متاح N / نفد»), catalogue fallback; ↑/↓/Enter/
  Esc; inserts the token at the saved caret. On all four composers; the static
  new-transaction form fills its slot (`data-cmt-tools`) on DOMContentLoaded.
- ⚠ `selectMention` now writes into **`_mentionAnchorInput`** (the input that opened
  the list) — the prep composer (`pw-cmt-text-…`) had no @mentions before.
  `pwCommentKeydown` hands ↑/↓/Enter/Esc to the list while it is open (Enter picks
  the first person instead of sending).
- The server stores comment text verbatim (no sanitising), so nothing strips tokens.
- 21 browser assertions: links, `javascript:`/markup/quote injection, chips, «@»
  button + Enter, picker stock/filter/insert, code-with-space → id, chip → المخزن.
- **Round 2:** the composer tools are a labelled bar ABOVE the field
  (`.cmt-bar`: «مستخدم / User», «منتج / Product») — inside the input row they pushed
  the send button onto its own line. The product chip draws its own `<img>` over a
  box icon (a broken URL removes the img), photo resolved with **`_pwItemImgUrl`**
  like the prep workspace — `productThumbHtml`'s own sizing fought the 24px slot and
  rendered a cropped oval. Product = warm/orange tint, person = brand-green pill
  with «@»; the old `.mention-chip` rule (line ~2845) was removed so one definition
  owns it. 9 browser assertions (bar above, send on the row, 24×24 photo loads,
  distinct tints, both buttons, Arabic labels, dark mode).
- **Round 3 — the product preview returns to the comments.** A chip used to call
  `openInventoryDetail`, i.e. `openModal()`, which REPLACES `#modal-overlay` — the
  Shopify comments window lives there, so clicking a product threw the comments away.
  `cmtOpenProduct` now opens **`#cmt-pv`**, its own layer (z 100002) over every modal:
  photo, name, code, stock, price, material / size / colours, and «رجوع للتعليقات».
  Back button, Esc (capture phase + `stopImmediatePropagation`, so the window under
  it does not close on the same key) and the backdrop all close only the preview;
  focus returns to the chip. ⚠ Never route a comment's product click through
  `openModal` again. 10 browser assertions, run inside the real shared modal.

---

## Order Toasts & Sounds — `.stz-*`, Cha-ching, Wood Tap (Oct 5, 2026)

The two live-event toasts were rebuilt from the design canvas, and two sounds replaced —
each chosen by the owner from a listening page before anything in the app changed.

### The assignment toast (`mentionNotifier._toast`) and the status row (`_rtToastEvent`)
The «New task — Order Distribution» toast was a purple gradient box in the **centre of the
screen** printing the server's Arabic sentence verbatim — so the Arabic customer name sat
inside an English sentence and reordered, and `#2695` appeared twice. The «🚚 Delivered: 1
order(s)» pill named no order at all.

Both now live in one region, `#soulia-toast-region`, bottom-end corner (left in RTL), newest
nearest the corner, above the mobile nav below 768px.
- **Assignment card**: order ref + total as the headline, customer · assignee beneath,
  **Dismiss / Open order**, an 8s drain bar. The server body is **parsed** (`_bodyField`
  reads `العميل:` / `الإجمالي:`), never printed as a sentence.
- **Status row**: tone disc (ok / info / warn / bad) + title + «#ref · customer» + optional
  action. `_rtToastEvent` now takes `{tone, icon, title, sub, action:{label, fn}}`; a plain
  string still works for any old caller. `_stzRefsSub(ids)` builds the sub-line.

⚠ **«Open order» goes through `onMentionNotifClick`**, the same routing as the bell list.
The old toast called `showInvoiceDetail(payload.txId)` — but an assignment's `txId` is a
**ShopifyOrder** id, so clicking it opened nothing. Pre-existing bug, fixed here.

⚠ **Auto-close pauses on hover and focus** (`_stzArm`), and hidden cards get `hidden` after
the fade so they stop taking space — `.stz[hidden]{display:none!important}` must stay.

⚠ **`sub` is inserted as HTML** — every value in it must already be `esc()`-ed and wrapped in
`<bdi>`. `_stzRefsSub` does both; a new caller must too.

### Sounds — metal means «new order», wood means «cash moved»
- **New order** (`_chaChing`, called via `_chime('order')` only when the sender is
  «نظام التوزيع» and the first line says «مُسند»): drawer rattle + a register bell struck
  twice. Synthesized in the spirit of Shopify's order sound — **not** Shopify's audio file.
  Other mentions keep their old chimes so the two can be told apart.
- **Vault** (`_cashPlaySound`): two marimba notes, rising for money in, falling for money out.
  The old money-in sound was a cash-register «ka-ching» that **collided by ear with the new
  order sound** — which is why it was replaced. Keep the families apart.
- Both master levels (0.63 / 0.55) are the levels approved in the preview pages. Mutes are
  unchanged: `mentionnotif_muted` and `cash_pulse_sound`.

### Verification
Shipped functions rendered in headless Chrome: both toasts in light/LTR and dark/RTL, no
overflow, hover pause holding past the timeout; both sounds rendered offline with no error
and no clipping (peaks 0.42 / 0.24 / 0.20). **Not yet observed in the logged-in app.**

---

## «سجل عمليات التحقق» Followed the User Onto Every Page (Sep 8, 2026)

Reported as: open الموافقات → «سجل عمليات التحقق» → leave the page, and the OTP
panel stays painted on every page visited afterwards (the screenshot shows it
sitting under الموردون).

### The panel was never inside the approvals page
`#appr-tab-otp-content` was a **top-level sibling** of `#page-approvals`, not a
child of it. Three `</div>` were written where two belong — closing the hub table
wrapper, closing `#appr-tab-hub-content`, and then one extra that closed
`#page-approvals` 76 lines early. The block that followed it was left orphaned
between `page-approvals` and `page-reports`.

⚠ **The markup was perfectly div-balanced, which is why this survived.** Every
page counted `open == close`; the *extra* close was matched by the orphan's own
closing tag. A balance check finds nothing — the only thing that detects it is
asking whether the panel is a **descendant** of the page that owns it.

### Being an orphan is what made it leak
Page visibility is `.page{display:none}` / `.page.active{display:block}` (~line
4919). The orphan carries no `.page` class, so **that rule never applied to it**
and its only hiding mechanism was its inline `style="display:none"`.

`switchApprTab` then does:

```js
qs('#appr-tab-otp-content').style.display = tab === 'otp' ? '' : 'none';
```

⚠ **`''` deletes the inline declaration** rather than setting a value. On a
correctly-nested panel that is harmless — the parent page's `display:none` still
hides everything inside it. On an orphan there is no parent rule to fall back
to, so clearing the inline style left the block permanently visible, on every
page, until a reload. Measured: **327px tall on الموردون, المصاريف and دليل خدمة
العملاء alike.**

Both halves are fixed: the stray `</div>` moved to after the OTP block (which now
closes `#page-approvals`, tagged `<!-- /#page-approvals -->`), and both
`switchApprTab` and `switchCspTab` now write **`'block'`, never `''`** — the
convention `switchMovTab`/`switchInvTab` already follow.

⚠ **`.csp-tab-content` has no CSS rule of its own** either, so `switchCspTab`
carried the identical `''` defect. Its panels *are* correctly nested, so it never
leaked — the change there is defence against the same trap, not a bug fix.

### Verification
- **Before/after in a real browser** (Chrome, the actual `index.html` and the
  actual `switchApprTab`, never a copy) over the reported path: the committed
  build paints the panel at **327px on all three other pages**; the fix gives
  **0px** on all three while keeping it visible on الموافقات.
- **6 tab clicks** (including repeats and revisits): exactly one panel visible
  each time, with the matching `.s-tab.active`.
- The shipped file **loads with no new console error** and `page-approvals` now
  `.contains()` the OTP block — the one measured difference against HEAD.
- Swept the remaining 5 between-page orphans: all are `position:fixed` modal
  overlays or print-template strings, which belong outside a page.

---

## Recent Changes Summary

| Date | Change | Impact |
|------|--------|--------|
| Oct 7, 2026 | Automatic Bosta settlement: each delivery books the net of Bosta's real fee a minute after DELIVERED; older orders settle by selection; review queue over a 20 EGP overcharge; «كشف حساب بوسطة» with transfers and fees; order timeline reordered by real time (291 → 0 out-of-order) | See "Automatic Bosta Settlement" above |
| Oct 5, 2026 | Stock Demand Analysis rebuilt answer-first: «N of M orders ready» with per-order blocks + what to buy and the PO button, a coverage bar per product, the calculation as one chip chain; presentation only | See "Stock Demand Analysis — Rebuilt Answer-First" above |
| Oct 5, 2026 | Printed invoice redesigned customer-first: product photos, a total/paid/remaining strip with a payment chip derived from the money; removed the terms strip, signatures and duplicate brand name; fixed every sale printing «لم يُحصّل أي مبلغ» (paid was fmtJ HTML compared as a number) | See "The Printed Invoice — Rebuilt Again" above |
| Oct 5, 2026 | Order toasts rebuilt (assignment card + status row, bottom-end, no emoji, real order/customer named) and «Open order» fixed — it opened a ShopifyOrder id as an invoice; new-order sound → cha-ching, vault sound → wood tap so the two never collide | See "Order Toasts & Sounds" above |
| Oct 5, 2026 | Shopify orders: product photos finally render (they read an image field inventory never has), stock badges + have/need popover, optional phone line, wider search, and the order # opens a quick view with the follow-up trail instead of leaving the page | See "Shopify Orders — Photos, Stock, Phone Toggle, Order Quick View" above |
| Sep 8, 2026 | «سجل عمليات التحقق» stayed painted on every page after being opened once — the panel was an orphan outside `#page-approvals` (one stray `</div>`), so `.page{display:none}` never covered it and `style.display=''` left nothing to hide it | See "«سجل عمليات التحقق» Followed the User Onto Every Page" above |
| Sep 8, 2026 | Prep workspace: the customer note lost its permanent amber tint, comment timestamps became short and language-aware (`now · 25m · Sat 20:23`) and moved under the text, and author photos were fixed — a comment stored under a username never matched its author, and the mention card showed a generic @ icon instead of the sender | See "Round 7 — ملاحظة محايدة، وقت مختصر" above |
| Sep 8, 2026 | Prep workspace: notes/comments moved into their own scrolling side column (`.pw-body2`) — they used to span the full header width while the area beside the items sat empty — and the @mention path from the new composer was verified end to end | See "Round 6 — عمود جانبي للتعليمات" above |
| Sep 8, 2026 | Prep workspace: un-collapsed the notes — a packing instruction behind a click is an instruction that did not arrive — plus a compacted header (name+phone on one line, status/carrier/employee as plain text, chips kept only for money) and an inline comment composer on the same path as the invoice | See "Round 5 — التعليقات مرئية دائماً" above |
| Sep 8, 2026 | Prep workspace: product photos never rendered (every line read the empty `imageUrl` snapshot instead of falling back to the live catalogue), and the notes/comments panels were moved out of the header body into a small amber-tinted `<details>` chip so the picking grid leads | See "Round 4 — product photos, comment photos, notes into the header" above |
| Sep 8, 2026 | Shopify table: the الإجراء cell was 176.5px of controls in a 148px column and overflowed at every viewport but one; the header applied Latin uppercase + letter-spacing to Arabic (breaking its cursive joins); tags all rendered as one grey pill; the الخصم column reserved 124px for a badge that usually renders 43px (the code is now a fixed-width mark, column 124→84, applied to سجل المعاملات too); and the الأصناف popover closed when you scrolled it | See "Shopify Table — Action Column, Discount Badge, Header Type, Tag Tone, Items Popover" above |
| Sep 8, 2026 | Shopify page: added a standalone «مميّزة» (starred) filter that intersects the four operational filters instead of replacing them, and fixed the date-filter popover, which was clipped by the table card's `overflow:hidden` AND trapped by `.page`'s animated transform | See "Shopify Orders — Operational Filters + Shared Columns" above |
| Sep 8, 2026 | Shopify page: replaced the KPI strip + status chips + priority row with four operational filter cards that each carry their own KPIs (مدفوع ديبوزت / بدون عربون / ملغية / متعطل على المخزون), and folded الأصناف / الشحن / الخصم into the components سجل المعاملات already uses | See "Shopify Orders — Operational Filters + Shared Columns" above |
| Sep 8, 2026 | Prep Group Orders rebuilt as a two-panel picking workspace: large product images and an unmissable read-only QTY replace a 6-column table whose qty was a pill between two prices; ↑/↓ order navigation; the modal now uses the viewport | See "Prep Group Orders — Rebuilt as a Picking Workspace" above |
| Sep 8, 2026 | Dashboard opened on a white page: the splash faded on a 1.6s timer unrelated to the data, `bostaRawResponse` was 77% of the boot payload (9.45→1.68 MB), and two awaits blocked the first paint; plus staged reveal animations and an «آخر تحديث» button | See "The Dashboard Opened on a White Page" above |
| Aug 28, 2026 | Four of six registered Shopify webhooks were being thrown away with 200 OK; plus the address of an already-shipped order was silently overwritten on the invoice while Bosta still held the old one | See "Shopify Webhooks — Four of Six Were Thrown Away" above |
| Aug 28, 2026 | Rebuilt the printed sales/purchase invoice as a formal A4 commercial document: real issuer block (7 new company settings), التفقيط, signature block, declared `@page` geometry, repeating table header, and the terms already stored but never printed | See "The Printed Invoice" above |
| Aug 28, 2026 | Fixed the date-window bug the drill-down exposed: `date` is stored as a full ISO timestamp on 63% of transactions, and bytewise `<=` dropped the last day of every report period (June purchases read 22,860 instead of 61,300). Six read sites + two day-bucketing defects; measured purely additive (+1 row, −0) | See "The Date-Window Bug" above |
| Aug 28, 2026 | KPI cards المصاريف / المشتريات / المرتجعات now open the rows behind their number, each list ending in a proof line that it sums to the card; its proof line immediately exposed a real backend date bug (fixed, row below) | See "KPI Drill-Down" above |
| Aug 28, 2026 | Backup restored no employee accounts — `users` was captured then skipped by both restore paths, so a restore produced full history with no logins and a Performance Hub of unresolvable ids; plus a nightly 3 AM auto-backup (there was none) keeping the last 10 | See "Backup Lost Every Employee Account" above |
| Aug 28, 2026 | Carrier registry: shipping company became a stable `code` bound to every sale, the tariff is frozen on the transaction, and Shopify's confirm dialog now asks which carrier ships the order — it never recorded one, so the whole Shopify volume sat in the «غير محدد» bucket of a shipping report that was already written | See "Carrier Registry — `CARRIERS`" above |
| Aug 28, 2026 | Structured cancellations: both cancel paths (شوبيفاي / سجل المعاملات) now take a coded reason from one shared list instead of free text, the dialogs state the vault/stock impact before the click, and a new «الإلغاءات» reports tab counts reasons and separates cancelled-before-entry from cancelled-after | See "Structured Cancellations" above |
| Aug 27, 2026 | Vault entries on edit now follow cash actually settled (`deposit`) instead of `payStatus` — a zero-total invoice saved as «مكتمل» and deducted its full new total on the next edit for a payment that never happened (#900001) | See "The Vault Followed `payStatus`, Not Cash" above |
| Aug 9, 2026 | Shopify orders now write to سجل حركة المخزون — `approveOrder` bypassed `TransactionsService.create()`, so the stock balance moved but no movement row was ever logged; plus an admin backfill for affected refs | See "Shopify Sales Were Missing From سجل حركة المخزون" above |
| Aug 8, 2026 | Fixed the deploy-breaking crash: a nullable `@Prop` with no `type` killed NestJS at module load, so every request — including login — failed while the build reported success | See "A Nullable `@Prop` Without `type` Kills the Whole API" above |
| Aug 8, 2026 | Trust hardening: "failed to load" split from "no data" (`LOAD_FAIL`), silent @mention failures surfaced, `beforeunload` added app-wide, product modal given real unsaved-changes protection, boot cut from 8 sequential round-trips to 1 | See "Trust & Data-Loss Hardening" above |
| Aug 8, 2026 | `NAV_TRAIL`: back buttons now name and return to where you actually came from, replacing hardcoded destinations; the three one-way links (Shopify→متابعة, vault→invoice, ledger→vault) got a return path | See "Navigation Trail — `NAV_TRAIL`" above |
| Aug 8, 2026 | Reports charts rebuilt on `REP_VIZ`: validated light/dark palette, two 3-bar charts → one waterfall, and «المنتجات الراكدة» fixed — it could never contain a zero-sale product | See "Reports Charts — Rebuilt as a Design System" above |
| Aug 8, 2026 | Customer returns Phase 0: wired the dead validation service, bounded the refund, made reversal visible to reports, allowed partial returns, and stopped damaged goods re-entering stock | See "Customer Returns — Phase 0 Hardening" above |
| Aug 8, 2026 | Nine job permission presets (`JOB_TEMPLATES`) replace the strip that duplicated the role cards; job titles get Arabic labels + optgroups with English values preserved | See "Job templates" / "Job titles" above |
| Aug 8, 2026 | Vault log table 11 → 9 columns: duplicate `SEGMENT` merged away, running balance added (admin-only), backdated entries revealed, amount made the hero column, header/body fully localized | See "Vault Log Table — Rebuilt Around the Amount" above |
| Aug 8, 2026 | User modal rebuilt: fixed head/foot + two tabs, role cards replace a `<select>` whose option icons never rendered, permission modules tinted by grant state | See "User Modal — Rebuilt as a Three-Band Frame" above |
| Aug 7, 2026 | Supplier account permissions: 12 fine-grained `suppliers-*` perms; closed the unguarded supplier-payment endpoint; tabs hide, actions disable | See "Supplier Account Permissions" above |
| Aug 7, 2026 | Purchase settled from supplier credit is now stated on the invoice (both renderers) instead of showing a fabricated «كاش» payment | See "Supplier Credit on the Invoice" above |
| Aug 7, 2026 | Product modal no longer closes on backdrop click (X/Cancel only) + "نسخ الصنف" duplicate action | See "Product Modal — Dismiss Lock & Duplicate" above |
| Aug 7, 2026 | Product palette 9 → 31 colors (Orange/Burgundy/Dark Green/Off White/Baby Blue + 17 more) and a new `features` multi-select (Waterproof, Anti Slip, …) | See "Product Palette & Features" above |
| Aug 7, 2026 | Global search relevance ranking — scored engine replaces boolean match + hardcoded section order; fixed 50-result DB-order truncation | See "Global Search — Relevance Ranking" above |
| Aug 6, 2026 | Offline archive export ("نسخة كاملة") on all 20 resources — multi-sheet Excel; fixed dead `exportToExcel` + clients-CSV OTP bypass | See "Offline Archive Export" above |
| Aug 6, 2026 | Forced update dialog on every deploy — CI-driven `/version.json` + `no-store` on the shell | See "Forced Update on Deploy" above |
| Aug 6, 2026 | Categories permissions: 6 fine-grained `categories-*` perms, 17 backend routes guarded, deep-link + popstate perm holes closed | See "Categories Permissions" above |
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
