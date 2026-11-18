/**
 * Inventory overview (Nov 15, 2026) — what each product's stock balance is made of.
 *
 * Data: GET /transactions/inventory/breakdown (backend/src/transactions/inventory-breakdown.ts).
 *   In stock  (في المخزن)       = balance + reserved
 *   Reserved  (محجوز لطلبات)    = confirmed sales still waiting for the carrier
 *   Needs attention (يحتاج مراجعة) = damaged + lost + awaiting inspection still inside the balance
 *   Ready to sell (صالح للبيع)   = max(0, balance − needs attention)
 *   Incoming  (وارد)            = purchase orders not received yet
 * Unconfirmed Shopify orders are not counted anywhere (owner's decision).
 * Display only: the balance itself (`current`) is unchanged.
 */
(function () {
  'use strict';
  const tr = (en, ar) => (typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar);
  const e = value => (typeof esc === 'function' ? esc(value) : String(value ?? ''));
  const n = value => (typeof fmtN === 'function' ? fmtN(value) : String(value));
  const state = { data: null, status: 'idle', request: null, timer: 0, pop: null };

  const TERMS = {
    ready: ['Ready to sell', 'صالح للبيع'],
    onHand: ['In stock', 'في المخزن'],
    reserved: ['Reserved for orders', 'محجوز لطلبات'],
    reservedShort: ['Reserved', 'محجوز'],
    issue: ['Needs attention', 'يحتاج مراجعة'],
    damaged: ['Damaged', 'تالفة'],
    lost: ['Lost', 'مفقودة'],
    inspection: ['Awaiting inspection', 'بانتظار الفحص'],
    incoming: ['Incoming', 'وارد'],
  };
  const term = key => tr(...TERMS[key]);

  const STATES = {
    negative: { tone: 'bad', label: ['Negative balance', 'رصيد سالب'], sub: ['Count needed', 'يحتاج جرد'] },
    'inactive-stock': { tone: 'quiet-warn', label: ['Discontinued', 'متوقف'], sub: ['Still has stock', 'وما زال به رصيد'] },
    inactive: { tone: 'quiet', label: ['Discontinued', 'متوقف'] },
    out: { tone: 'bad', label: ['Out of stock', 'نفد'] },
    low: { tone: 'warn', label: ['Low stock', 'منخفض'] },
    ok: { tone: 'ok', label: ['In stock', 'متوفر'] },
  };

  /** Tabs: key → [en, ar]. `low` (old key, still used by the dashboard link) maps to `reorder`. */
  const FILTERS = {
    all: ['All', 'الكل'],
    ready: ['Ready to sell', 'صالح للبيع'],
    reorder: ['Needs a purchase order', 'يحتاج طلب شراء'],
    issue: ['Needs attention', 'يحتاج مراجعة'],
    negative: ['Negative balance', 'رصيد سالب'],
    inactive: ['Discontinued', 'متوقف'],
    reserved: ['Reserved for orders', 'محجوز لطلبات'],
    incoming: ['Incoming', 'وارد'],
  };

  const location = () => document.getElementById('wh-inventory-filter')?.value || '';

  function slice(row, allWarehouses) {
    const entry = state.data?.[String(row._id)];
    const out = { reserved: 0, damaged: 0, lost: 0, inspection: 0, orders: [] };
    if (!entry) return { ...out, incoming: 0, pos: [] };
    const where = allWarehouses ? '' : location();
    for (const [code, w] of Object.entries(entry.byWarehouse || {})) {
      if (where && code !== where) continue;
      out.reserved += w.reserved || 0; out.damaged += w.damaged || 0; out.lost += w.lost || 0; out.inspection += w.inspection || 0;
      out.orders.push(...(w.reservedOrders || []));
    }
    return { ...out, incoming: entry.incoming || 0, pos: entry.incomingOrders || [] };
  }

  /** Every figure the page shows for one inventory row (already scoped to the chosen warehouse). */
  function facts(row, opts) {
    const balance = Number(row.current) || 0;
    const s = slice(row, opts?.allWarehouses);
    const issue = s.damaged + s.lost + s.inspection;
    const ready = Math.max(0, balance - issue);
    const onHand = balance + s.reserved;
    const min = Number(row.minStock) || 0;
    const active = row.isActive !== false;
    let key;
    if (balance < 0) key = 'negative';
    else if (!active) key = balance > 0 ? 'inactive-stock' : 'inactive';
    else if (ready <= 0) key = 'out';
    else if (ready <= min) key = 'low';
    else key = 'ok';
    const reorder = active && balance >= 0 && ready <= min && ready + s.incoming <= min;
    return { balance, ready, onHand, issue, reorder, active, min, state: key, ...s };
  }

  function matches(filter, f) {
    switch (filter === 'low' ? 'reorder' : filter) {
      case 'ready': return f.active && f.ready > 0;
      case 'reorder': return f.reorder;
      case 'issue': return f.issue > 0;
      case 'negative': return f.balance < 0;
      case 'inactive': return !f.active;
      case 'reserved': return f.reserved > 0;
      case 'incoming': return f.incoming > 0;
      default: return true;
    }
  }

  /** Default order: what can be sold first — active before discontinued, then most ready to sell. */
  function compareReady(a, b) {
    const fa = facts(a), fb = facts(b);
    if (fa.active !== fb.active) return fa.active ? -1 : 1;
    if (fb.ready !== fa.ready) return fb.ready - fa.ready;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ar');
  }

  const loaded = () => state.status === 'ready';
  const skeleton = '<span class="ss-skeleton invo-skel" aria-hidden="true"></span>';

  function stateHtml(f) {
    const s = STATES[f.state];
    const extra = s.sub ? `<small class="invo-state-sub">${e(tr(...s.sub))}</small>`
      : f.state === 'out' && f.incoming > 0 ? `<small class="invo-state-sub">${e(term('incoming'))} ${n(f.incoming)}</small>` : '';
    return `<span class="invo-state is-${s.tone}"><span class="invo-dot"></span>${e(tr(...s.label))}</span>${extra}`;
  }

  /** Ready to sell, with one bar split into ready / reserved / needs attention. */
  function readyHtml(f, key) {
    if (f.balance < 0) {
      return `<div class="invo-ready is-negative"><strong dir="ltr">${n(f.balance)}</strong><small>${e(tr('Balance below zero', 'الرصيد أقل من صفر'))}</small></div>`;
    }
    if (!loaded() && state.status !== 'failed') return `<div class="invo-ready"><strong>${skeleton}</strong></div>`;
    const total = Math.max(1, f.ready + f.reserved + f.issue);
    const seg = (cls, v) => v > 0 ? `<i class="${cls}" style="width:${(v / total) * 100}%"></i>` : '';
    // Stock-system style: the available figure, «of N in stock», and a thin allocation bar
    // (available / reserved / needs attention) whose parts are named in the tooltip.
    if (state.status === 'failed') return `<div class="invo-ready"><div class="invo-ready-line"><strong>${n(f.ready)}</strong></div><small class="invo-ready-of">${e(tr('Details unavailable', 'تعذر تحميل التفاصيل'))}</small></div>`;
    const parts = [[term('ready'), f.ready], [term('reservedShort'), f.reserved], [term('issue'), f.issue]].filter(([, v]) => v > 0);
    const tip = `${term('onHand')} ${f.onHand}` + (parts.length ? ' — ' + parts.map(([l, v]) => `${l} ${v}`).join(' · ') : '');
    return `<div class="invo-ready${f.ready <= 0 && f.active ? ' is-zero' : ''}" title="${e(tip)}">
      <div class="invo-ready-line"><strong>${n(f.ready)}</strong><small class="invo-ready-of">${e(tr('of', 'من'))} <bdi>${n(f.onHand)}</bdi> ${e(tr('in stock', 'في المخزن'))}</small></div>
      <span class="invo-bar" role="img" aria-label="${e(tip)}">${seg('is-ready', f.ready)}${seg('is-reserved', f.reserved)}${seg('is-issue', f.issue)}</span>
    </div>`;
  }

  /** A count cell; a non-zero count opens its details. */
  function countHtml(kind, f, key) {
    if (!loaded()) return state.status === 'failed' ? '<span class="invo-none">—</span>' : skeleton;
    const value = kind === 'reserved' ? f.reserved : kind === 'issue' ? f.issue : f.incoming;
    if (!value) return '<span class="invo-none">0</span>';
    let sub = '';
    if (kind === 'issue') {
      sub = [['damaged', f.damaged], ['lost', f.lost], ['inspection', f.inspection]].filter(([, v]) => v > 0)
        .map(([k, v]) => `${e(term(k))} ${n(v)}`).join(' · ');
    } else if (kind === 'reserved') sub = tr(`${f.orders.length} order${f.orders.length === 1 ? '' : 's'}`, `${n(f.orders.length)} طلب`);
    else sub = tr(`${f.pos.length} PO${f.pos.length === 1 ? '' : 's'}`, `${n(f.pos.length)} أمر شراء`);
    return `<button type="button" class="invo-count is-${kind}" data-invo-open="${kind}" data-invo-key="${e(key)}" onclick="event.stopPropagation();window.InvOverview.open(this)">
      <strong>${n(value)}</strong><small>${sub}</small></button>`;
  }

  /** One line for the phone card. */
  function compactHtml(f, key) {
    if (!loaded()) return '';
    const parts = [];
    if (f.reserved) parts.push(`<button type="button" class="invo-chip is-reserved" data-invo-open="reserved" data-invo-key="${e(key)}" onclick="event.stopPropagation();window.InvOverview.open(this)">${e(term('reservedShort'))} ${n(f.reserved)}</button>`);
    if (f.issue) parts.push(`<button type="button" class="invo-chip is-issue" data-invo-open="issue" data-invo-key="${e(key)}" onclick="event.stopPropagation();window.InvOverview.open(this)">${e(term('issue'))} ${n(f.issue)}</button>`);
    if (f.incoming) parts.push(`<button type="button" class="invo-chip is-incoming" data-invo-open="incoming" data-invo-key="${e(key)}" onclick="event.stopPropagation();window.InvOverview.open(this)">${e(term('incoming'))} ${n(f.incoming)}</button>`);
    return parts.length ? `<div class="invo-chips">${parts.join('')}</div>` : '';
  }

  /** Summary cards above the table — each one filters the list. */
  function summaryHtml(rows, pending) {
    const all = rows.map(facts);
    const sum = (list, k) => list.reduce((s, f) => s + (f[k] || 0), 0);
    const active = all.filter(f => f.active);
    const orders = new Set(all.flatMap(f => f.orders.map(o => o.id)));
    const pos = new Set(all.flatMap(f => f.pos.map(p => p.id)));
    const wait = pending || (!loaded() && state.status !== 'failed');
    const val = v => (wait ? skeleton : n(v));
    const card = (filter, tone, title, value, sub) => `<button type="button" class="kpi invo-card is-${tone}" onclick="window.InvOverview.setFilter('${filter}')">
      <span class="invo-card-label"><i class="invo-card-dot" aria-hidden="true"></i>${e(title)}</span><strong class="kpi-val invo-card-val">${value}</strong><span class="invo-card-sub" title="${String(sub).replace(/<[^>]*>/g, '')}">${sub}</span></button>`;
    const issueSub = wait ? '' : [['damaged', sum(all, 'damaged')], ['lost', sum(all, 'lost')], ['inspection', sum(all, 'inspection')]]
      .filter(([, v]) => v > 0).map(([k, v]) => `${e(term(k))} ${n(v)}`).join(' · ') || e(tr('Nothing to review', 'لا شيء للمراجعة'));
    return [
      card('ready', 'ok', term('ready'), pending ? skeleton : n(sum(active, 'ready')), pending ? '' : e(tr(`${active.filter(f => f.ready > 0).length} product${active.filter(f => f.ready > 0).length === 1 ? '' : 's'}`, `${n(active.filter(f => f.ready > 0).length)} منتج`))),
      card('reserved', 'info', term('reserved'), val(sum(all, 'reserved')), wait ? '' : e(tr(`${orders.size} order${orders.size === 1 ? '' : 's'} waiting for the carrier`, `${n(orders.size)} طلب ينتظر شركة الشحن`))),
      card('issue', 'warn', term('issue'), val(sum(all, 'issue')), issueSub),
      card('incoming', 'quiet', term('incoming'), val(sum(all, 'incoming')), wait ? '' : e(tr(`${pos.size} open purchase order${pos.size === 1 ? '' : 's'}`, `${n(pos.size)} أمر شراء مفتوح`))),
    ].join('');
  }

  /** The row's stock commands as one menu (piece codes / stocktake), only those this user may run. */
  function actionsHtml(row) {
    const list = commands(row);
    if (!list.length) return '';
    return `<button type="button" class="invo-more" aria-haspopup="menu" aria-label="${e(tr('Stock actions', 'إجراءات المخزون'))}" title="${e(tr('Stock actions', 'إجراءات المخزون'))}"
      data-invo-menu="${e(String(row._id))}" onclick="event.stopPropagation();window.InvOverview.openMenu(this)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>`;
  }
  const ICO = {
    codes: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6v12M8 6v12M12 6v12M16 6v12M20 6v12"/></svg>',
    count: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12l2 2 4-4"/></svg>',
  };
  function commands(row) {
    const id = String(row._id), out = [];
    if (window.LegacyStockLabels?.button(id)) out.push({ icon: ICO.codes, label: tr('Piece codes', 'أكواد القطع'), sub: tr('Code existing stock and print labels', 'تكويد الرصيد السابق وطباعة الملصقات'), run: () => window.LegacyStockLabels.open(id) });
    if (window.ProductStocktake?.button(id)) out.push({ icon: ICO.count, label: tr('Product stocktake', 'جرد المنتج'), sub: tr('Count the pieces by scanning and compare', 'عدّ القطع بالمسح ومطابقتها مع الرصيد'), run: () => window.ProductStocktake.open(id) });
    return out;
  }
  function openMenu(anchor) {
    const id = anchor.dataset.invoMenu;
    if (state.pop && state.pop.dataset.for === 'menu' + id) { closePop(); anchor.focus(); return; }
    closePop();
    const rows = window.SouliaWarehouses?.inventoryRows(inventoryCache || []) || inventoryCache || [];
    const row = rows.find(r => String(r._id) === id); if (!row) return;
    const list = commands(row);
    const pop = document.createElement('div');
    pop.className = 'invo-pop invo-menu'; pop.dataset.for = 'menu' + id; pop.setAttribute('role', 'menu');
    pop.dir = document.documentElement.dir || 'rtl';
    pop.innerHTML = `<header><span>${e(row.name)}</span></header>` + list.map((c, i) =>
      `<button type="button" role="menuitem" class="invo-menu-item" data-i="${i}">${c.icon}<span><b>${e(c.label)}</b><small>${e(c.sub)}</small></span></button>`).join('');
    pop.addEventListener('click', ev => { const b = ev.target.closest('[data-i]'); if (!b) return; closePop(); list[+b.dataset.i].run(); });
    pop.addEventListener('keydown', ev => {
      const items = [...pop.querySelectorAll('[role=menuitem]')], at = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); items[(at + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus({ preventScroll: true }); }
      if (ev.key === 'Escape') { closePop(); anchor.focus(); }
    });
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(Math.max(8, pop.dir === 'rtl' ? r.left : r.right - w), innerWidth - w - 8);
    pop.style.left = left + 'px'; pop.style.top = (r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    state.pop = pop; state.anchor = anchor; state.anchorTop = r.top; anchor.setAttribute('aria-expanded', 'true');
    pop.querySelector('[role=menuitem]')?.focus({ preventScroll: true });
  }

  function counts(rows) {
    const all = rows.map(facts), out = {};
    for (const key of Object.keys(FILTERS)) out[key] = all.filter(f => matches(key, f)).length;
    return out;
  }

  function filterLabel(key) { return tr(...(FILTERS[key === 'low' ? 'reorder' : key] || FILTERS.all)); }

  function setFilter(key) {
    const btn = document.querySelector(`#inv-toolbar .fx-btn[data-status="${key}"]`);
    if (typeof setInvFilter === 'function') setInvFilter(key, btn);
  }

  // ── Details popover ────────────────────────────────────────────────────────
  function closePop() { state.pop?.remove(); state.pop = null; document.querySelectorAll('.invo-more[aria-expanded]').forEach(b => b.removeAttribute('aria-expanded')); }
  function rowByKey(key) {
    const rows = window.SouliaWarehouses?.inventoryRows(inventoryCache || []) || inventoryCache || [];
    return rows.find(r => (r.code || r.name) === key);
  }
  const STAGES = { Pending: ['Pending', 'معلّق'], Preparing: ['Preparing', 'قيد التجهيز'], Ready: ['Ready to ship', 'جاهز للشحن'] };
  function open(anchor) {
    const kind = anchor.dataset.invoOpen, row = rowByKey(anchor.dataset.invoKey);
    if (!row) return;
    if (state.pop && state.pop.dataset.for === kind + anchor.dataset.invoKey) { closePop(); return; }
    closePop();
    const f = facts(row);
    let body = '';
    if (kind === 'reserved') {
      body = `<p class="invo-pop-help">${e(tr('Sold on confirmed invoices and still in the warehouse until the carrier collects them.', 'مباعة في فواتير مؤكدة وما زالت في المخزن حتى تستلمها شركة الشحن.'))}</p><ul class="invo-pop-list">${f.orders.map(o =>
        `<li><button type="button" onclick="window.InvOverview.openOrder('${e(o.id)}')"><bdi dir="ltr">#${e(o.ref)}</bdi><span>${e(o.client)}</span><em>${e(tr(...(STAGES[o.stage] || [o.stage, o.stage])))}</em><b>× ${n(o.qty)}</b></button></li>`).join('')}</ul>`;
    } else if (kind === 'issue') {
      const line = (k, v, help) => v > 0 ? `<li class="invo-pop-fact"><b>${n(v)}</b><span>${e(term(k))}</span><small>${e(help)}</small></li>` : '';
      body = `<p class="invo-pop-help">${e(tr('Inside the balance but not sellable until reviewed.', 'داخل الرصيد لكنها غير صالحة للبيع حتى تُراجع.'))}</p><ul class="invo-pop-list">
        ${line('damaged', f.damaged, tr('Record it as sound again, return it to the supplier, or write it off.', 'أعدها سليمة، أو أرجعها للمورد، أو اخصمها بتسوية.'))}
        ${line('lost', f.lost, tr('Mark it found, or write the loss off with a stock adjustment.', 'سجّل العثور عليها، أو اخصم الفقد بتسوية مخزون.'))}
        ${line('inspection', f.inspection, tr('Inspect it to make it available again.', 'افحصها لتعود متاحة.'))}</ul>
        ${window.InventoryUnitLabels?.openStockUnits ? `<button type="button" class="btn btn-outline btn-sm invo-pop-action" onclick="window.InvOverview.openPieces('${e(String(row._id))}')">${e(tr('Open the pieces', 'عرض القطع'))}</button>` : ''}`;
    } else {
      body = `<p class="invo-pop-help">${e(tr('Purchase orders not received yet. Not part of the balance until received.', 'أوامر شراء لم تُستلم بعد، ولا تدخل الرصيد إلا عند الاستلام.'))}</p><ul class="invo-pop-list">${f.pos.map(p =>
        `<li><button type="button" onclick="window.InvOverview.openPo('${e(p.id)}')"><bdi dir="ltr">${e(p.poNumber)}</bdi><span>${e(p.supplier)}</span><em>${e(p.expected || p.status)}</em><b>× ${n(p.qty)}</b></button></li>`).join('')}</ul>`;
    }
    const pop = document.createElement('div');
    pop.className = 'invo-pop'; pop.dataset.for = kind + anchor.dataset.invoKey; pop.setAttribute('role', 'dialog');
    pop.dir = document.documentElement.dir || 'rtl';
    pop.innerHTML = `<header><strong>${e(kind === 'issue' ? term('issue') : kind === 'reserved' ? term('reserved') : term('incoming'))}</strong><span>${e(row.name)}</span></header>${body}`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(Math.max(8, (pop.dir === 'rtl' ? r.right - w : r.left)), innerWidth - w - 8);
    const top = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    state.pop = pop; state.anchor = anchor; state.anchorTop = r.top;
  }
  document.addEventListener('mousedown', event => { if (state.pop && !state.pop.contains(event.target) && !event.target.closest('[data-invo-open],[data-invo-menu]')) closePop(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.pop) closePop(); });
  // Close on scroll only when the anchor really moved: a click that first scrolls its row into view
  // delivers that scroll event after the popover opened.
  addEventListener('scroll', () => {
    if (!state.pop) return;
    const top = state.anchor?.isConnected ? state.anchor.getBoundingClientRect().top : null;
    if (top === null || Math.abs(top - state.anchorTop) > 2) closePop();
  }, true);
  addEventListener('resize', () => closePop());

  // ── Data ───────────────────────────────────────────────────────────────────
  function load() {
    if (state.request) return state.request;
    if (state.status !== 'ready') state.status = 'loading';
    state.request = api('/transactions/inventory/breakdown', { background: true })
      .then(data => { state.data = data && typeof data === 'object' ? data : {}; state.status = 'ready'; })
      .catch(() => { if (!state.data) state.status = 'failed'; })
      .finally(() => {
        state.request = null;
        if (typeof currentPage !== 'undefined' && currentPage === 'inventory' && typeof renderInventory === 'function') renderInventory();
        // An open search list showing products redraws with the figures that just arrived.
        if (document.querySelector('#search-dropdown.active') && typeof searchResults !== 'undefined' && searchResults.some(r => r.type === 'product') && typeof renderSearchDropdown === 'function') renderSearchDropdown();
      });
    return state.request;
  }
  /** Coalesces live updates (an order shipped, a piece changed) into one reload. */
  function refreshSoon() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { if (typeof currentPage !== 'undefined' && currentPage === 'inventory') load(); else state.status = state.data ? 'ready' : 'idle'; }, 1200);
  }

  window.InvOverview = {
    facts, matches, compareReady, stateHtml, readyHtml, countHtml, compactHtml, summaryHtml, counts, filterLabel,
    setFilter, open, closePop, actionsHtml, openMenu, load, refreshSoon, loaded, term, FILTERS,
    /** For other screens (global search): the figures across every warehouse, loading them once if needed. */
    productFacts(productId) {
      const row = (inventoryCache || []).find(r => String(r._id) === String(productId));
      if (!row) return null;
      if (state.status === 'idle') load();
      return { ...facts(row, { allWarehouses: true }), known: loaded() };
    },
    openOrder(id) { closePop(); if (typeof openOrderView === 'function') openOrderView(id); },
    openPo(id) { closePop(); if (typeof openPoDetailModal === 'function') openPoDetailModal(id); },
    openPieces(productId) { closePop(); window.InventoryUnitLabels?.openStockUnits({ productId, warehouseCode: location() || undefined }); },
  };
})();
