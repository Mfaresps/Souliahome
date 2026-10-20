/* Physical identity cutover for existing balances; never creates a financial receipt. */
(function () {
  'use strict';
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const allowed = () => hasPerm('inventory-units-view') && hasPerm('inventory-units-register');
  let modal, generation = 0, busy = false, summary, pending, result, productId, actor;
  const el = name => modal.querySelector('[data-legacy-' + name + ']');
  const actorId = () => String(currentUser?._id || currentUser?.id || currentUser?.userId || currentUser?.username || '');
  const storageKey = () => `soulia-legacy-stock:${actor}:${productId}`;
  function close() { if (!busy && modal?.open) modal.close(); }
  function controls() {
    modal.querySelectorAll('input,select,button').forEach(node => { node.disabled = busy; });
    if (pending || result) modal.querySelectorAll('input,select').forEach(node => { node.disabled = true; });
    el('submit').hidden = !!result || (!pending && !!summary && (summary.discrepancy || summary.missing < 1));
    el('submit').disabled = busy || (!pending && (!summary || summary.discrepancy || summary.missing < 1));
    el('submit').textContent = pending ? tr('Retry the saved request', 'إعادة الطلب المحفوظ') : tr('Create missing codes', 'إنشاء الأكواد الناقصة');
    el('print').hidden = !result;
    el('existing').hidden = !summary || summary.registered < 1 || !!result;
    const hideFields = !pending && (!summary || summary.discrepancy || summary.missing < 1 || !!result);
    for (const name of ['quantity', 'note', 'confirm']) { el(name).closest('label').hidden = hideFields; el(name).disabled = busy || !!pending || !!result || hideFields; }
    el('new-count').hidden = hideFields;
  }
  function feedback(text, error = false) { el('message').textContent = text; el('message').dataset.error = String(error); }
  function quantityHint() {
    const amount = Number(el('quantity').value);
    el('new-count').textContent = tr(`New codes: ${Math.max(0, amount)} (maximum 100 per batch).`, `أكواد جديدة: ${Math.max(0, amount)} (بحد أقصى 100 في الدفعة).`);
  }
  async function loadSummary() {
    const request = ++generation; summary = null; busy = true; controls(); feedback(tr('Loading warehouse balance…', 'جارٍ تحميل رصيد المخزن…'));
    try {
      const data = await api('/inventory-units/legacy-stock/summary?' + new URLSearchParams({ productId, warehouseCode: el('warehouse').value }), { background: true });
      if (request !== generation || actor !== actorId() || !modal.open) return;
      summary = data;
      el('product').textContent = data.product.name;
      el('sku').textContent = data.product.code || '—';
      el('balance').textContent = String(data.balance); el('coded').textContent = String(data.registered); el('missing').textContent = String(data.missing);
      el('assigned').textContent = data.assigned ? tr(`${data.assigned} identified pieces assigned to orders are counted separately.`, `${data.assigned} قطعة مكودة مخصصة لطلبات، ولا تدخل في هذا الرصيد الحر.`) : '';
      el('quantity').min = '1';
      el('quantity').max = String(Math.min(data.missing, 100));
      el('quantity').value = String(pending ? pending.physicalQuantity - pending.expectedRegistered : Math.min(data.missing, 100));
      el('confirm').checked = !!pending;
      quantityHint();
      feedback(pending ? tr('A saved request has an unconfirmed result. Retry it to recover the same codes.', 'يوجد طلب محفوظ لم تتأكد نتيجته. أعد نفس الطلب لاسترجاع الأكواد دون تكرار.') : data.discrepancy
        ? tr(`There are ${data.registered} coded pieces against a stock balance of ${data.balance}. Review the stock difference before adding codes.`, `يوجد ${data.registered} كودًا مقابل رصيد ${data.balance} قطعة. راجع فرق الجرد قبل إنشاء أكواد جديدة.`) : data.missing < 1
        ? tr('This balance is fully coded. You can view or reprint its labels.', 'هذا الرصيد مكود بالكامل. يمكنك عرض الأكواد أو إعادة طباعتها.') : '', !!data.discrepancy);
    } catch (error) { if (request === generation) feedback(error.message, true); }
    finally { if (request === generation) { busy = false; controls(); } }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || actor !== actorId() || !allowed()) return;
    if (!pending) {
      const count = Number(el('quantity').value), quantity = Number(summary?.registered || 0) + count;
      if (!summary || !el('confirm').checked || !Number.isSafeInteger(quantity) || quantity <= summary.registered || quantity > summary.balance || quantity - summary.registered > 100) {
        feedback(tr('Confirm the physical count and sound condition. Choose up to 100 missing pieces within the warehouse balance.', 'أكّد العدد الفعلي وسلامة القطع. اختر حتى 100 قطعة غير مكودة ضمن رصيد المخزن.'), true); return;
      }
      pending = { operationKey: `legacy-stock-${crypto.randomUUID()}`, productId, warehouseCode: summary.warehouseCode,
        physicalQuantity: quantity, expectedRegistered: summary.registered, expectedBalance: summary.balance,
        physicalPossessionConfirmed: true, inspectionPassed: true,
        reason: el('note').value.trim() || 'Legacy stock cutover: physical count and sound condition confirmed' };
      try { sessionStorage.setItem(storageKey(), JSON.stringify(pending)); }
      catch { pending = null; feedback(tr('Cannot save the request safely. Enable browser session storage and retry.', 'تعذر حفظ الطلب بأمان. فعّل تخزين جلسة المتصفح وأعد المحاولة.'), true); return; }
    }
    busy = true; controls(); feedback(tr('Creating piece identities…', 'جارٍ إنشاء هويات القطع…'));
    try {
      const response = await api('/inventory-units/legacy-stock/identify', { method: 'POST', body: JSON.stringify(pending) });
      if (actor !== actorId() || !allowed()) return;
      result = response;
      try { sessionStorage.removeItem(storageKey()); } catch { /* Idempotent replay still returns this exact batch. */ }
      pending = null;
      el('coded').textContent = String(response.registered); el('missing').textContent = String(Math.max(0, response.balance - response.registered));
      feedback(tr(`${response.createdUnits} unique piece codes created. The stock balance and accounts are unchanged.`, `تم إنشاء ${response.createdUnits} كودًا مستقلًا. رصيد المخزون والحسابات لم يتغيرا.`));
      window.InvoiceUnitIdentities?.changed();
    } catch (error) {
      if ([400,403,404,409,422].includes(error.status)) {
        try { sessionStorage.removeItem(storageKey()); pending = null; } catch { /* Keep the saved request locked if storage cannot be cleared. */ }
        busy = false; await loadSummary();
      }
      feedback(error.message, true);
    } finally { busy = false; controls(); }
  }
  async function open(id) {
    if (!allowed() || busy) return;
    if (modal?.open) { modal.focus(); return; }
    productId = String(id); actor = actorId(); summary = null; pending = null; result = null;
    try { pending = JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); }
    catch { toast(tr('Could not read saved registration requests. Enable browser session storage.', 'تعذر قراءة طلبات التسجيل المحفوظة. فعّل تخزين جلسة المتصفح.'), true); return; }
    modal?.remove(); modal = document.createElement('dialog'); modal.className = 'legacy-stock-dialog'; modal.dir = tr('ltr','rtl');
    modal.setAttribute('aria-labelledby', 'legacy-stock-title');
    const warehouse = pending?.warehouseCode || document.getElementById('wh-inventory-filter')?.value || 'MAIN';
    modal.innerHTML = `<form><header><h2 id="legacy-stock-title">${tr('Code existing stock', 'تكويد رصيد سابق')}</h2><button type="button" data-legacy-close aria-label="${tr('Close','إغلاق')}">×</button></header><section class="legacy-stock-body"><div class="legacy-stock-product"><strong data-legacy-product></strong><bdi data-legacy-sku></bdi></div><p>${tr('Create identities for existing stock without adding quantities or purchase invoices.', 'أنشئ أكوادًا للقطع القديمة الموجودة، دون إضافة كميات أو فواتير شراء.')}</p><label>${tr('Warehouse','المخزن')}<select data-legacy-warehouse data-warehouse-select>${window.SouliaWarehouses?.options(warehouse) || '<option value="MAIN">المخزن الرئيسي</option>'}</select></label><div class="legacy-stock-counts"><div><span>${tr('Current balance','الرصيد الحالي')}</span><b data-legacy-balance>—</b></div><div><span>${tr('Coded','مكود')}</span><b data-legacy-coded>—</b></div><div><span>${tr('Without codes','غير مكود')}</span><b data-legacy-missing>—</b></div></div><small data-legacy-assigned></small><label>${tr('New pieces to code','عدد القطع الجديدة المراد تكويدها')}<input data-legacy-quantity type="number" step="1" required></label><small data-legacy-new-count></small><label>${tr('Note (optional)','ملاحظة (اختياري)')}<input data-legacy-note maxlength="1000"></label><label class="legacy-stock-confirm"><input type="checkbox" data-legacy-confirm required><span>${tr('I confirm these pieces are present and sound in the selected warehouse.', 'أؤكد وجود القطع وسلامتها في المخزن المختار.')}</span></label><p class="legacy-stock-feedback" data-legacy-message role="status" aria-live="polite"></p></section><footer><button type="button" class="btn btn-outline" data-legacy-close>${tr('Close','إغلاق')}</button><button type="button" class="btn btn-outline" data-legacy-existing hidden>${tr('View existing codes','عرض الأكواد الموجودة')}</button><button class="btn btn-primary" data-legacy-submit type="submit">${tr('Create missing codes','إنشاء الأكواد الناقصة')}</button><button class="btn btn-primary" data-legacy-print type="button" hidden>${tr('Preview and print labels','معاينة الملصقات وطباعتها')}</button></footer></form>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-legacy-close]').forEach(button => { button.onclick = close; });
    modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
    modal.addEventListener('close', () => { generation++; summary = null; });
    modal.querySelector('form').onsubmit = submit; el('quantity').oninput = quantityHint;
    el('warehouse').onchange = loadSummary;
    el('print').onclick = () => { const scope = { reconciliationRef: result.reference, productId, warehouseCode: result.warehouseCode, preview: true }; close(); window.InventoryUnitLabels.openStockUnits(scope); };
    el('existing').onclick = () => { const scope = { productId, warehouseCode: summary.warehouseCode }; close(); window.InventoryUnitLabels.openStockUnits(scope); };
    modal.showModal(); await loadSummary();
  }
  function button(id) {
    if (!allowed()) return '';
    return `<button type="button" class="legacy-stock-trigger" onclick="event.stopPropagation();window.LegacyStockLabels.open('${esc(id)}')">${tr('Piece codes / existing stock','أكواد القطع / تكويد رصيد سابق')}</button>`;
  }
  window.LegacyStockLabels = { open, button };
  if (typeof currentPage !== 'undefined' && currentPage === 'inventory' && typeof renderInventory === 'function') renderInventory();
})();
