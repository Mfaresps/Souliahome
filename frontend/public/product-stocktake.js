/* Product/warehouse physical count. Reuse existing identities before creating any. */
(function () {
  'use strict';
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const actorId = () => String(currentUser?._id || currentUser?.id || currentUser?.userId || currentUser?.username || '');
  let dialog, session, busy = false, generation = 0;
  const el = key => dialog.querySelector('[data-count-' + key + ']');
  const valid = () => session?.actor === actorId() && hasPerm('inventory-units-view');
  const storageKey = () => 'soulia-stocktake-job:' + session.actor + ':' + session.productId;
  const feedback = (text, error = false) => { el('message').textContent = text; el('message').dataset.error = String(error); };
  const remaining = () => session.summary.units.filter(unit => !session.checked.has(String(unit._id)));
  function controls() {
    dialog.querySelectorAll('button,input,select').forEach(node => { node.disabled = busy; });
    el('finish').disabled = busy || !session.summary || !!session.job;
    el('print').disabled = busy || !session.summary || (!session.selected.size && !session.job) || !hasPerm('inventory-units-print');
    el('warehouse').disabled = busy || !!session.job;
    el('back').disabled = busy || !!session.job;
    if (session.job) dialog.querySelectorAll('[data-count-choice], [data-count-confirm], [data-count-code]').forEach(node => { node.disabled = true; });
    if (!hasPerm('inventory-units-register')) dialog.querySelectorAll('[data-count-choice^="new:"]').forEach(node => { node.disabled = true; });
  }
  function render() {
    const { summary, checked, review, selected } = session;
    if (!summary) return;
    el('title').textContent = tr('Product stocktake · ', 'جرد المنتج · ') + summary.product.name;
    el('totals').textContent = tr(`Stock: ${summary.balance} · Registered codes: ${summary.registered} · Scanned: ${checked.size} · No code: ${summary.missing}`, `الرصيد: ${summary.balance} · بأكواد: ${summary.registered} · تم مسحها: ${checked.size} · بدون كود: ${summary.missing}`);
    el('scope').textContent = tr('This count covers unassigned stock in the chosen warehouse. Pieces assigned to orders are separate: ', 'الجرد لرصيد المخزن المختار غير المخصص للطلبات. القطع المخصصة للطلبات تُحسب منفصلة: ') + summary.assigned;
    el('scan').hidden = review || !!session.job;
    el('review').hidden = !review;
    el('finish').hidden = review;
    el('print').hidden = !review;
    el('back').hidden = !review;
    el('print').textContent = session.job ? tr('Resume registration / printing', 'استكمال التسجيل / الطباعة') : tr('Register and preview labels', 'تسجيل ومعاينة الملصقات');
    const units = review ? remaining() : summary.units;
    const rows = units.map(unit => {
      const id = String(unit._id), found = checked.has(id);
      return `<tr data-count-id="${esc(id)}" class="${found ? 'count-found' : ''}"><td>${review ? `<input type="checkbox" data-count-choice="${esc(id)}" ${selected.has(id) ? 'checked' : ''} aria-label="${esc(tr('Print label ', 'طباعة ملصق ') + (unit.manualCode || unit.barcode))}">` : found ? '✓' : '—'}</td><td>${esc(summary.product.name)}</td><td><code dir="ltr">${esc(unit.manualCode || unit.barcode)}</code></td><td>${found ? tr('Scanned', 'تم المسح') : tr('Not scanned', 'لم تُمسح')}${found ? ` <button type="button" data-count-undo="${esc(id)}">${tr('Undo', 'تراجع')}</button>` : ''}</td></tr>`;
    });
    for (let i = 0; i < summary.missing; i++) {
      const key = 'new:' + i;
      rows.push(`<tr><td>${review ? `<input type="checkbox" data-count-choice="${key}" ${selected.has(key) ? 'checked' : ''} ${!hasPerm('inventory-units-register') ? 'disabled' : ''} aria-label="${tr('Create code for piece ', 'إنشاء كود للقطعة ')}${i + 1}">` : '—'}</td><td>${esc(summary.product.name)}</td><td>${tr('No registered code', 'لا يوجد كود مسجل')}</td><td>${tr('Needs a new code after physical confirmation', 'تحتاج كودًا جديدًا بعد تأكيد وجودها')}</td></tr>`);
    }
    el('rows').innerHTML = rows.join('');
    el('empty').hidden = rows.length > 0;
    el('selection').textContent = tr(`Selected: ${selected.size} · Maximum 100 labels per batch.`, `المحدد: ${selected.size} · الحد الأقصى 100 ملصق في الدفعة.`);
    controls();
    if (!hasPerm('inventory-units-register')) dialog.querySelectorAll('[data-count-choice^="new:"]').forEach(node => { node.disabled = true; });
  }
  async function load() {
    const token = ++generation;
    busy = true; session.summary = null; controls(); feedback(tr('Loading stock…', 'جارٍ تحميل الرصيد…'));
    try {
      const data = await api('/inventory-units/stocktake?' + new URLSearchParams({ productId: session.productId, warehouseCode: el('warehouse').value }), { background: true });
      if (token !== generation || !valid() || !dialog.open) return;
      session.summary = data; session.checked.clear(); session.selected.clear(); session.review = !!session.job;
      if (session.job) {
        session.job.ids.forEach(id => session.selected.add(id));
        if (!session.job.completed) for (let i = 0; i < session.job.request.physicalQuantity - session.job.request.expectedRegistered; i++) session.selected.add('new:' + i);
      }
      render();
      feedback(session.job ? tr('A saved registration is pending. Resume it to recover the same codes.', 'يوجد طلب تسجيل محفوظ. استكمله لاسترجاع نفس الأكواد دون تكرار.') : data.discrepancy ? tr('The coded pieces and stock balance disagree. Review the stock before creating codes.', 'عدد الأكواد لا يتطابق مع الرصيد. راجع فرق الرصيد قبل إنشاء أكواد جديدة.') : '', data.discrepancy);
    } catch (error) { if (token === generation) feedback(error.message, true); }
    finally { if (token === generation) { busy = false; controls(); if (session.summary && !session.review) el('code').focus(); } }
  }
  function scan(event) {
    event.preventDefault();
    if (busy || !valid() || !session.summary || session.review) return;
    const code = (window.BarcodeInput?.normalize(el('code').value) || el('code').value).trim().toUpperCase();
    if (!code) return;
    const unit = session.summary.units.find(unit => [unit.barcode, unit.manualCode].some(value => value && String(value).toUpperCase() === code));
    if (!unit) feedback(tr('This code is not in this product’s counted warehouse stock.', 'الكود ليس ضمن رصيد هذا المنتج في المخزن المختار.'), true);
    else if (session.checked.has(String(unit._id))) feedback(tr('Already scanned. Count unchanged.', 'تم مسح هذه القطعة من قبل؛ لم تُحتسب مرتين.'));
    else { session.checked.add(String(unit._id)); render(); feedback(tr('Piece scanned: ', 'تم مسح القطعة: ') + (unit.manualCode || unit.barcode)); }
    el('code').value = ''; el('code').focus();
  }
  function finish() {
    if (busy || !valid() || !session.summary) return;
    session.review = true; session.selected.clear(); el('confirm').checked = false;
    remaining().slice(0, 100).forEach(unit => session.selected.add(String(unit._id)));
    if (hasPerm('inventory-units-register') && !session.summary.discrepancy) {
      for (let i = 0; i < session.summary.missing && session.selected.size < 100; i++) session.selected.add('new:' + i);
    }
    render(); feedback(tr('Review unchecked pieces. Select only pieces physically present without a readable label; unscanned does not mean missing.', 'راجع القطع التي لم تُمسح. حدد فقط القطع الموجودة فعليًا بدون ملصق مقروء؛ عدم المسح لا يعني أن القطعة مفقودة.'));
  }
  async function prepare() {
    if (busy || !valid() || !hasPerm('inventory-units-print')) return;
    if (!session.job) {
      if (!session.selected.size || session.selected.size > 100 || !el('confirm').checked) { feedback(tr('Select up to 100 pieces and confirm they are physically present.', 'حدد حتى 100 قطعة وأكد وجودها الفعلي.'), true); return; }
      const ids = [...session.selected].filter(id => !id.startsWith('new:'));
      const count = session.selected.size - ids.length, summary = session.summary;
      if (count && (!hasPerm('inventory-units-register') || summary.discrepancy)) { feedback(tr('New code registration is unavailable. Review the balance and permissions.', 'إنشاء الأكواد غير متاح. راجع الرصيد والصلاحيات.'), true); return; }
      session.job = { ids, warehouseCode: summary.warehouseCode, request: count ? {
        operationKey: 'stocktake-' + crypto.randomUUID(), productId: session.productId, warehouseCode: summary.warehouseCode,
        physicalQuantity: summary.registered + count, expectedRegistered: summary.registered, expectedBalance: summary.balance,
        physicalPossessionConfirmed: true, inspectionPassed: true, reason: 'Product stocktake: operator confirmed selected uncoded pieces are present and sound',
      } : null, completed: !count };
      try { sessionStorage.setItem(storageKey(), JSON.stringify(session.job)); }
      catch { session.job = null; feedback(tr('Enable session storage before registering pieces.', 'فعّل تخزين الجلسة قبل تسجيل القطع.'), true); return; }
    }
    busy = true; controls();
    try {
      const job = session.job;
      if (!job.completed) {
        const response = await api('/inventory-units/legacy-stock/identify', { method: 'POST', body: JSON.stringify(job.request) });
        if (!valid()) return;
        if (response.stockChanged !== false || !Array.isArray(response.unitIds)) throw new Error(tr('Unexpected registration response. Retry the saved request.', 'استجابة تسجيل غير متوقعة. أعد الطلب المحفوظ.'));
        job.ids = [...new Set([...job.ids, ...response.unitIds])]; job.completed = true;
        sessionStorage.setItem(storageKey(), JSON.stringify(job));
      }
      // Revalidate custody after counting and after creating identities.
      const fresh = await api('/inventory-units/stocktake?' + new URLSearchParams({ productId: session.productId, warehouseCode: job.warehouseCode }), { background: true });
      if (!valid()) return;
      const present = new Set(fresh.units.map(unit => String(unit._id)));
      if (job.ids.some(id => !present.has(id))) {
        sessionStorage.removeItem(storageKey()); session.job = null;
        busy = false; await load();
        throw new Error(tr('Selected pieces moved since counting. Review the refreshed stocktake.', 'تحركت قطع مختارة منذ الجرد. راجع قائمة الجرد المحدثة.'));
      }
      const scope = { productId: session.productId, warehouseCode: job.warehouseCode, unitIds: job.ids, preview: true };
      sessionStorage.removeItem(storageKey()); session.job = null;
      busy = false; dialog.close(); window.InventoryUnitLabels.openStockUnits(scope);
    } catch (error) {
      if ([400, 403, 404, 409, 422].includes(error.status) && !session.job?.completed) {
        sessionStorage.removeItem(storageKey()); session.job = null;
        busy = false; await load();
      }
      feedback(error.message, true);
    } finally { busy = false; if (dialog.open) controls(); }
  }
  async function open(productId) {
    if (busy || !hasPerm('inventory-units-view')) return;
    if (dialog?.open) { dialog.focus(); return; }
    dialog?.remove();
    session = { productId: String(productId), actor: actorId(), checked: new Set(), selected: new Set(), summary: null, review: false, job: null };
    try { session.job = JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); } catch { /* No recoverable request. */ }
    dialog = document.createElement('dialog'); dialog.className = 'product-stocktake-dialog'; dialog.dir = tr('ltr', 'rtl');
    dialog.setAttribute('aria-labelledby', 'product-stocktake-title');
    const warehouse = session.job?.warehouseCode || 'MAIN';
    dialog.innerHTML = `<header><h2 id="product-stocktake-title" data-count-title>${tr('Product stocktake', 'جرد المنتج')}</h2><button type="button" data-count-close aria-label="${tr('Close', 'إغلاق')}">×</button></header>
      <section><label>${tr('Warehouse', 'المخزن')} <select data-count-warehouse data-warehouse-select>${window.SouliaWarehouses?.options(warehouse) || '<option value="MAIN">المخزن الرئيسي</option>'}</select></label>
      <p data-count-totals></p><p data-count-scope></p><p>${tr('Green rows are physically scanned. Closing this window resets the scan marks.', 'الصف الأخضر يعني أن القطعة تم مسحها فعليًا. إغلاق النافذة يصفر علامات المسح.')}</p>
      <form data-count-scan><input data-count-code dir="ltr" autocomplete="off" maxlength="160" placeholder="${tr('Scan or enter piece code', 'امسح أو أدخل كود القطعة')}" aria-label="${tr('Piece code', 'كود القطعة')}"><button type="submit">${tr('Scan', 'مسح')}</button></form>
      <p data-count-message role="status" aria-live="polite"></p>
      <div class="product-stocktake-table"><table><thead><tr><th>✓</th><th>${tr('Product', 'المنتج')}</th><th>${tr('Piece code', 'كود القطعة')}</th><th>${tr('Check', 'الفحص')}</th></tr></thead><tbody data-count-rows></tbody></table></div><p data-count-empty hidden>${tr('No remaining pieces.', 'لا توجد قطع متبقية.')}</p>
      <div data-count-review hidden><p data-count-selection></p><label class="product-stocktake-confirm"><input type="checkbox" data-count-confirm><span>${tr('I confirm the selected pieces are physically present without readable labels, and any pieces receiving new codes are sound.', 'أؤكد أن القطع المحددة موجودة فعليًا بدون ملصقات مقروءة، وأن القطع التي ستأخذ أكوادًا جديدة سليمة.')}</span></label><p>${tr('Existing codes are reprinted. New identities are registered only for uncoded stock. Stock quantities are unchanged.', 'الأكواد الموجودة تُعاد طباعتها. تُسجل هويات جديدة للرصيد غير المكود فقط، دون تغيير كمية المخزون.')}</p></div></section>
      <footer><button type="button" data-count-back hidden>${tr('Continue scanning', 'استكمال المسح')}</button><button type="button" data-count-finish>${tr('Finish stocktake', 'انتهاء الجرد')}</button><button type="button" data-count-print hidden></button></footer>`;
    document.body.append(dialog);
    const close = () => { if (!busy) dialog.close(); };
    el('close').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { generation++; });
    el('scan').onsubmit = scan;
    el('warehouse').onchange = load;
    el('finish').onclick = finish;
    el('back').onclick = () => { session.review = false; render(); el('code').focus(); };
    el('print').onclick = prepare;
    el('rows').onchange = event => {
      const key = event.target.dataset.countChoice;
      if (!key || busy || session.job) return;
      if (event.target.checked && session.selected.size >= 100) { event.target.checked = false; feedback(tr('Maximum 100 labels per batch.', 'الحد الأقصى 100 ملصق في الدفعة.'), true); return; }
      event.target.checked ? session.selected.add(key) : session.selected.delete(key);
      el('confirm').checked = false; render();
    };
    el('rows').onclick = event => { const id = event.target.dataset.countUndo; if (id && !busy) { session.checked.delete(id); render(); } };
    dialog.showModal(); await load();
  }
  window.ProductStocktake = { open, button: id => hasPerm('inventory-units-view') ? `<button type="button" class="legacy-stock-trigger" onclick="event.stopPropagation();window.ProductStocktake.open('${esc(id)}')">${tr('Stocktake', 'جرد المنتج')}</button>` : '' };
  if (typeof currentPage !== 'undefined' && currentPage === 'inventory' && typeof renderInventory === 'function') renderInventory();
})();
