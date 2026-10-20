/* Uses the application's authenticated api(), permissions and language. No unit identities are generated here. */
(function () {
  'use strict';
  const state = { page: 1, q: '', status: '', config: null, rows: [], selected: new Set(), preview: null,
    sizeId: '', loading: false, requestNumber: 0, renderNumber: 0, ready: false, dataReady: false, searching: false, total: 0,
    pendingPrint: null, searchTimer: null, purchaseTransactionId: '', purchaseLineId: '', receipts: [], receiptSelections: new Set(), receiptCursors: new Map() };
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const statusNames = { available: 'متاح', reserved: 'محجوز', picking: 'قيد الالتقاط', prepared: 'مجهز', shipped: 'تم التسليم للشحن', delivered: 'تم التوصيل', returned: 'مرتجع',
    'inspection-required': 'بانتظار الفحص', damaged: 'تالف', 'returned-to-supplier': 'مرتجع للمورد', lost: 'مفقود', retired: 'مستبعد' };
  const statusNamesEn = { available: 'Available', reserved: 'Reserved', picking: 'Picking', prepared: 'Prepared', shipped: 'Shipped', delivered: 'Delivered', returned: 'Returned',
    'inspection-required': 'Inspection required', damaged: 'Damaged', 'returned-to-supplier': 'Returned to supplier', lost: 'Lost', retired: 'Retired' };
  const statusLabel = value => tr(statusNamesEn[value] || value, statusNames[value] || value);
  const get = id => document.getElementById(id);
  const message = (text, error = false) => { const el = get('iu-message'); if (el) { el.textContent = text; el.dataset.error = String(error); } };
  const requestKey = () => { if (!globalThis.crypto?.randomUUID) throw new Error(tr('A secure browser context is required.', 'يلزم متصفح في سياق آمن.')); return crypto.randomUUID(); };
  const post = (path, body) => api('/inventory-units' + path, { method: 'POST', body: JSON.stringify(body) });
  const icons = {
    scan: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M8 8v8M11 8v8M14 8v8M17 8v8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    printer: '<path d="M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7zM17 11h.01"/>',
    box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M8 5l9 4"/>',
    refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.box}</svg>`;
  function emptyState(title, detail) { return `<div class="iu-empty">${icon('box')}<strong>${html(title)}</strong><p>${html(detail)}</p></div>`; }
  function connectionError(error, initialization = false) {
    const denied = [401, 403].includes(error.status);
    const missing = error.status === 404 || /Cannot GET.*inventory-units/.test(error.message || '');
    get('iu-error').hidden = false;
    get('iu-error-title').textContent = denied ? tr('Permission denied', 'الصلاحية غير متاحة') : tr('Barcode service unavailable', 'خدمة الباركود غير متاحة');
    get('iu-error-detail').textContent = denied ? tr('Your account cannot access inventory units. Contact an administrator.', 'حسابك لا يملك صلاحية الوصول إلى الوحدات. تواصل مع المسؤول.') :
      missing ? tr('The running server does not have the barcode API. The administrator needs to rebuild and restart the current backend, then retry.', 'الخادم الحالي لا يحتوي على واجهة الباركود. يلزم أن يعيد المسؤول بناء وتشغيل الباك إند الحالي، ثم إعادة المحاولة.') :
      tr('We could not load barcode data. Check the connection and try again.', 'تعذر تحميل بيانات الباركود. تحقق من الاتصال وأعد المحاولة.');
    get('iu-connection').textContent = denied ? tr('Access restricted', 'وصول مقيد') : tr('Connection unavailable', 'الاتصال غير متاح');
    get('iu-connection').dataset.state = 'error';
    get('iu-retry').onclick = () => initialization ? window.renderBarcodeManagement() : load();
    message('');
  }

  function labelHtml(label, size) {
    if (!/^SU-[A-F\d]{24}$/.test(label.barcode) || label.barcode !== 'SU-' + String(label.unitId).toUpperCase()) throw new Error('Invalid backend label identity');
    const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(label.svg);
    const idGroups = String(label.unitId).match(/.{1,4}/g);
    const groupedId = html(idGroups.slice(0, 3).join(' ')) + '<br>' + html(idGroups.slice(3).join(' '));
    const printTime = new Date();
    const printDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(printTime);
    const price = typeof label.sellPrice === 'number' && Number.isFinite(label.sellPrice) && label.sellPrice >= 0
      ? 'EGP ' + new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(label.sellPrice) : tr('Price unavailable', 'السعر غير متاح');
    return `<article class="iu-label${size.widthMm <= 50 ? ' iu-label-compact' : size.widthMm >= 100 ? ' iu-label-large' : ''}${size.id === '50x25' ? ' iu-label-50x25' : ''}" style="--label-width:${Number(size.widthMm)}mm;--label-height:${Number(size.heightMm)}mm;--qr-size:${Number(size.qrMm)}mm;--label-margin:${Number(size.marginMm || 2)}mm" aria-label="${html(label.barcode)}">
      <div class="iu-label-header"><time class="iu-label-print-date" datetime="${printTime.toISOString()}">Print: ${html(printDate)}</time><div class="iu-label-brand">SOULIA HOME</div></div>
      <div class="iu-label-layout"><img src="${source}" alt="${html(label.barcode)}"><div class="iu-label-text"><p class="iu-label-name" dir="auto">${html(label.productName)}</p>
      <div class="iu-label-price">${html(price)}</div>
      <p class="iu-label-sku">SKU: ${html(label.sku)}</p>${label.receivedDate ? `<div class="iu-label-date">Received: ${html(label.receivedDate)}</div>` : ''}<p class="iu-label-id">Unit ID:<br><span>${groupedId}</span></p></div></div><p class="iu-label-value">${html(label.barcode)}</p></article>`;
  }
  function validateBatch(batch, expectedIds, sizeId) {
    if (!batch || batch.size?.id !== sizeId || !state.config.labelSizes.some(size => size.id === sizeId && size.widthMm === batch.size.widthMm && size.heightMm === batch.size.heightMm && size.qrMm === batch.size.qrMm)) throw new Error(tr('Unsupported label dimensions.', 'أبعاد الملصق غير مدعومة.'));
    const actual = batch.labels.map(label => String(label.unitId));
    if (actual.length !== expectedIds.length || new Set(actual).size !== actual.length || expectedIds.some(id => !actual.includes(id))) throw new Error(tr('Label selection mismatch or duplicates.', 'الملصقات لا تطابق التحديد أو تحتوي على تكرار.'));
    if (new Set(batch.labels.map(label => label.barcode)).size !== actual.length) throw new Error('Duplicate barcode values');
    batch.labels.forEach(label => labelHtml(label, batch.size));
    return batch;
  }
  async function waitForLayout(doc) {
    await Promise.all([...doc.querySelectorAll('img')].map(img => img.complete ? (img.naturalWidth ? Promise.resolve() : Promise.reject(new Error('Barcode image failed to load'))) : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Barcode image failed to load')); })));
    const fonts = (doc.ownerDocument || doc).fonts;
    if (fonts?.ready) await fonts.ready;
    // Check actual rendered content, including long names/SKUs; never silently shrink the barcode.
    for (const label of doc.querySelectorAll('.iu-label')) {
      const content = label.querySelector('.iu-label-value').getBoundingClientRect(), box = label.getBoundingClientRect();
      if (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 || content.bottom > box.bottom - 3) throw new Error(tr('Label content overflows. Choose a larger supported label or review the product text.', 'محتوى الملصق يتجاوز الأبعاد. اختر مقاساً أكبر أو راجع نص الصنف.'));
    }
  }
  function invalidatePreview() { state.preview = null; state.pendingPrint = null; if (get('iu-previews')) get('iu-previews').innerHTML = ''; if (get('iu-preview-section')) get('iu-preview-section').hidden = true; updateActions(); }
  function updateActions() {
    for (const control of get('page-barcodes')?.querySelectorAll('input,select,button') || []) {
      if (control.closest('.iu-scanner')) continue;
      if (state.loading && !control.dataset.iuBusy) { control.dataset.iuBusy = '1'; control.dataset.iuDisabled = String(control.disabled); control.disabled = true; }
      if (!state.loading && control.dataset.iuBusy) { control.disabled = control.dataset.iuDisabled === 'true'; delete control.dataset.iuBusy; delete control.dataset.iuDisabled; }
    }
    if (get('iu-selection')) get('iu-selection').textContent = tr(`${state.selected.size} selected (maximum 100)`, `تم تحديد ${state.selected.size} (الحد الأقصى 100)`);
    const blocked = !state.ready || !state.dataReady || state.searching || state.loading;
    if (get('iu-preview')) get('iu-preview').disabled = blocked || !state.sizeId || !state.selected.size;
    if (get('iu-print')) get('iu-print').disabled = blocked || !state.preview || !hasPerm('inventory-units-print');
    for (const id of ['iu-query', 'iu-status', 'iu-search', 'iu-size', 'iu-open-scanner']) if (get(id)) get(id).disabled = !state.ready || state.loading;
    for (const input of get('iu-units')?.querySelectorAll('input') || []) input.disabled = blocked;
    if (get('iu-select-page')) get('iu-select-page').disabled = blocked || !state.rows.length;
    if (get('iu-clear')) get('iu-clear').disabled = state.loading || !state.selected.size;
    if (get('iu-prev')) get('iu-prev').disabled = blocked || state.page <= 1;
    if (get('iu-next')) get('iu-next').disabled = blocked || state.page * (state.limit || 30) >= state.total;
    if (get('iu-stat-units')) get('iu-stat-units').textContent = state.dataReady ? String(state.total) : '—';
    if (get('iu-stat-selected')) get('iu-stat-selected').textContent = String(state.selected.size);
    if (get('iu-stat-page')) get('iu-stat-page').textContent = state.dataReady ? String(state.rows.length) : '—';
    if (get('iu-preview-count')) get('iu-preview-count').textContent = tr(`${state.selected.size} selected`, `المحدد: ${state.selected.size}`);
  }
  function selectedIds() { return [...state.selected].sort(); }
  const receiptLineKey = (invoiceId, lineIndex) => `${invoiceId}:${lineIndex}`;
  function selectReceiptLine(invoiceId, lineIndex) {
    const key = receiptLineKey(invoiceId, lineIndex), cursor = state.receiptCursors.get(key);
    if (cursor && cursor.added >= cursor.total && !cursor.pending.length) state.receiptCursors.delete(key);
    state.receiptSelections.add(key);
  }
  function updateReceiptSelectionUi() {
    const list = get('iu-receipt-list'); if (!list) return;
    list.querySelectorAll('.iu-receipt-card').forEach(card => {
      const invoiceId = card.dataset.receiptId;
      const boxes = [...card.querySelectorAll('.iu-select-receipt-line')];
      const selected = boxes.filter(box => state.receiptSelections.has(receiptLineKey(invoiceId, box.dataset.lineIndex)));
      const selectedUnits = (state.receipts.find(invoice => invoice.transactionId === invoiceId)?.lines || [])
        .filter(line => state.receiptSelections.has(receiptLineKey(invoiceId, line.lineIndex)))
        .reduce((sum, line) => sum + Math.max(0, Number(line.createdUnits) - (state.receiptCursors.get(receiptLineKey(invoiceId, line.lineIndex))?.added || 0)), 0);
      const all = card.querySelector('.iu-select-invoice');
      if (all) { all.checked = boxes.length > 0 && selected.length === boxes.length; all.indeterminate = selected.length > 0 && selected.length < boxes.length; all.disabled = !boxes.length || state.loading; }
      card.querySelectorAll('.iu-select-receipt-line').forEach(box => { box.checked = state.receiptSelections.has(receiptLineKey(invoiceId, box.dataset.lineIndex)); box.disabled = state.loading; });
      const add = card.querySelector('.iu-add-invoice-labels');
      if (add) { add.disabled = !selected.length || state.loading || state.selected.size >= 100; add.textContent = tr(`Add ${selectedUnits} unit label(s)`, `إضافة ${selectedUnits} ملصق قطعة`); }
    });
  }
  async function addReceiptSelection(invoiceId) {
    if (state.loading) return;
    const invoice = state.receipts.find(item => item.transactionId === invoiceId);
    if (!invoice) return;
    const lines = (invoice.lines || []).filter(line => state.receiptSelections.has(receiptLineKey(invoiceId, line.lineIndex)) && line.createdUnits > 0 && !invoice.cancelled);
    if (!lines.length) { message(tr('Select at least one product that already has unit barcodes.', 'حدد منتجًا واحدًا على الأقل له أكواد قطع مسجلة.'), true); return; }
    state.loading = true; updateActions(); updateReceiptSelectionUi();
    let addedCount = 0;
    try {
      for (const line of lines) {
        const key = receiptLineKey(invoiceId, line.lineIndex);
        let cursor = state.receiptCursors.get(key);
        if (cursor && cursor.added >= cursor.total && !cursor.pending.length) cursor = null;
        cursor ||= { page: 1, pending: [], added: 0, total: Math.max(0, Number(line.createdUnits) || 0) };
        while (state.selected.size < 100 && (cursor.pending.length || cursor.page <= Math.ceil(cursor.total / 100))) {
          if (!cursor.pending.length) {
            const params = new URLSearchParams({ q: line.unassignedUnits ? line.sku : '', page: String(cursor.page), limit: '100', purchaseTransactionId: invoiceId, ...(line.unassignedUnits ? {} : { purchaseLineId: line.lineId }) });
            const result = await api('/inventory-units?' + params);
            if (!Array.isArray(result.units) || !Number.isSafeInteger(result.total)) throw new Error('Invalid unit list response');
            cursor.total = result.total; cursor.page++;
            cursor.pending = result.units.map(unit => String(unit._id));
            if (!cursor.pending.length) break;
          }
          const id = cursor.pending.shift(); cursor.added++;
          if (!state.selected.has(id)) { state.selected.add(id); addedCount++; }
        }
        state.receiptCursors.set(key, cursor);
        if (cursor.added >= cursor.total && !cursor.pending.length && cursor.total > 0) state.receiptSelections.delete(key);
        if (state.selected.size >= 100) break;
      }
      if (!addedCount) message(tr('These products have no additional registered units to label.', 'لا توجد قطع مسجلة إضافية لهذه المنتجات لإضافتها.'), true);
      else message(tr(`${addedCount} unit label(s) added. Choose label size, preview, then print.`, `تمت إضافة ${addedCount} ملصق قطعة. اختر المقاس ثم عاين واطبع.`) + (state.selected.size >= 100 ? tr(' Batch limit reached; print or clear this batch to continue.', ' وصلت الدفعة للحد الأقصى؛ اطبعها أو امسح تحديدها للمتابعة.') : ''));
      invalidatePreview(); updateActions(); updateReceiptSelectionUi();
    } catch (error) { message(error.message || tr('Could not add invoice units to the label batch.', 'تعذرت إضافة قطع الفاتورة إلى دفعة الملصقات.'), true); updateActions(); }
    finally { state.loading = false; updateActions(); updateReceiptSelectionUi(); }
  }
  async function loadPurchaseReceipts() {
    const section = get('iu-receipts');
    if (!section || !hasPerm('purchase-view')) { if (section) section.hidden = true; return; }
    section.hidden = false;
    const list = get('iu-receipt-list');
    list.innerHTML = '<div class="iu-skeleton"></div>';
    try {
      const invoices = await api('/inventory-units/purchases/receipts');
      state.receipts = Array.isArray(invoices) ? invoices : [];
      list.innerHTML = state.receipts.slice(0, 10).map(invoice => {
        const when = invoice.date ? new Date(invoice.date).toLocaleDateString(typeof currentLang !== 'undefined' && currentLang === 'en' ? 'en-GB' : 'ar-EG') : '—';
        const lines = (invoice.lines || []).map(line => {
          const complete = Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.createdUnits >= line.quantity;
          const canSelect = line.createdUnits > 0 && !invoice.cancelled;
          const status = invoice.cancelled ? tr('Cancelled · review only', 'ملغاة · للعرض فقط') : complete
            ? tr(`${line.createdUnits}/${line.quantity} units coded`, `${line.createdUnits} من ${line.quantity} قطعة لها أكواد`)
            : line.createdUnits > 0 ? tr(`${line.createdUnits}/${line.quantity} coded · incomplete`, `${line.createdUnits} من ${line.quantity} لها أكواد · غير مكتمل`)
              : tr('No unit barcodes recorded', 'لم تُسجل أكواد للقطع');
          const guidance = !invoice.cancelled && !line.createdUnits
            ? `<small class="iu-receipt-guidance">${tr('This invoice was saved without per-unit tracking. Confirm physical stock and register it through receiving/reconciliation before printing.', 'حُفظت الفاتورة دون تتبع لكل قطعة. أكّد وجود المخزون فعليًا وسجّله عبر الاستلام أو المطابقة قبل الطباعة.')}</small>` : '';
          const lineCheckbox = canSelect ? `<label class="iu-receipt-select"><input class="iu-select-receipt-line" type="checkbox" data-line-index="${html(line.lineIndex)}" ${state.receiptSelections.has(receiptLineKey(invoice.transactionId, line.lineIndex)) ? 'checked' : ''}><span>${tr('Include all registered units', 'تحديد كل القطع المسجلة')}</span></label>` : '';
          const registerForm = !invoice.cancelled && hasPerm('inventory-units-receive') && line.createdUnits < line.quantity
            ? `<details class="iu-receive-details"><summary>${tr('Register physically present units', 'تسجيل القطع الموجودة فعليًا')}</summary><form class="iu-register-form" data-receipt-id="${html(invoice.transactionId)}" data-line-index="${html(line.lineIndex)}" data-sku="${html(line.sku)}" data-filter-line="${html(line.unassignedUnits ? '' : line.lineId)}" data-quantity="${html(line.quantity)}" data-existing="${html(line.onHandUnits || 0)}"><label>${tr('Physical count now', 'العدد الموجود فعليًا الآن')}<input name="physicalQuantity" type="number" min="${Math.max(1, line.onHandUnits || 0)}" max="${html(line.quantity)}" step="1" required></label><label>${tr('Warehouse / location', 'المخزن / الموقع')}<input name="warehouseCode" maxlength="120" required></label><label>${tr('Count evidence / reason', 'مرجع الجرد / السبب')}<input name="reason" maxlength="1000" required></label><label class="iu-receive-confirm"><input name="physicalPossessionConfirmed" type="checkbox" required><span>${tr('I counted these exact pieces in the warehouse.', 'أؤكد أنني عددت هذه القطع فعليًا داخل المخزن.')}</span></label><button class="btn btn-primary" type="submit">${tr('Create missing unit IDs', 'إنشاء معرفات القطع الناقصة')}</button><small>${tr('Creates labels only for the confirmed on-hand count. It does not add stock or repeat the purchase.', 'ينشئ أكوادًا للعدد الموجود والمؤكد فقط. لا يضيف مخزونًا ولا يكرر فاتورة الشراء.')}</small></form></details>` : '';
          return `<article class="iu-receipt-line${canSelect ? ' is-selectable' : ''}"><div class="iu-receipt-product-heading"><div><strong>${html(line.name || line.sku || tr('Purchase item', 'صنف مشتريات'))}</strong><span class="iu-unit-sku"><bdi>${html(line.sku)}</bdi></span></div>${lineCheckbox}</div><div class="iu-receipt-metrics"><span><small>${tr('Invoice quantity', 'كمية الفاتورة')}</small><b>${html(line.quantity)}</b></span><span><small>${tr('Unit codes', 'القطع ذات الأكواد')}</small><b>${html(line.createdUnits)} / ${html(line.quantity)}</b></span><span><small>${tr('In stock', 'الموجود بالمخزن')}</small><b>${html(line.onHandUnits || 0)}</b></span></div><div class="iu-receipt-progress"><i style="width:${line.quantity > 0 ? Math.min(100, Math.round(line.createdUnits / line.quantity * 100)) : 0}%"></i></div><small class="iu-receipt-state" data-ready="${complete}">${html(status)}</small>${guidance}${registerForm}</article>`;
        }).join('');
        const selectableCount = (invoice.lines || []).filter(line => line.createdUnits > 0 && !invoice.cancelled).length;
        const selectedCount = (invoice.lines || []).filter(line => state.receiptSelections.has(receiptLineKey(invoice.transactionId, line.lineIndex)) && line.createdUnits > 0 && !invoice.cancelled).length;
        return `<article class="iu-card iu-receipt-card" data-receipt-id="${html(invoice.transactionId)}"><header><div><span class="iu-eyebrow">${tr('PURCHASE INVOICE', 'فاتورة شراء')}</span><strong><bdi>#${html(invoice.ref || invoice.transactionId.slice(-6))}</bdi></strong></div><span>${html(when)}</span></header><p>${html(invoice.supplier || tr('Supplier not specified', 'المورد غير محدد'))}</p><div class="iu-receipt-toolbar"><label class="iu-receipt-select"><input class="iu-select-invoice" type="checkbox" ${selectableCount && selectedCount === selectableCount ? 'checked' : ''} ${selectableCount ? '' : 'disabled'}><span>${tr('Select all coded products', 'تحديد كل المنتجات ذات الأكواد')}</span></label><button class="btn btn-primary iu-add-invoice-labels" type="button" ${selectedCount ? '' : 'disabled'}>${tr('Add selected products to label batch', 'إضافة المنتجات المحددة لدفعة الملصقات')}</button></div><div class="iu-receipt-lines">${lines || `<small>${tr('No invoice items.', 'لا توجد أصناف في الفاتورة.')}</small>`}</div></article>`;
      }).join('') || emptyState(tr('No purchase invoices found.', 'لا توجد فواتير مشتريات.'), tr('New supplier invoices will appear here for barcode review.', 'ستظهر فواتير المورد الجديدة هنا لمراجعة الباركود.'));
      updateReceiptSelectionUi();
    } catch (error) {
      list.innerHTML = emptyState(tr('Purchase invoices could not be loaded.', 'تعذر تحميل فواتير المشتريات.'), error.message || tr('Check purchase-view permission and retry.', 'تحقق من صلاحية عرض المشتريات وأعد المحاولة.'));
    }
  }
  function openReceiptLine(transactionId, lineId, sku = '') {
    state.purchaseTransactionId = transactionId; state.purchaseLineId = lineId;
    state.q = lineId ? '' : sku;
    if (get('iu-query')) get('iu-query').value = state.q;
    state.page = 1; state.selected.clear(); invalidatePreview();
    history.replaceState(null, '', `#barcodes/receipt/${encodeURIComponent(transactionId)}/${encodeURIComponent(lineId)}`);
    const notice = get('iu-receipt-filter');
    if (notice) {
      notice.className = 'iu-notice'; notice.replaceChildren();
      notice.append(document.createTextNode(tr('Filtered to invoice line: ', 'تصفية حسب سطر الفاتورة: ') + transactionId + ' · ' + (lineId || sku) + ' '));
      const clear = document.createElement('button'); clear.className = 'btn btn-outline'; clear.textContent = tr('Show all units', 'عرض كل الوحدات');
      clear.onclick = () => { state.purchaseTransactionId = ''; state.purchaseLineId = ''; state.q = ''; if (get('iu-query')) get('iu-query').value = ''; history.replaceState(null, '', '#barcodes'); state.selected.clear(); invalidatePreview(); notice.replaceChildren(); notice.className = ''; load(); };
      notice.append(clear);
    }
    load();
  }
  async function preview() {
    if (!state.ready || !state.dataReady || state.searching || state.loading || !state.sizeId || !state.selected.size) return;
    state.loading = true; updateActions(); message(tr('Preparing preview…', 'جار تجهيز المعاينة…'));
    try {
      const ids = selectedIds(), sizeId = state.sizeId;
      const batch = validateBatch(await post('/labels/preview', { unitIds: ids, sizeId, operationKey: requestKey(), reason: 'Label preview only' }), ids, sizeId);
      state.preview = batch; state.pendingPrint = null;
      get('iu-preview-section').hidden = false;
      get('iu-previews').innerHTML = batch.labels.map(label => labelHtml(label, batch.size)).join('');
      await waitForLayout(get('iu-previews'));
      message(tr('Preview validated. Check paper dimensions before printing.', 'تم التحقق من المعاينة. راجع أبعاد الورق قبل الطباعة.'));
    } catch (error) { state.preview = null; message(error.message, true); }
    finally { state.loading = false; updateActions(); }
  }
  async function print() {
    if (!state.ready || !state.dataReady || state.searching || state.loading || !state.preview || !hasPerm('inventory-units-print')) return;
    const popup = window.open('', '_blank', 'width=800,height=700');
    if (!popup) { message(tr('Allow popups to open the print preview.', 'اسمح بالنوافذ المنبثقة لفتح معاينة الطباعة.'), true); return; }
    popup.document.body.textContent = tr('Preparing labels…', 'جار تجهيز الملصقات…');
    state.loading = true; updateActions();
    try {
      const ids = selectedIds(), sizeId = state.sizeId;
      // Keep the same key/payload after network failure or uncertain response; explicit successful reprints get a new key.
      if (!state.pendingPrint) state.pendingPrint = { unitIds: ids, sizeId, operationKey: requestKey(), reason: 'Operator requested browser label printing; physical outcome unverified' };
      const batch = validateBatch(await post('/labels/requests', state.pendingPrint), ids, sizeId);
      const size = batch.size;
      popup.document.open();
      popup.document.write(`<!doctype html><html><head><meta charset="UTF-8"><title>Unit labels</title><link rel="stylesheet" href="${location.origin}/inventory-units.css?v=20261019-3">
        <style>@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}html,body{margin:0;padding:0;background:white}.iu-label{break-after:page;page-break-after:always;print-color-adjust:exact;-webkit-print-color-adjust:exact}.iu-label:last-child{break-after:auto;page-break-after:auto}</style></head><body>${batch.labels.map(label => labelHtml(label, size)).join('')}</body></html>`);
      popup.document.close();
      await new Promise((resolve, reject) => {
        const css = popup.document.querySelector('link');
        if (css.sheet) resolve(); else { css.onload = resolve; css.onerror = () => reject(new Error('Print stylesheet failed to load')); }
      });
      await waitForLayout(popup.document);
      if (popup.closed) throw new Error(tr('Print window closed. The request is recorded; physical printing is unverified.', 'أُغلقت نافذة الطباعة. الطلب مسجل ولم يتم تأكيد الطباعة الفعلية.'));
      popup.focus(); popup.print(); state.pendingPrint = null;
      message(tr('Print request recorded. The dialog may have been cancelled; physical printing is unverified. Use 100% scale, zero margins and matching paper size; disable headers/footers.', 'تم تسجيل طلب الطباعة. قد يكون الحوار أُلغي؛ الطباعة الفعلية غير مؤكدة. استخدم مقياس 100٪ وهوامش صفر وأبعاد الورق المطابقة، وأوقف رؤوس وتذييلات الصفحة.'));
    } catch (error) { popup.close(); message(error.message + tr(' Retry uses the same request key.', ' إعادة المحاولة تستخدم نفس مفتاح الطلب.'), true); }
    finally { state.loading = false; updateActions(); }
  }
  async function load() {
    if (!state.ready) return;
    const sequence = ++state.requestNumber;
    state.searching = true; state.dataReady = false; get('iu-error').hidden = true; updateActions();
    get('iu-units').setAttribute('aria-busy', 'true');
    get('iu-units').innerHTML = '<div class="iu-skeleton"></div><div class="iu-skeleton"></div><div class="iu-skeleton"></div>';
    message(tr('Loading units…', 'جار تحميل الوحدات…'));
    try {
      const result = await api('/inventory-units?' + new URLSearchParams({ q: state.q, status: state.status, page: String(state.page), limit: '30', ...(state.purchaseTransactionId ? { purchaseTransactionId: state.purchaseTransactionId } : {}), ...(state.purchaseLineId ? { purchaseLineId: state.purchaseLineId } : {}) }));
      if (sequence !== state.requestNumber) return;
      if (!Array.isArray(result.units) || !Array.isArray(result.products) || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.limit) || result.limit < 1) throw new Error('Invalid barcode service response');
      state.rows = result.units; state.total = result.total; state.limit = result.limit; state.dataReady = true;
      get('iu-products').innerHTML = result.products.map(product => `<article class="iu-card iu-product-card"><span class="iu-product-icon">${icon('box')}</span><div><h3>${html(product.name)}</h3><p><span class="iu-caption">SKU</span> <code>${html(product.code)}</code></p><p class="iu-muted">${html(product.size)} ${html((product.colors || []).join(' · '))}</p></div></article>`).join('') || emptyState(tr('No matching products.', 'لا توجد أصناف مطابقة.'), tr('Try a different name or SKU.', 'جرب اسمًا أو SKU آخر.'));
      get('iu-products-count').textContent = String(result.products.length);
      get('iu-product-limit').textContent = result.productsTruncated ? tr('Showing the first 100 products. Refine your search; unit results still include all matches.', 'يتم عرض أول 100 صنف. ضيق البحث؛ نتائج الوحدات تشمل جميع المطابقات.') : '';
      get('iu-units').innerHTML = result.units.map(unit => `<article class="iu-card iu-unit-row"><div class="iu-unit-heading"><label><input type="checkbox" data-unit-id="${html(unit._id)}" ${state.selected.has(String(unit._id)) ? 'checked' : ''} aria-label="${html(tr('Select unit ', 'تحديد الوحدة ') + unit.barcode)}"><span><strong>${html(unit.product?.name || tr('Missing product', 'صنف غير موجود'))}</strong><span class="iu-unit-sku">SKU <code>${html(unit.product?.code)}</code></span></span></label><span class="iu-status" data-status="${html(unit.status)}">${html(statusLabel(unit.status))}</span></div>
        <dl><div><dt>${tr('Barcode', 'الباركود')}</dt><dd><code>${html(unit.barcode)}</code></dd></div><div><dt>${tr('Unit ID', 'معرف الوحدة')}</dt><dd><code>${html(unit._id)}</code></dd></div><div><dt>${tr('Location', 'الموقع')}</dt><dd>${html(unit.warehouseCode || tr('Unverified', 'غير مؤكد'))}</dd></div></dl></article>`).join('') || emptyState(tr('No tracked units.', 'لا توجد وحدات مسجلة.'), state.q || state.status ? tr('Try another search or clear the filters.', 'جرب بحثًا آخر أو امسح الفلاتر.') : tr('Units appear after verified physical registration or confirmed purchase receiving. This page does not create stock.', 'تظهر الوحدات بعد التسجيل الفعلي المتحقق منه أو استلام المشتريات المؤكد. هذه الصفحة لا تنشئ مخزونًا.'));
      get('iu-page').textContent = tr(`Page ${state.page} · ${result.total} units`, `صفحة ${state.page} · ${result.total} وحدة`);
      get('iu-connection').textContent = tr('Connected', 'متصل'); get('iu-connection').dataset.state = 'ready';
      message('');
    } catch (error) {
      if (sequence !== state.requestNumber) return;
      state.rows = []; state.total = 0;
      get('iu-units').innerHTML = emptyState(tr('Units could not be loaded', 'تعذر تحميل الوحدات'), tr('Retry the connection to continue.', 'أعد محاولة الاتصال للمتابعة.'));
      get('iu-products').replaceChildren(); get('iu-products-count').textContent = '—'; get('iu-page').textContent = '—';
      connectionError(error);
    } finally {
      if (sequence === state.requestNumber) { state.searching = false; get('iu-units').setAttribute('aria-busy', 'false'); updateActions(); }
    }
  }
  window.renderBarcodeManagement = async function () {
    const render = ++state.renderNumber; ++state.requestNumber; clearTimeout(state.searchTimer);
    state.scanner?.destroy(); state.scanner = null;
    const root = get('page-barcodes'); if (!root) return;
    if (!hasPerm('inventory-units-view')) { root.innerHTML = emptyState(tr('Permission denied.', 'ليس لديك صلاحية.'), tr('Ask an administrator for access to inventory units.', 'اطلب من المسؤول صلاحية الوصول إلى الوحدات.')); return; }
    state.selected.clear(); state.receiptSelections.clear(); state.receiptCursors.clear(); state.page = 1; state.q = ''; state.status = ''; state.sizeId = ''; state.preview = null; state.pendingPrint = null;
    state.config = null; state.ready = false; state.dataReady = false; state.searching = false; state.rows = []; state.total = 0;
    const receiptHash = location.hash.match(/^#barcodes\/receipt\/([a-f\d]{24})(?:\/([^/]+))?$/i);
    state.purchaseTransactionId = receiptHash?.[1] || '';
    state.purchaseLineId = receiptHash?.[2] ? decodeURIComponent(receiptHash[2]) : '';
    root.innerHTML = `<header class="iu-header"><div class="iu-title-group"><span class="iu-eyebrow">${tr('INVENTORY / UNIT IDENTITIES', 'المخزون / هويات الوحدات')}</span><h1>${tr('Barcode management', 'إدارة الباركود')}</h1><p>${tr('Find a unit. Scan its identity. Print its label.', 'ابحث عن الوحدة، تحقق من هويتها، واطبع ملصقها.')}</p></div><div class="iu-header-actions"><span id="iu-connection" class="iu-connection" data-state="loading" role="status">${tr('Connecting…', 'جار الاتصال…')}</span><button id="iu-refresh" class="btn btn-outline" type="button" aria-label="${tr('Refresh barcode data', 'تحديث بيانات الباركود')}">${icon('refresh')}</button><button id="iu-open-scanner" class="btn btn-primary" type="button" disabled>${icon('scan')}${tr('Open unit scanner', 'فتح ماسح الوحدات')}</button></div></header>
      <div class="iu-explainer"><span>${icon('scan')}${tr('One physical unit. One unique barcode.', 'وحدة فعلية واحدة، باركود فريد واحد.')}</span><p>${tr('A product SKU is shared. Unit IDs and QR barcodes identify individual pieces.', 'SKU مشترك للصنف. معرف الوحدة وباركود QR يميزان كل قطعة.')}</p><span class="iu-policy-badge">${tr('Tracking enforcement is OFF', 'فرض التتبع غير مفعل')}</span></div>
      <div id="iu-receipt-filter"></div><section id="iu-scanner-host" hidden></section>
      <section id="iu-receipts" class="iu-panel iu-receipts" hidden><div class="iu-panel-heading"><div><span class="iu-eyebrow">${tr('PURCHASE RECEIPTS', 'استلامات المشتريات')}</span><h2>${tr('Recent purchase invoices', 'فواتير الشراء الجديدة')}</h2><p>${tr('Select a whole invoice or individual products; only registered physical units enter the label batch.', 'حدد فاتورة كاملة أو منتجات بعينها؛ تُضاف القطع المسجلة فعليًا فقط إلى دفعة الملصقات.')}</p></div>${icon('box')}</div><div id="iu-receipt-list" class="iu-receipt-list"></div></section>
      <section id="iu-error" class="iu-error" role="alert" hidden><div><strong id="iu-error-title"></strong><p id="iu-error-detail"></p></div><button id="iu-retry" class="btn btn-outline" type="button">${tr('Try again', 'إعادة المحاولة')}</button></section>
      <div class="iu-stats"><div><span>${tr('Matching units', 'الوحدات المطابقة')}</span><strong id="iu-stat-units">—</strong><small>${tr('Across filtered results', 'ضمن نتائج البحث')}</small></div><div><span>${tr('Selected for labels', 'المحدد للملصقات')}</span><strong id="iu-stat-selected">0</strong><small>${tr('Maximum 100 per batch', 'حتى 100 في الدفعة')}</small></div><div><span>${tr('Units on this page', 'الوحدات في هذه الصفحة')}</span><strong id="iu-stat-page">—</strong><small>${tr('Select individually or by page', 'حدد وحدة أو الصفحة')}</small></div></div>
      <form id="iu-search-form" class="iu-search-panel"><label class="iu-search-field"><span>${tr('Find products or units', 'البحث عن الأصناف أو الوحدات')}</span><span class="iu-search-input">${icon('search')}<input id="iu-query" type="search" maxlength="160" placeholder="${tr('Product, SKU, size, color, barcode or Unit ID', 'اسم الصنف، SKU، المقاس، اللون، الباركود أو معرف الوحدة')}" disabled></span></label><label class="iu-filter-field"><span>${tr('Unit status', 'حالة الوحدة')}</span><select id="iu-status" disabled><option value="">${tr('All statuses', 'كل الحالات')}</option></select></label><button id="iu-search" class="btn btn-outline" type="submit" disabled>${tr('Search', 'بحث')}</button></form>
      <div id="iu-message" role="status" aria-live="polite"></div>
      <div class="iu-workspace"><section class="iu-panel iu-unit-panel"><div class="iu-panel-heading"><div><h2>${tr('Physical units — unique identities', 'الوحدات الفعلية — هويات فريدة')}</h2><p>${tr('Select the pieces you want to label.', 'حدد القطع التي تريد طباعة ملصقاتها.')}</p></div>${icon('box')}</div><div class="iu-actions"><button id="iu-select-page" class="btn btn-outline" type="button" disabled>${tr('Select this page', 'تحديد هذه الصفحة')}</button><button id="iu-clear" class="btn btn-outline" type="button" disabled>${tr('Clear selection', 'إلغاء التحديد')}</button><span id="iu-selection"></span></div>
      <div id="iu-units" class="iu-units" aria-busy="true"><div class="iu-skeleton"></div><div class="iu-skeleton"></div></div><div class="iu-pagination"><span id="iu-page">—</span><div><button id="iu-prev" class="btn btn-outline" type="button" disabled>${tr('Previous', 'السابق')}</button><button id="iu-next" class="btn btn-outline" type="button" disabled>${tr('Next', 'التالي')}</button></div></div></section>
      <aside class="iu-panel iu-label-panel" aria-label="${tr('Label printing', 'طباعة الملصقات')}"><div class="iu-panel-heading"><div><span class="iu-eyebrow">${tr('LABEL WORKSPACE', 'مساحة الملصقات')}</span><h2>${tr('Prepare your labels', 'جهز ملصقاتك')}</h2></div>${icon('printer')}</div><div class="iu-label-steps"><span class="iu-step-number">1</span><p>${tr('Select existing physical units', 'حدد وحدات فعلية مسجلة')}</p><span class="iu-step-number">2</span><p>${tr('Match your label paper size', 'طابق مقاس ورق الملصقات')}</p><span class="iu-step-number">3</span><p>${tr('Preview, then print', 'عاين ثم اطبع')}</p></div>
      <label class="iu-size-field">${tr('Label dimensions', 'أبعاد الملصق')}<select id="iu-size" disabled><option value="">${tr('Choose matching label stock', 'اختر مقاس الملصقات الفعلي')}</option></select></label><div class="iu-label-meta"><span id="iu-preview-count">${tr('0 selected', 'المحدد: 0')}</span><span>QR</span></div><button id="iu-preview" class="btn btn-outline iu-full-button" type="button" disabled>${tr('Preview selected', 'معاينة المحدد')}</button><button id="iu-print" class="btn btn-primary iu-full-button" type="button" disabled>${icon('printer')}${tr('Print / reprint', 'طباعة / إعادة طباعة')}</button><p class="iu-print-note">${tr('Reprinting keeps the same Unit ID and barcode.', 'إعادة الطباعة تحتفظ بمعرف الوحدة والباركود نفسه.')}</p><details class="iu-print-help"><summary>${tr('Printer setup', 'إعداد الطابعة')}</summary><p>${tr('One label per page. Use 100% scale, zero margins and matching paper size; disable browser headers and footers. Verify scans with your actual printer and labels. Opening the dialog does not confirm physical printing.', 'ملصق واحد لكل صفحة. استخدم مقياس 100٪ وهوامش صفر ومقاس الورق المطابق، وأوقف رؤوس وتذييلات المتصفح. اختبر المسح بالطابعة والملصقات الفعلية. فتح الحوار لا يؤكد الطباعة الفعلية.')}</p></details></aside></div>
      <section id="iu-preview-section" class="iu-panel iu-preview-section" hidden><div class="iu-panel-heading"><div><h2>${tr('Label preview', 'معاينة الملصقات')}</h2><p>${tr('Exact unit identities, at the selected label dimensions.', 'هويات الوحدات الأصلية بأبعاد الملصق المحدد.')}</p></div>${icon('check')}</div><div id="iu-previews" class="iu-previews"></div></section>
      <details class="iu-catalog iu-panel"><summary><span>${icon('box')}<span>${tr('Products — shared SKU', 'الأصناف — SKU مشترك')}</span><span id="iu-products-count" class="iu-count">—</span></span><span class="iu-muted">${tr('View catalog', 'عرض الكتالوج')}</span></summary><p class="iu-catalog-note">${tr('Products describe a style or variant. Print labels from physical units above.', 'الأصناف تصف المنتج أو التنويعة. اطبع الملصقات من الوحدات الفعلية أعلاه.')}</p><p id="iu-product-limit"></p><div id="iu-products" class="iu-products"></div></details>`;
    get('iu-refresh').onclick = () => window.renderBarcodeManagement();
    get('iu-receipt-list').onclick = event => { const button = event.target.closest('.iu-add-invoice-labels'); if (button) addReceiptSelection(button.closest('.iu-receipt-card').dataset.receiptId); };
    get('iu-receipt-list').onchange = event => {
      const box = event.target;
      if (box.matches('.iu-select-invoice')) {
        const card = box.closest('.iu-receipt-card'), id = card.dataset.receiptId;
        card.querySelectorAll('.iu-select-receipt-line').forEach(line => box.checked ? selectReceiptLine(id, line.dataset.lineIndex) : state.receiptSelections.delete(receiptLineKey(id, line.dataset.lineIndex)));
      } else if (box.matches('.iu-select-receipt-line')) {
        const key = receiptLineKey(box.closest('.iu-receipt-card').dataset.receiptId, box.dataset.lineIndex);
        if (box.checked) selectReceiptLine(box.closest('.iu-receipt-card').dataset.receiptId, box.dataset.lineIndex); else state.receiptSelections.delete(key);
      } else {
        const form = box.closest('.iu-register-form'); if (form) delete form.dataset.operationKey;
      }
      updateReceiptSelectionUi();
    };
    get('iu-receipt-list').onsubmit = async event => {
      const form = event.target.closest('.iu-register-form'); if (!form) return;
      event.preventDefault(); if (form.dataset.busy) return;
      const physicalQuantity = Number(form.elements.physicalQuantity.value);
      const existing = Number(form.dataset.existing), quantity = Number(form.dataset.quantity);
      if (!Number.isSafeInteger(physicalQuantity) || physicalQuantity < Math.max(1, existing) || physicalQuantity > quantity || !form.elements.physicalPossessionConfirmed.checked) {
        message(tr('Enter the exact physical count, within the remaining invoice quantity, and confirm the count.', 'أدخل العدد الفعلي ضمن كمية الفاتورة وأكد إجراء الجرد.'), true); return;
      }
      form.dataset.busy = '1'; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try {
        const transactionId = form.dataset.receiptId, lineIndex = Number(form.dataset.lineIndex);
        if (!form.dataset.operationKey) form.dataset.operationKey = requestKey();
        const result = await api(`/inventory-units/purchases/${encodeURIComponent(transactionId)}/lines/${lineIndex}/identify`, { method: 'POST', body: JSON.stringify({
          sku: form.dataset.sku, expectedQuantity: quantity, physicalQuantity, warehouseCode: form.elements.warehouseCode.value.trim(),
          physicalPossessionConfirmed: true, reason: form.elements.reason.value.trim(), operationKey: form.dataset.operationKey,
        }) });
        if (!result?.lineId || !Number.isSafeInteger(result.createdUnits) || result.createdUnits < 1 || result.stockChanged !== false) throw new Error('Invalid identity registration response');
        delete form.dataset.operationKey;
        message(tr(`${result.createdUnits} unit ID(s) recorded. The purchase and stock balance were not changed.`, `تم تسجيل ${result.createdUnits} معرف قطعة. لم تتغير الفاتورة أو كمية المخزون.`));
        state.receiptCursors.delete(receiptLineKey(transactionId, lineIndex));
        selectReceiptLine(transactionId, lineIndex);
        await loadPurchaseReceipts(); updateReceiptSelectionUi();
      } catch (error) { message(error.message || tr('Could not register physical units.', 'تعذر تسجيل القطع الفعلية.'), true); }
      finally { delete form.dataset.busy; if (submit?.isConnected) submit.disabled = false; }
    };
    get('iu-receipt-list').oninput = event => { const form = event.target.closest('.iu-register-form'); if (form) delete form.dataset.operationKey; };
    get('iu-search-form').onsubmit = event => { event.preventDefault(); if (!state.ready) return; clearTimeout(state.searchTimer); state.q = get('iu-query').value; state.status = get('iu-status').value; state.page = 1; load(); };
    get('iu-query').oninput = () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => get('iu-search-form')?.requestSubmit(), 300); };
    get('iu-status').onchange = () => get('iu-search-form').requestSubmit();
    get('iu-size').onchange = event => { state.sizeId = event.target.value; invalidatePreview(); };
    get('iu-units').onchange = event => {
      const id = event.target.dataset.unitId; if (!id || !state.dataReady || state.loading) return;
      if (event.target.checked && state.selected.size >= 100) { event.target.checked = false; message(tr('Maximum 100 units per batch.', 'الحد الأقصى 100 وحدة لكل دفعة.'), true); return; }
      event.target.checked ? state.selected.add(id) : state.selected.delete(id); invalidatePreview();
    };
    get('iu-select-page').onclick = () => {
      if (!state.dataReady || state.loading) return;
      for (const unit of state.rows) { if (state.selected.size >= 100) break; state.selected.add(String(unit._id)); }
      for (const checkbox of get('iu-units').querySelectorAll('input')) checkbox.checked = state.selected.has(checkbox.dataset.unitId);
      invalidatePreview();
      if (state.rows.some(unit => !state.selected.has(String(unit._id)))) message(tr('The batch limit is 100. Select and print this batch before adding more units.', 'حد الدفعة 100 قطعة. اطبع هذه الدفعة أو امسح تحديدها قبل إضافة وحدات أخرى.'), true);
    };
    get('iu-clear').onclick = () => { if (state.loading) return; state.selected.clear(); for (const checkbox of get('iu-units').querySelectorAll('input')) checkbox.checked = false; invalidatePreview(); };
    get('iu-prev').onclick = () => { if (state.searching || state.loading || state.page <= 1) return; state.page--; load(); };
    get('iu-next').onclick = () => { if (state.searching || state.loading || !state.dataReady || state.page * state.limit >= state.total) return; state.page++; load(); };
    get('iu-preview').onclick = preview; get('iu-print').onclick = print;
    if (!hasPerm('inventory-units-print')) get('iu-print').title = tr('Printing permission required', 'تتطلب صلاحية الطباعة');
    if (state.purchaseTransactionId) {
      const notice = get('iu-receipt-filter'); notice.className = 'iu-notice';
      notice.textContent = tr('Filtered to purchase invoice: ', 'تصفية حسب فاتورة المشتريات: ') + state.purchaseTransactionId + ' ';
      const clear = document.createElement('button'); clear.className = 'btn btn-outline'; clear.textContent = tr('Show all receipts', 'عرض كل الاستلامات');
      clear.onclick = () => { state.purchaseTransactionId = ''; history.replaceState(null, '', '#barcodes'); state.selected.clear(); invalidatePreview(); notice.replaceChildren(); notice.className = ''; state.page = 1; load(); };
      notice.append(clear);
    }
    updateActions();
    try {
      const config = await api('/inventory-units/config');
      if (render !== state.renderNumber) return;
      if (!Array.isArray(config.statuses) || !Array.isArray(config.labelSizes) || config.symbology && config.symbology !== 'QR') throw new Error('Unsupported barcode configuration');
      state.config = config; state.ready = true;
      get('iu-status').insertAdjacentHTML('beforeend', config.statuses.map(status => `<option value="${html(status)}">${html(statusLabel(status))}</option>`).join(''));
      get('iu-size').insertAdjacentHTML('beforeend', config.labelSizes.map(size => `<option value="${html(size.id)}">${html(size.widthMm)} × ${html(size.heightMm)} mm · QR</option>`).join(''));
      if (window.SouliaScanner) get('iu-open-scanner').onclick = () => {
        const actor = typeof currentUser !== 'undefined' ? currentUser : null; const actorId = actor?._id || actor?.id || actor?.userId || actor?.username;
        if (!actorId) { message(tr('Authenticated user required.', 'يلزم مستخدم مسجل الدخول.'), true); return; }
        const host = get('iu-scanner-host');
        if (state.scanner && !state.scanner.client.destroyed) { host.querySelector('[data-scan-input]')?.focus(); host.scrollIntoView({ block: 'nearest' }); return; }
        host.hidden = false; state.scanner = window.SouliaScanner.mount(host, { api, actorId: String(actorId), workflowKey: 'barcode-lookup', context: { intent: 'lookup' }, lang: typeof currentLang === 'undefined' ? 'ar' : currentLang, canManualSelect: hasPerm('inventory-units-manual-select') });
        host.querySelector('[data-scan-input]')?.focus();
      };
      else { get('iu-open-scanner').hidden = true; }
      await loadPurchaseReceipts();
      await load();
    } catch (error) {
      if (render !== state.renderNumber) return;
      state.ready = false; state.dataReady = false;
      get('iu-units').innerHTML = emptyState(tr('Connect to view inventory units', 'اتصل لعرض وحدات المخزون'), tr('Your data and label tools will appear once the service is available.', 'ستظهر بياناتك وأدوات الملصقات عند إتاحة الخدمة.'));
      get('iu-units').setAttribute('aria-busy', 'false'); connectionError(error, true); updateActions();
    }
  };
  window.InventoryUnitLabels = { labelHtml, validateBatch, waitForLayout };
  if (typeof currentPage !== 'undefined' && currentPage === 'barcodes') window.renderBarcodeManagement();
}());


