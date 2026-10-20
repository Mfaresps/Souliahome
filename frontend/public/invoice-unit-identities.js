/* Invoice identities are read from live assignments and immutable unit events, never copied into financial lines. */
(function () {
  'use strict';
  const cache = new Map(), pending = new Map(), revisions = new Map(), mounted = new WeakSet();
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const allowed = () => typeof hasPerm === 'function' && hasPerm('inventory-units-view');
  let actor = '';
  function syncActor() {
    const user = typeof currentUser === 'undefined' ? null : currentUser;
    const key = String(user?._id || user?.id || user?.userId || user?.username || '');
    if (key !== actor) { actor = key; cache.clear(); pending.clear(); revisions.clear(); }
    return key;
  }
  const isSale = tx => tx?.type === 'مبيعات' && /^[a-f\d]{24}$/i.test(String(tx._id || ''));
  const names = { picking: ['Scanned / preparing', 'تم المسح / قيد التحضير'], prepared: ['Prepared', 'مجهزة'], shipped: ['With carrier', 'مع شركة الشحن'],
    delivered: ['Delivered', 'تم تسليمها'], returned: ['Returned to warehouse', 'عادت للمخزن'], available: ['Available', 'متاحة'],
    'inspection-required': ['Awaiting inspection', 'بانتظار الفحص'], damaged: ['Damaged', 'تالفة'], lost: ['Lost', 'مفقودة'],
    'returned-to-supplier': ['Returned to supplier', 'مرتجعة للمورد'], reserved: ['Reserved', 'محجوزة'], retired: ['Retired', 'مستبعدة'] };
  const status = value => names[value] ? tr(...names[value]) : String(value || '—');
  const date = value => {
    const d = value ? new Date(value) : null;
    return d && Number.isFinite(d.getTime()) ? d.toLocaleString(tr('en-GB', 'ar-EG'), { timeZone: 'Africa/Cairo' }) : '';
  };
  const warehouse = code => window.SouliaWarehouses?.name(code) || code || '—';
  async function load(id, force = false) {
    if (!syncActor() || !allowed()) return null;
    const user = actor, revision = revisions.get(id) || 0;
    if (!force && cache.has(id)) return cache.get(id);
    if (pending.get(id)?.revision === revision) return pending.get(id).promise;
    const entry = { revision, promise: null };
    entry.promise = (async () => {
      const data = await api('/inventory-units/orders/' + encodeURIComponent(id) + '/identities', { background: true });
      if (user !== syncActor() || !allowed()) return null;
      if (revision !== (revisions.get(id) || 0)) return load(id, true);
      if (data?.transactionId !== id || !Array.isArray(data.lines)) throw new Error(tr('Could not read invoice piece identities.', 'تعذر قراءة هويات قطع الفاتورة.'));
      cache.set(id, data); return data;
    })();
    pending.set(id, entry);
    try { return await entry.promise; }
    finally { if (pending.get(id) === entry) pending.delete(id); }
  }
  function lineFor(data, item, tx) {
    if (!data) return null;
    if (item.lineId) return data.lines.find(line => line.lineId === item.lineId) || null;
    const sku = String(item.code || '').trim();
    const matches = data.lines.filter(line => String(line.sku || '').trim() === sku);
    // Legacy rows may only use SKU when it identifies one line unambiguously.
    return sku && matches.length === 1 && (tx.items || []).filter(line => String(line.code || '').trim() === sku).length === 1 ? matches[0] : null;
  }
  function entries(line) { return [...(line?.current || []), ...(line?.history || [])]; }
  function timing(unit) {
    const rows = [];
    if (unit.scannedAt) rows.push(tr('Scanned: ', 'المسح: ') + date(unit.scannedAt) + (unit.scannedBy ? ' · ' + unit.scannedBy : ''));
    if (unit.preparedAt) rows.push(tr('Prepared: ', 'التحضير: ') + date(unit.preparedAt));
    if (unit.shippedAt) rows.push(tr('Shipped: ', 'الشحن: ') + date(unit.shippedAt));
    if (unit.deliveredAt) rows.push(tr('Delivered: ', 'التسليم: ') + date(unit.deliveredAt));
    if (unit.returnedAt) rows.push(tr('Returned: ', 'الرجوع: ') + date(unit.returnedAt) + ' · ' + warehouse(unit.returnWarehouseCode) + (unit.returnedBy ? ' · ' + unit.returnedBy : ''));
    if (unit.statusSource === 'order') rows.push(tr('Dispatch/delivery follows the order status.', 'الشحن / التسليم بحسب حالة الطلب.'));
    return rows;
  }
  function renderLine(line) {
    const all = entries(line);
    const issues = `${line?.skippedCount ? `<button type="button" class="ivi-status-badge" data-ivi-open title="${tr('Prepared without scanning; no linked piece ID. View details.', 'تم التجهيز بدون مسح؛ بدون ID للقطعة. اضغط للتفاصيل.')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 13 13 20a2 2 0 0 1-3 0L3 13V4h9l8 7a2 2 0 0 1 0 2Z"/><path d="m9 8 6 6m0-6-6 6"/></svg><span>${tr('Without ID', 'بدون ID')}</span><b>${Number(line.skippedCount)}</b></button>` : ''}${line?.mismatchedAssignments ? `<button type="button" class="ivi-status-badge is-error" data-ivi-open>${tr('Review identity', 'راجع الهوية')}</button>` : ''}`;
    if (!all.length) return issues || `<span class="ivi-empty" title="${tr('No scanned pieces linked yet.', 'لا توجد قطع ممسوحة مرتبطة حاليًا.')}">—</span>`;
    return `<button type="button" class="ivi-open-details" data-ivi-open aria-label="${tr('View piece identity and tracking details', 'عرض هوية القطعة وتفاصيل التتبع')}" title="${tr('Identity & tracking details', 'تفاصيل الهوية والتتبع')}">${all.length === 1 ? `<code dir="ltr">${html(all[0].manualCode || all[0].barcode)}</code>` : `<span>${all.length} ${tr('pieces', 'قطع')}</span>`}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M7 3H4a1 1 0 0 0-1 1v3m14-4h3a1 1 0 0 1 1 1v3M3 17v3a1 1 0 0 0 1 1h3m14-4v3a1 1 0 0 1-1 1h-3M7 8v8m3-8v8m4-8v8m3-8v8"/></svg></button>${issues}`;
  }
  let identityDialog = null, detailContext = null;
  function paintDetails(data) {
    if (!identityDialog?.open || !detailContext || data?.transactionId !== detailContext.id) return;
    const line = lineFor(data, detailContext.item, { items: data.lines.map(row => ({ code: row.sku })) });
    const all = entries(line);
    const markup = all.map(unit => `<article class="ivi-piece ${unit.returnedAt ? 'is-returned' : ''}"><div class="ivi-piece-head"><code dir="ltr">${html(unit.manualCode || unit.barcode)}</code><span>${html(status(unit.orderStatus))}</span></div><div class="ivi-trace">${timing(unit).map(text => `<span dir="auto">${html(text)}</span>`).join('')}<span>${tr('Warehouse: ', 'المخزن: ')}${html(warehouse(unit.warehouseCode))}</span>${!unit.active ? `<span>${tr('Historical link to this invoice', 'سجل سابق مرتبط بهذه الفاتورة')}</span>` : ''}${unit.matchesProduct === false ? `<span class="ivi-error">${tr('Historical piece: product on invoice changed.', 'قطعة سابقة: تم تغيير المنتج على الفاتورة.')}</span>` : ''}${unit.returnedAt ? `<span>${tr('Current piece status: ', 'حالة القطعة الحالية: ')}${html(status(unit.status))}</span>` : ''}<details><summary>${tr('Technical identifiers', 'المعرّفات التقنية')}</summary><span>Unit ID <code dir="ltr">${html(unit.unitId)}</code></span><span>QR <code dir="ltr">${html(unit.barcode)}</code></span></details></div></article>`).join('') || `<p class="ivi-empty">${tr('No scanned pieces linked currently.', 'لا توجد قطع ممسوحة مرتبطة حاليًا.')}</p>`;
    const body = identityDialog.querySelector('[data-ivi-dialog-body]');
    const fullMarkup = lineWarnings(line).map(warning => `<p class="ivi-detail-warning">${html(warning)}</p>`).join('') + markup;
    if (body.innerHTML !== fullMarkup) body.innerHTML = fullMarkup;
  }
  function openDetails(slot) {
    const id = slot.dataset.invoicePieceLine, data = cache.get(id); if (!data) return;
    if (!identityDialog) {
      identityDialog = document.createElement('dialog'); identityDialog.className = 'ivi-dialog'; identityDialog.setAttribute('aria-labelledby', 'ivi-dialog-title');
      identityDialog.innerHTML = `<form method="dialog" class="ivi-dialog-header"><h2 id="ivi-dialog-title"></h2><button type="submit" aria-label="${tr('Close', 'إغلاق')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 6 12 12M18 6 6 18"/></svg></button></form><div class="ivi-dialog-body" data-ivi-dialog-body></div>`;
      document.body.appendChild(identityDialog);
      identityDialog.addEventListener('close', () => { detailContext = null; });
      identityDialog.addEventListener('click', event => { if (event.target !== identityDialog) return; const rect = identityDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) identityDialog.close(); });
    }
    identityDialog.dir = tr('ltr', 'rtl'); identityDialog.querySelector('h2').textContent = tr('Piece identity & tracking', 'هوية القطعة وتتبعها');
    detailContext = { id, item: { lineId: slot.dataset.pieceLineId, code: slot.dataset.pieceSku } };
    if (!identityDialog.open) identityDialog.showModal(); paintDetails(data);
  }
  function placeholder(tx, item) {
    if (!isSale(tx) || !allowed()) return '';
    return `<div class="invoice-piece-identities" data-invoice-piece-line="${html(tx._id)}" data-piece-line-id="${html(item.lineId || '')}" data-piece-sku="${html(item.code || '')}"><small class="ivi-empty">${tr('Loading piece identities…', 'جارٍ تحميل هويات القطع…')}</small></div>`;
  }
  function actions(tx) {
    if (!isSale(tx) || !allowed() || typeof hasPerm !== 'function' || !hasPerm('inventory-units-condition')) return '';
    return `<div class="ivi-invoice-actions"><button type="button" class="ivi-return-button" data-customer-piece-return="${html(tx._id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/></svg><span>${tr('Receive return without label', 'استلام مرتجع بدون ملصق')}</span></button></div>`;
  }
  function slots(id) { return [...document.querySelectorAll('[data-invoice-piece-line]')].filter(node => !id || node.dataset.invoicePieceLine === id); }
  async function refresh(id) {
    const targets = slots(id); if (!targets.length) return;
    const revision = revisions.get(id) || 0;
    try {
      const data = await load(id, true);
      if (revision !== (revisions.get(id) || 0)) return;
      for (const target of targets) {
        if (!target.isConnected) continue;
        if (!data || !allowed()) { target.replaceChildren(); continue; }
        const item = { lineId: target.dataset.pieceLineId, code: target.dataset.pieceSku };
        const tx = { items: data.lines.map(line => ({ code: line.sku })) };
        const markup = renderLine(lineFor(data, item, tx));
        if (target.innerHTML !== markup) target.innerHTML = markup;
      }
      paintDetails(data);
    } catch (error) {
      for (const target of targets) if (target.isConnected) target.innerHTML = `<small class="ivi-error">${tr('Piece identities could not be loaded.', 'تعذر تحميل هويات القطع.')}</small><button type="button" class="ivi-retry" data-invoice-identities-refresh="${html(id)}">${tr('Retry', 'إعادة المحاولة')}</button>`;
    }
  }
  function refreshVisible() {
    for (const id of new Set(slots().filter(node => node.getClientRects().length).map(node => node.dataset.invoicePieceLine))) changed(id);
  }
  function changed(id) {
    syncActor();
    const ids = id ? [String(id)] : [...new Set([...cache.keys(), ...slots().map(node => node.dataset.invoicePieceLine)])];
    for (const key of ids) { revisions.set(key, (revisions.get(key) || 0) + 1); cache.delete(key); refresh(key); }
  }
  async function ensure(tx) { if (isSale(tx) && allowed()) await load(String(tx._id), true); }
  function lineWarnings(line) {
    return [line?.skippedCount ? tr('Without ID · prepared without scan: ', 'بدون ID · تجهيز بدون مسح: ') + Number(line.skippedCount) : '',
      line?.mismatchedAssignments ? tr('Assigned identities need review: product changed.', 'هويات مرتبطة تحتاج مراجعة: تم تغيير المنتج.') : ''].filter(Boolean);
  }
  function printLineHtml(tx, item) {
    if (!isSale(tx) || !allowed()) return '';
    syncActor();
    const line = lineFor(cache.get(String(tx._id)), item, tx), all = entries(line), warnings = lineWarnings(line);
    if (!all.length && !warnings.length) return '';
    return `<div style="margin-top:5px;font-size:8px;line-height:1.65;overflow-wrap:anywhere"><b>${tr('Piece identities', 'هويات القطع')}</b>${all.map(unit => `<div style="margin-top:3px"><code dir="ltr">${html(unit.manualCode || unit.barcode)}</code> · ${html(status(unit.orderStatus))}<br><span>ID <bdi>${html(unit.manualCode || unit.unitId)}</bdi></span>${unit.returnedAt ? `<br>${html(tr('Returned: ', 'الرجوع: ') + date(unit.returnedAt) + ' · ' + warehouse(unit.returnWarehouseCode))}` : ''}${unit.statusSource === 'order' ? `<br>${tr('According to order status', 'بحسب حالة الطلب')}` : ''}${unit.matchesProduct === false ? `<br>${tr('Historical piece: product on invoice changed', 'قطعة سابقة: تم تغيير المنتج على الفاتورة')}` : ''}</div>`).join('')}${warnings.map(warning => `<div>${html(warning)}</div>`).join('')}</div>`;
  }
  function imageLines(tx, item) {
    if (!isSale(tx) || !allowed()) return [];
    syncActor();
    const line = lineFor(cache.get(String(tx._id)), item, tx);
    return [...lineWarnings(line), ...entries(line).flatMap(unit => [(unit.manualCode || unit.barcode) + ' · ' + status(unit.orderStatus), 'Code ' + (unit.manualCode || unit.unitId),
      ...(unit.returnedAt ? [tr('Returned: ', 'الرجوع: ') + date(unit.returnedAt) + ' · ' + warehouse(unit.returnWarehouseCode)] : []),
      ...(unit.statusSource === 'order' ? [tr('According to order status', 'بحسب حالة الطلب')] : []),
      ...(unit.matchesProduct === false ? [tr('Historical piece: product on invoice changed', 'قطعة سابقة: تم تغيير المنتج على الفاتورة')] : [])])];
  }
  function mount() {
    const ids = new Set();
    for (const target of slots()) if (!mounted.has(target)) { mounted.add(target); ids.add(target.dataset.invoicePieceLine); }
    for (const id of ids) refresh(id);
  }
  function start() {
    let queued;
    const observer = new MutationObserver(() => { clearTimeout(queued); queued = setTimeout(mount, 60); });
    observer.observe(document.body, { childList: true, subtree: true }); mount();
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-invoice-identities-refresh]'); if (button) changed(button.dataset.invoiceIdentitiesRefresh);
      const details = event.target.closest('[data-ivi-open]'); if (details) { event.preventDefault(); event.stopPropagation(); const slot = details.closest('[data-invoice-piece-line]'); if (slot) openDetails(slot); }
    });
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshVisible(); });
  }
  window.InvoiceUnitIdentities = { placeholder, actions, ensure, printLineHtml, imageLines, changed, refreshVisible };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
