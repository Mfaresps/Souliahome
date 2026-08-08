# SOULIA Warehouse Management System - Technical Documentation

## Project Overview
SOULIA is a comprehensive warehouse management system built with NestJS (backend) and vanilla JavaScript (frontend). The system manages transactions (sales/purchases/returns), inventory, expenses, and vault/treasury accounts.

---

## UI Standing Rules

### Search Boxes — Always Small, Simple Text (Jul 30, 2026)
All search inputs across the app (placeholder starting with "بحث") must keep small, simple text — no large or bold placeholder/value fonts. Enforced globally via `input[placeholder*="بحث"]` CSS rule near line 916 in `frontend/public/index.html`. Any new search box automatically inherits this; don't override it with a larger font-size.

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

## Recent Changes Summary

| Date | Change | Impact |
|------|--------|--------|
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
