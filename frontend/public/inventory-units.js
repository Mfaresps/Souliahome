/* Barcode workspace: server-issued physical identities only; selection never creates stock. */
(function () {
  'use strict';
  const VERSION = '20261024-compact-registry';
  const state = {
    generation: 0, actor: '', ready: false, busy: false, selectionBusy: false, refreshQueued: false, config: null,
    selected: new Map(), sizeId: '', preview: null, pendingPrint: null, view: 'receipts',
    receipts: [], receiptPage: 0, receiptTotal: 0, receiptQuery: '', receiptFilter: 'all', receiptRequest: 0,
    receiptLoading: false, activeInvoice: null, productQuery: '', productFilter: 'all', ranges: new Map(),
    page: 1, limit: 30, total: 0, q: '', status: '', rows: [], unitsReady: false, unitLoading: false, unitRequest: 0,
    unitScope: null, unitDialogRequest: 0, registration: null, registrationRequests: new Map(),
    receiptTimer: null, unitTimer: null,
    pieceAction: null, pieceActionRequest: 0,
    stockScope: null,
    labelAudit: null,
  };
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const get = id => document.getElementById(id);
  const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const has = permission => hasPerm(permission);
  const post = (path, body) => api('/inventory-units' + path, { method: 'POST', body: JSON.stringify(body) });
  const requestKey = () => {
    if (!globalThis.crypto?.randomUUID) throw new Error(tr('Use a secure browser connection.', 'استخدم اتصال متصفح آمنًا.'));
    return crypto.randomUUID();
  };
  const statuses = {
    available: ['Available', 'متاحة'], reserved: ['Reserved', 'محجوزة'], picking: ['Picking', 'قيد التحضير'],
    prepared: ['Prepared', 'مجهزة'], shipped: ['Shipped', 'مع شركة الشحن'], delivered: ['Delivered', 'تم تسليمها'],
    returned: ['Returned', 'مرتجعة'], 'inspection-required': ['Awaiting quality inspection', 'بانتظار فحص الجودة'],
    damaged: ['Damaged', 'تالفة'], 'returned-to-supplier': ['Returned to supplier', 'مرتجعة للمورد'],
    'supplier-return-pending': ['Reserved for supplier return', 'محجوزة لمرتجع مورد'],
    lost: ['Lost', 'مفقودة'], retired: ['Retired', 'مستبعدة'],
  };
  const statusLabel = value => statuses[value] ? tr(...statuses[value]) : value;
  const statusTone = value => ['available', 'delivered'].includes(value) ? 'ready' : ['reserved', 'picking', 'prepared', 'shipped', 'supplier-return-pending'].includes(value) ? 'progress' : ['returned', 'inspection-required', 'damaged', 'lost'].includes(value) ? 'attention' : 'quiet';
  function pieceStatus(unit, interactive = false) {
    unit = { ...unit, status: unit.displayStatus || unit.status };
    const label = html(statusLabel(unit.status));
    return interactive ? `<button type="button" class="iu-status-pill" data-tone="${statusTone(unit.status)}" data-piece-actions="${html(unit._id)}" aria-label="${html(tr('Open actions & history: ', 'فتح الإجراءات والسجل: ') + statusLabel(unit.status))}"><i aria-hidden="true"></i>${label}${icon('eye')}</button>` : `<span class="iu-status-pill" data-tone="${statusTone(unit.status)}"><i aria-hidden="true"></i>${label}</span>`;
  }
  const icons = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    scan: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M8 8v8M11 8v8M14 8v8M17 8v8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    printer: '<path d="M7 8V3h10v5M7 17H3V8h18v9h-4M7 14h10v7H7zM17 11h.01"/>',
    box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M8 5l9 4"/>',
    refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.box}</svg>`;
  function productImage(line, compact = false) {
    const source = typeof line.imageUrl === 'string' ? line.imageUrl.trim() : '';
    let safe = '';
    try {
      const url = new URL(source, location.href);
      if (source && (['http:', 'https:'].includes(url.protocol) || /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i.test(source))) safe = source;
    } catch (_) { /* A missing or invalid image uses the product icon. */ }
    return `<span class="iu-product-mark ${compact ? 'iu-product-thumbnail' : ''}">${icon('box')}${safe ? `<img data-product-image src="${html(safe)}" alt="${html(line.name || line.sku)}" loading="lazy" decoding="async">` : ''}</span>`;
  }
  const emptyState = (title, detail = '') => `<div class="iu-empty">${icon('box')}<strong>${html(title)}</strong><p>${html(detail)}</p></div>`;
  const totals = invoice => (invoice?.lines || []).reduce((s, line) => ({ qty: s.qty + line.quantity, coded: s.coded + line.createdUnits }), { qty: 0, coded: 0 });
  const sourceKey = (invoice, line) => invoice.transactionId + ':' + line.lineIndex;
  const readonly = invoice => invoice.cancelled || /-RET$/i.test(invoice.ref);
  const selectedIds = () => [...state.selected.keys()].sort();
  const lineSelected = key => [...state.selected.values()].filter(unit => unit.sourceKey === key);
  const invoiceDate = invoice => {
    const date = new Date(invoice.date);
    return invoice.date && Number.isFinite(date.getTime()) ? date.toLocaleDateString(tr('en-GB', 'ar-EG')) : '—';
  };
  function message(text, error = false) {
    const el = get('iu-message');
    if (el) { el.classList.remove('iu-print-success'); el.textContent = text; el.dataset.error = String(error); }
    const dialog = document.querySelector('#page-barcodes dialog[open]');
    const local = dialog?.querySelector('[data-dialog-message]');
    if (local) { local.classList.remove('iu-print-success'); local.textContent = text; local.dataset.error = String(error); }
  }
  function printSuccess(count, target) {
    const success = tr(`Successfully sent ${count} label(s) to print.`, `تم إرسال ${count} ملصق للطباعة بنجاح.`);
    if (!target) message(success);
    const targets = target ? [target] : [get('iu-message'), get('iu-preview-section')?.querySelector('[data-dialog-message]')];
    for (const element of targets.filter(Boolean)) {
      element.classList.add('iu-print-success'); element.dataset.error = 'false';
      element.innerHTML = `${icon('check')}<span><strong>${tr('All labels sent to print', 'أُرسلت جميع الملصقات للطباعة')}</strong><small>${html(success)}</small></span>`;
    }
    if (typeof toast === 'function') toast(success);
  }
  function confirmReprint(labels) {
    return new Promise(resolve => {
      const prompt=document.createElement('dialog');let popup=null;
      prompt.className='iu-reprint-confirm';prompt.dir=tr('ltr','rtl');prompt.setAttribute('aria-label',tr('Confirm reprinting','تأكيد إعادة الطباعة'));
      prompt.innerHTML=`<h2>${tr('These labels were printed before','سبق إرسال هذه الملصقات للطباعة')}</h2><p>${tr(`Reprint ${labels.length} previously requested label(s)? The same identities will be used.`,`هل تريد إعادة طباعة ${labels.length} ملصق سبق طلب طباعته؟ ستُستخدم نفس الهويات.`)}</p><div class="iu-reprint-history">${labels.slice(0,8).map(label=>`<div><code dir="ltr">${html(label.manualCode||label.barcode)}</code><span>${tr('Previous requests: ','الطلبات السابقة: ')}<b>${Number(label.printCount)||0}</b></span></div>`).join('')}</div><p data-confirm-error role="alert"></p><footer><button type="button" data-cancel>${tr('Cancel','إلغاء')}</button><button type="button" data-confirm>${tr('Reprint labels','إعادة طباعة الملصقات')}</button></footer>`;
      document.body.append(prompt);
      prompt.addEventListener('close',()=>{prompt.remove();resolve(popup);},{once:true});
      prompt.querySelector('[data-cancel]').onclick=()=>prompt.close();
      prompt.querySelector('[data-confirm]').onclick=()=>{
        popup=window.open('','_blank','width=850,height=750');
        if(!popup){prompt.querySelector('[data-confirm-error]').textContent=tr('Allow popups for this site, then try again.','اسمح بالنوافذ المنبثقة لهذا الموقع ثم حاول مجددًا.');return;}
        popup.document.body.textContent=tr('Preparing labels…','جارٍ تجهيز الملصقات…');prompt.close();
      };
      prompt.showModal();prompt.querySelector('[data-cancel]').focus();
    });
  }
  function showDialog(id) {
    const dialog = get(id); dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog(id) {
    if (state.busy) return;
    const printedIds = id === 'iu-preview-section' ? state.preview?.printedIds : null;
    const dialog = get(id); dialog?.close();
    if (dialog) dialog.hidden = true;
    if (printedIds?.length) {
      for (const unitId of printedIds) {
        const unit = state.selected.get(unitId);
        if (unit?.sourceKey) state.ranges.delete(unit.sourceKey);
        state.selected.delete(unitId);
      }
      selectionChanged();
    }
    if (id === 'iu-units-dialog') { state.unitScope = null; ++state.unitDialogRequest; }
    if (id === 'iu-action-dialog') { state.pieceAction = null; ++state.pieceActionRequest; }
  }
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function revealSurface(element) {
    if (!element || reduceMotion()) return;
    element.getAnimations().forEach(animation => animation.cancel());
    element.animate([{ opacity: .65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 190, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  // Keep existing cards, scroll positions and keyboard focus while selection changes.
  function patchContent(target, source) {
    if (target.nodeType !== source.nodeType || target.nodeName !== source.nodeName) { target.replaceWith(source.cloneNode(true)); return; }
    if (target.nodeType === Node.TEXT_NODE) { if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue; return; }
    if (target.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of [...target.attributes]) {
      if (!source.hasAttribute(attr.name) && !(attr.name === 'hidden' && target.matches('img[data-product-image]'))) target.removeAttribute(attr.name);
    }
    for (const attr of source.attributes) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    if (target instanceof HTMLInputElement) {
      target.checked = source.checked;
      if (target.value !== source.value) target.value = source.value;
    }
    const incoming = [...source.childNodes];
    incoming.forEach((child, index) => {
      if (target.childNodes[index]) patchContent(target.childNodes[index], child);
      else target.appendChild(child.cloneNode(true));
    });
    while (target.childNodes.length > incoming.length) target.lastChild.remove();
  }
  function patchCards(host, markup, attribute) {
    const template = document.createElement('template'); template.innerHTML = markup;
    const next = [...template.content.children], existing = new Map([...host.children].map(node => [node.getAttribute(attribute), node]));
    const focused = document.activeElement, focusAttribute = ['data-select-line', 'data-line-count', 'data-line-start', 'data-invoice-id'].find(name => focused?.hasAttribute(name));
    const focusValue = focusAttribute ? focused.getAttribute(focusAttribute) : null, restoreFocus = host.contains(focused);
    next.forEach((candidate, index) => {
      const key = candidate.getAttribute(attribute), old = key === null ? null : existing.get(key);
      const card = old || candidate;
      if (old) {
        existing.delete(key); patchContent(old, candidate);
      }
      if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
    });
    for (const node of existing.values()) node.remove();
    if (restoreFocus && focusAttribute) [...host.querySelectorAll('[' + focusAttribute + ']')].find(node => node.getAttribute(focusAttribute) === focusValue)?.focus({ preventScroll: true });
  }
  function syncSizePicker() {
    const picker = get('iu-size-picker'); if (!picker) return;
    const size = state.config?.labelSizes.find(s => s.id === state.sizeId);
    get('iu-size-selected').textContent = size ? `${size.widthMm} × ${size.heightMm} mm` : tr('Choose label size', 'اختر مقاس الملصق');
    picker.querySelectorAll('[data-paper-size]').forEach(button => { const selected = button.dataset.paperSize === state.sizeId; button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected)); });
    picker.querySelector('summary').setAttribute('aria-disabled', String(!state.ready || state.busy));
    if (!state.ready || state.busy) picker.open = false;
  }
  function paperPickerHtml() {
    return `<div class="iu-size-field"><span id="iu-size-label">${tr('Printer paper size', 'مقاس ورق الطابعة')}</span><select id="iu-size" class="iu-native-size" tabindex="-1" aria-hidden="true" disabled><option value="">${tr('Choose matching label stock', 'اختر مقاس ورق الملصقات')}</option></select><details id="iu-size-picker" class="iu-size-picker"><summary aria-labelledby="iu-size-label iu-size-selected">${icon('printer')}<span id="iu-size-selected"></span><svg viewBox="0 0 24 24" class="iu-size-chevron"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></summary><div id="iu-size-options" class="iu-size-options" role="listbox" aria-labelledby="iu-size-label"></div></details></div>`;
  }
  function invalidatePreview() {
    state.preview = null; state.pendingPrint = null;
    const dialog = get('iu-preview-section');
    if (dialog?.open) dialog.close();
    if (dialog) dialog.hidden = true;
    if (get('iu-previews')) get('iu-previews').replaceChildren();
  }
  function setBusy(value, selectionOnly = false) {
    if (value) {
      const focused = document.activeElement;
      const attribute = ['data-select-line', 'data-line-count', 'data-line-start', 'data-invoice-id'].find(name => focused?.hasAttribute(name));
      state.focusReturn = attribute ? { attribute, value: focused.getAttribute(attribute) } : null;
    }
    state.busy = value; state.selectionBusy = value && selectionOnly;
    updateActions();
    if (!value && state.focusReturn) {
      const { attribute, value: focusValue } = state.focusReturn;
      const target = [...(get('page-barcodes')?.querySelectorAll('[' + attribute + ']') || [])].find(node => node.getAttribute(attribute) === focusValue);
      const dialog = get('page-barcodes')?.querySelector('dialog[open]');
      if (target && !target.disabled && (!dialog || dialog.contains(target))) target.focus({ preventScroll: true });
      state.focusReturn = null;
    }
    if (!value && state.refreshQueued) { state.refreshQueued = false; refreshData(); }
  }
  function updateActions() {
    for (const control of get('page-barcodes')?.querySelectorAll('input,select,button') || []) {
      if (control.closest('.iu-scanner')) continue;
      if (state.busy && !state.selectionBusy && !control.dataset.iuBusy) { control.dataset.iuBusy = '1'; control.dataset.iuDisabled = String(control.disabled); control.disabled = true; }
      if (!state.busy && control.dataset.iuBusy) { control.disabled = control.dataset.iuDisabled === 'true'; delete control.dataset.iuBusy; delete control.dataset.iuDisabled; }
    }
    const blocked = !state.ready || state.busy;
    for (const control of get('page-barcodes')?.querySelectorAll('[data-piece-actions]') || []) control.disabled = blocked;
    get('page-barcodes')?.classList.toggle('iu-selecting', state.selectionBusy);
    syncSizePicker();
    if (get('iu-select-invoice')) get('iu-select-invoice').disabled = blocked || !state.activeInvoice || readonly(state.activeInvoice) || !state.activeInvoice.lines.some(line => line.createdUnits > 0);
    for (const control of get('page-barcodes')?.querySelectorAll('[data-select-line],[data-register-line],[data-view-line]') || []) {
      const index = Number(control.dataset.selectLine ?? control.dataset.registerLine ?? control.dataset.viewLine), line = state.activeInvoice?.lines.find(row => row.lineIndex === index);
      control.disabled = blocked || !line || (control.dataset.selectLine !== undefined && (!line.createdUnits || readonly(state.activeInvoice)));
    }
    for (const id of ['iu-preview', 'iu-mobile-preview']) if (get(id)) get(id).disabled = blocked || !state.selected.size || !state.sizeId;
    if (get('iu-print')) get('iu-print').disabled = blocked || !state.preview || !has('inventory-units-print');
    for (const id of ['iu-size', 'iu-query', 'iu-status', 'iu-search']) if (get(id)) get(id).disabled = blocked;
    if (get('iu-clear')) get('iu-clear').disabled = state.busy || !state.selected.size;
    if (get('iu-select-page')) {
      const allSelected = state.rows.length > 0 && state.rows.every(unit => state.selected.has(String(unit._id)));
      get('iu-select-page').disabled = blocked || !state.unitsReady || state.unitLoading || !state.rows.length;
      get('iu-select-page').textContent = allSelected ? tr('Deselect this page', 'إلغاء تحديد الصفحة') : tr('Select this page', 'تحديد الصفحة');
      get('iu-select-page').setAttribute('aria-pressed', String(allSelected));
    }
    if (get('iu-prev')) get('iu-prev').disabled = blocked || state.unitLoading || state.page <= 1;
    if (get('iu-next')) get('iu-next').disabled = blocked || !state.unitsReady || state.unitLoading || state.page * state.limit >= state.total;
    if (get('iu-more-receipts')) get('iu-more-receipts').disabled = blocked || state.receiptLoading || state.receipts.length >= state.receiptTotal;
    get('page-barcodes')?.setAttribute('aria-busy', String(state.busy));
  }

    function labelHtml(label, size) {
    if (!(label.isPack ? /^PK-[A-F\d]{24}$/ : /^SU-[A-F\d]{24}$/).test(label.barcode) || label.barcode !== (label.isPack ? 'PK-' : 'SU-') + String(label.unitId).toUpperCase() || (label.isPack && (!Number.isSafeInteger(label.quantity) || label.quantity < 2))) throw new Error(tr('Invalid label identity. Refresh the selection.', 'هوية الملصق غير صحيحة. حدّث التحديد.'));
    const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(label.svg);
    const idGroups = String(label.unitId).match(/.{1,4}/g);
    const groupedId = html(idGroups.slice(0, 3).join(' ')) + '<br>' + html(idGroups.slice(3).join(' '));
    const printTime = new Date();
    const printDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(printTime);
    const invoiceDate = label.invoiceDate ? new Date(label.invoiceDate) : null;
    const invoiceDateText = invoiceDate && Number.isFinite(invoiceDate.getTime()) ? new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',day:'2-digit',month:'2-digit',year:'numeric'}).format(invoiceDate) : (label.invoiceDates?.length > 1 ? 'Multiple dates' : '');
    const price = typeof label.sellPrice === 'number' && Number.isFinite(label.sellPrice) && label.sellPrice >= 0
      ? 'EGP ' + new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(label.sellPrice) : tr('Price unavailable', 'السعر غير متاح');
    return `<article class="iu-label${label.isPack ? " iu-label-pack" : ""}${size.widthMm <= 50 ? ' iu-label-compact' : size.widthMm >= 100 ? ' iu-label-large' : ''}${size.id === '50x25' ? ' iu-label-50x25' : ''}" style="--label-width:${Number(size.widthMm)}mm;--label-height:${Number(size.heightMm)}mm;--qr-size:${Number(size.qrMm)}mm;--label-margin:${Number(size.marginMm || 2)}mm" aria-label="${html(label.barcode)}">
      <div class="iu-label-header"><time class="iu-label-print-date" datetime="${printTime.toISOString()}">Print: ${html(printDate)}</time><div class="iu-label-brand">SOULIA HOME</div></div>
      <div class="iu-label-layout"><img src="${source}" alt="${html(label.barcode)}"><div class="iu-label-text"><p class="iu-label-name" dir="auto">${html(label.productName)}</p>
      <div class="iu-label-price">${label.isPack ? `<b class="iu-pack-piece-count">${label.quantity} PCS / ${label.quantity} &#1602;&#1591;&#1593;</b>` : html(price)}</div>
      <p class="iu-label-sku">SKU: ${html(label.sku)}</p>${invoiceDateText ? `<div class="iu-label-date iu-label-invoice-date" dir="ltr">Inv: ${html(invoiceDateText)}</div>` : ''}<p class="iu-label-id">${label.isPack ? "Pack" : "Unit"} code:<br><span>${label.manualCode ? html(label.manualCode) : groupedId}</span></p></div></div><p class="iu-label-value${label.manualCode && !label.isPack ? ' iu-short-code' : ''}">${html(label.manualCode || label.barcode)}</p></article>`;
  }
  function validateBatch(batch, expectedIds, sizeId, config = state.config) {
    if (!batch || batch.size?.id !== sizeId || !Array.isArray(config?.labelSizes) || !config.labelSizes.some(size => size.id === sizeId && size.widthMm === batch.size.widthMm && size.heightMm === batch.size.heightMm && size.qrMm === batch.size.qrMm)) throw new Error(tr('Unsupported label dimensions.', 'أبعاد الملصق غير مدعومة.'));
    if (!Array.isArray(batch.labels)) throw new Error(tr('Invalid label response. Retry printing.', 'استجابة الملصقات غير صالحة. أعد محاولة الطباعة.'));
    const actual = batch.labels.map(label => String(label.unitId));
    if (actual.length !== expectedIds.length || new Set(actual).size !== actual.length || expectedIds.some(id => !actual.includes(id))) throw new Error(tr('Label selection mismatch or duplicates.', 'الملصقات لا تطابق التحديد أو تحتوي على تكرار.'));
    if (new Set(batch.labels.map(label => label.barcode)).size !== actual.length) throw new Error(tr('Duplicate barcodes in this batch. Refresh the selection.', 'توجد باركودات مكررة في الدفعة. حدّث التحديد.'));
    batch.labels.forEach(label => labelHtml(label, batch.size));
    return batch;
  }
  async function waitForLayout(doc) {
    await Promise.all([...doc.querySelectorAll('img')].map(img => img.complete ? (img.naturalWidth ? Promise.resolve() : Promise.reject(new Error('Barcode image failed to load'))) : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Barcode image failed to load')); })));
    const fonts = (doc.ownerDocument || doc).fonts;
    if (fonts?.ready) await fonts.ready;
    // Keep the QR at its physical size; fit only the product name and SKU into
    // the compact label's text area, above the separate piece code.
    for (const label of doc.querySelectorAll('.iu-label-50x25')) {
      const text = label.querySelector('.iu-label-text');
      const view = label.ownerDocument.defaultView;
      const fits = () => {
        const box = text.getBoundingClientRect();
        const scale = box.height / text.offsetHeight;
        const bottom = box.bottom - parseFloat(view.getComputedStyle(text).paddingBottom) * scale;
        return [...text.children].filter(child => view.getComputedStyle(child).display !== 'none').every(child => {
          const rect = child.getBoundingClientRect();
          return rect.top >= box.top - .5 && rect.bottom <= bottom + .5 && child.scrollWidth <= child.clientWidth + 1;
        });
      };
      const fields = [[text.querySelector('.iu-label-name'), 2], [text.querySelector('.iu-label-sku'), 1.6]];
      // Reset before measuring so preview zoom and print use identical fitting.
      for (const [field] of fields) field.style.removeProperty('font-size');
      for (let step = 0; !fits() && step < 20; step++) {
        let changed = false;
        for (const [field, minMm] of fields) {
          const current = parseFloat(view.getComputedStyle(field).fontSize), minimum = minMm * 96 / 25.4;
          if (current > minimum + .01) { field.style.fontSize = Math.max(minimum, current - .25) + 'px'; changed = true; }
        }
        if (!changed) break;
      }
      if (!fits()) throw new Error(tr('Product text is too long for this label. Shorten the name/SKU or choose a larger label.', 'نص الصنف أطول من مساحة الملصق. اختصر الاسم أو SKU أو اختر مقاسًا أكبر.'));
    }
    // Check actual rendered content, including long names/SKUs; never silently shrink the barcode.
    for (const label of doc.querySelectorAll('.iu-label:not(.iu-label-separator)')) {
      const content = label.querySelector('.iu-label-value').getBoundingClientRect(), box = label.getBoundingClientRect();
      if (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 || content.bottom > box.bottom - 3) throw new Error(tr('Label content overflows. Choose a larger supported label or review the product text.', 'محتوى الملصق يتجاوز الأبعاد. اختر مقاساً أكبر أو راجع نص الصنف.'));
    }
  }


  function validateUnit(unit) {
    if (!unit || !/^[a-f\d]{24}$/i.test(String(unit._id)) || unit.barcode !== 'SU-' + String(unit._id).toUpperCase()) throw new Error(tr('Invalid physical unit identity received.', 'استُقبلت هوية قطعة غير صحيحة.'));
    return unit;
  }
  function decorateUnit(unit) {
    if (unit.sourceKey) return unit;
    const invoice = [state.activeInvoice, ...state.receipts].find(inv => inv?.transactionId === unit.origin?.purchaseTransactionId);
    if (!invoice) return unit;
    const matches = invoice.lines.filter(line => String(line.sku).trim() === String(unit.product?.code || '').trim() && (!unit.origin.purchaseLineId || line.lineId === unit.origin.purchaseLineId));
    return matches.length === 1 ? { ...unit, sourceKey: sourceKey(invoice, matches[0]), invoiceRef: invoice.ref } : unit;
  }
  function selectionChanged() {
    invalidatePreview(); renderBatch(); renderProducts(); syncUnitChecks(); updateActions();
  }
  function syncUnitChecks() {
    for (const box of get('page-barcodes')?.querySelectorAll('[data-unit-id]') || []) {
      box.checked = state.selected.has(box.dataset.unitId);
      box.closest('[data-log-unit]')?.classList.toggle('selected', box.checked);
    }
  }
  function queueGroups() {
    const groups = new Map();
    for (const unit of state.selected.values()) {
      const groupKey = unit.sourceKey || (unit.origin?.purchaseTransactionId || '') + ':' + unit.productId;
      if (!groups.has(groupKey)) groups.set(groupKey, { key: groupKey, name: unit.product?.name || unit.sku || unit.barcode, ref: unit.invoiceRef || '', count: 0 });
      groups.get(groupKey).count++;
    }
    return [...groups.values()];
  }
  function renderBatch() {
    const count = state.selected.size, groups = queueGroups();
    get('iu-stat-selected').textContent = String(count);
    get('iu-capacity').style.width = count + '%';
    get('iu-batch-source').textContent = count ? tr(`${groups.length} product(s) · ${new Set([...state.selected.values()].map(u => u.origin?.purchaseTransactionId || 'other')).size} source(s)`, `${groups.length} منتجات · ${new Set([...state.selected.values()].map(u => u.origin?.purchaseTransactionId || 'other')).size} مصادر`) : tr('No units selected yet', 'لم تحدد قطعًا بعد');
    const queueMarkup = groups.length ? groups.map(group => `<div class="iu-queue-row" data-queue-key="${html(group.key)}"><span><strong dir="auto">${html(group.name)}</strong><small>${group.ref ? tr('Invoice #', 'فاتورة #') + html(group.ref) : tr('Selected from unit registry', 'من سجل القطع')}</small></span><b class="iu-queue-quantity" dir="ltr" title="${html(tr('Selected labels', 'الملصقات المحددة'))}">${group.count}</b><button class="iu-link iu-queue-remove" type="button" data-remove-group="${html(group.key)}" aria-label="${html(tr('Remove ', 'إزالة ') + group.name)}" title="${tr('Remove from selection', 'إزالة من التحديد')}">${icon('close')}</button></div>`).join('') : `<p class="iu-queue-empty">${tr('Select pieces to add their labels here.', 'حدد القطع لإضافة ملصقاتها هنا.')}</p>`;
    patchCards(get('iu-queue'), queueMarkup, 'data-queue-key');
    get('iu-selection').textContent = tr(`${count} selected · maximum 100`, `${count} محدد · الحد الأقصى 100`);
    get('iu-mobile-total').textContent = String(count); get('iu-mobile-bar').hidden = !count;
    const size = state.config?.labelSizes.find(s => s.id === state.sizeId);
    get('iu-paper-size').textContent = size ? `${size.widthMm} × ${size.heightMm} mm` : tr('Choose your label paper size', 'اختر مقاس ورق الملصقات');
    get('iu-preview-hint').textContent = count && !size ? tr('Choose the paper size to enable preview.', 'اختر مقاس الورق لتفعيل المعاينة.') : tr('Reprinting keeps the same unit identity.', 'إعادة الطباعة تحتفظ بهوية القطعة نفسها.');
    updateActions();
  }
  function renderReceipts() {
    const list = state.receipts.filter(inv => {
      const s = totals(inv);
      return state.receiptFilter === 'all' || (state.receiptFilter === 'missing' ? s.coded < s.qty && !readonly(inv) : s.coded >= s.qty && !readonly(inv));
    });
    get('iu-invoice-count').textContent = String(state.receiptTotal);
    get('iu-tab-invoice-count').textContent = String(state.receiptTotal);
    const receiptMarkup = list.map(invoice => {
      const s = totals(invoice), missing = Math.max(0, s.qty - s.coded), active = invoice.transactionId === state.activeInvoice?.transactionId;
      return `<button class="iu-invoice-link ${active ? 'active' : ''}" type="button" data-invoice-id="${html(invoice.transactionId)}" aria-current="${active}"><span class="iu-invoice-top"><strong><bdi>#${html(invoice.ref || invoice.transactionId.slice(-6))}</bdi></strong><time>${html(invoiceDate(invoice))}</time></span><span class="iu-invoice-supplier"><small>${tr('Supplier', 'المورد')}</small><strong dir="auto">${html(invoice.supplier || tr('Unspecified supplier', 'مورد غير محدد'))}</strong></span><span class="iu-invoice-bottom"><small>${invoice.lines.length} ${tr('products', 'منتجات')} · ${s.qty} ${tr('pieces', 'قطعة')}</small><span class="iu-badge ${missing ? 'amber' : ''}">${readonly(invoice) ? tr('Read only', 'للعرض فقط') : missing ? tr('Needs codes', 'تحتاج أكواد') : tr('Codes complete', 'مكتملة الأكواد')}</span></span><span class="iu-invoice-photos" aria-hidden="true">${invoice.lines.slice(0, 3).map(line => productImage(line, true)).join('')}${invoice.lines.length > 3 ? `<small>+${invoice.lines.length - 3}</small>` : ''}</span></button>`;
    }).join('') || emptyState(tr('No matching invoices', 'لا توجد فواتير مطابقة'), tr('Change the search or filter; load more invoices if available.', 'غيّر البحث أو الفلتر، أو حمّل المزيد إن وُجد.'));
    patchCards(get('iu-receipt-list'), receiptMarkup, 'data-invoice-id');
    get('iu-receipt-progress').textContent = tr(`${state.receipts.length} of ${state.receiptTotal} invoices loaded`, `تم تحميل ${state.receipts.length} من ${state.receiptTotal} فاتورة`);
    get('iu-more-receipts').hidden = state.receipts.length >= state.receiptTotal;
    document.querySelectorAll('#page-barcodes [data-receipt-filter]').forEach(button => { button.classList.toggle('active', button.dataset.receiptFilter === state.receiptFilter); button.setAttribute('aria-pressed', String(button.dataset.receiptFilter === state.receiptFilter)); });
    updateActions();
  }
  async function loadReceipts(reset = true) {
    if (!has('purchase-view')) return;
    const request = ++state.receiptRequest, generation = state.generation, page = reset ? 1 : state.receiptPage + 1;
    state.receiptLoading = true; get('iu-receipts-error').hidden = true; updateActions();
    try {
      const response = await api('/inventory-units/purchases/receipts?' + new URLSearchParams({ page: String(page), limit: '20', q: state.receiptQuery }));
      if (generation !== state.generation || request !== state.receiptRequest) return;
      if (!Array.isArray(response.receipts) || !Number.isSafeInteger(response.total)) throw new Error(tr('Invalid invoice response. Refresh the backend.', 'استجابة الفواتير غير صحيحة. يلزم تحديث الخادم.'));
      state.receipts = reset ? response.receipts : [...state.receipts, ...response.receipts.filter(inv => !state.receipts.some(old => old.transactionId === inv.transactionId))];
      state.receiptTotal = response.total; state.receiptPage = page;
      for (const [id, unit] of state.selected) state.selected.set(id, decorateUnit(unit));
      if (!state.activeInvoice && state.receipts.length) chooseInvoice(state.receipts[0]);
      else {
        const updated = state.receipts.find(inv => inv.transactionId === state.activeInvoice?.transactionId);
        if (updated) { state.activeInvoice = updated; renderDetail(); }
      }
      renderReceipts(); renderBatch();
    } catch (error) {
      if (generation !== state.generation || request !== state.receiptRequest) return;
      get('iu-receipts-error').hidden = false; get('iu-receipts-error-text').textContent = error.message || tr('Invoices could not be loaded.', 'تعذر تحميل الفواتير.');
    } finally { if (generation === state.generation && request === state.receiptRequest) { state.receiptLoading = false; updateActions(); } }
  }
  async function fetchInvoice(id) {
    const response = await api('/inventory-units/purchases/receipts?' + new URLSearchParams({ page: '1', transactionId: id }), { background: true });
    if (!Array.isArray(response.receipts) || !response.receipts.length) throw new Error(tr('Purchase invoice not found or inaccessible.', 'الفاتورة غير موجودة أو غير متاحة لحسابك.'));
    return response.receipts[0];
  }
  async function refreshPrintedInvoices(ids) {
    const generation = state.generation;
    const results = await Promise.allSettled(ids.map(id => fetchInvoice(id)));
    if (generation !== state.generation) return;
    for (const result of results) if (result.status === 'fulfilled') {
      const invoice = result.value;
      const index = state.receipts.findIndex(row => row.transactionId === invoice.transactionId);
      if (index >= 0) state.receipts[index] = invoice;
      if (state.activeInvoice?.transactionId === invoice.transactionId) state.activeInvoice = invoice;
    }
    renderProducts();
  }
  function chooseInvoice(invoice, updateHash = true) {
    if (state.activeInvoice === invoice) return;
    state.activeInvoice = invoice; state.productQuery = ''; state.productFilter = 'all';
    if (updateHash) history.replaceState(null, '', '#barcodes/receipt/' + encodeURIComponent(invoice.transactionId));
    renderReceipts(); renderDetail(); revealSurface(get('iu-invoice-detail'));
  }
  function rangeFor(invoice, line) {
    const key = sourceKey(invoice, line);
    if (!state.ranges.has(key)) state.ranges.set(key, { start: 0, count: Math.min(100, line.createdUnits) });
    return state.ranges.get(key);
  }
  function renderDetail() {
    const invoice = state.activeInvoice, host = get('iu-invoice-detail');
    if (!invoice) { host.innerHTML = emptyState(tr('Choose a purchase invoice', 'اختر فاتورة شراء'), tr('Its products and registered unit counts appear here.', 'ستظهر هنا منتجاتها وكميات القطع ذات الأكواد.')); return; }
    const s = totals(invoice), missing = invoice.lines.reduce((sum, line) => sum + Math.max(0, line.quantity - line.createdUnits), 0);
    host.innerHTML = `<header class="iu-detail-head"><div class="iu-detail-title"><h2>${tr('Invoice', 'فاتورة')} <bdi>#${html(invoice.ref || invoice.transactionId.slice(-6))}</bdi></h2><span class="iu-badge ${missing ? 'amber' : ''}">${readonly(invoice) ? tr('Read only invoice', 'فاتورة للعرض فقط') : missing ? tr('Incomplete unit codes', 'أكواد غير مكتملة') : tr('Codes complete', 'مكتملة الأكواد')}</span></div><p class="iu-invoice-meta"><span dir="auto">${html(invoice.supplier || tr('Unspecified supplier', 'مورد غير محدد'))}</span><span>·</span><time>${html(invoiceDate(invoice))}</time></p><div class="iu-invoice-summary"><div><span>${tr('Products', 'منتجات الفاتورة')}</span><b>${invoice.lines.length}</b></div><div><span>${tr('Total pieces', 'إجمالي القطع')}</span><b>${s.qty}</b></div><div><span>${tr('Pieces with codes', 'قطع لها أكواد')}</span><b class="ready">${s.coded}</b></div><div><span>${tr('Codes needed', 'تحتاج تسجيل كود')}</span><b class="${missing ? 'amber' : ''}">${missing}</b></div></div></header>
      ${missing && !readonly(invoice) && !invoice.quantityEditedAt ? `<div class="iu-receipt-notice">${icon('info')}<span>${tr(`${missing} pieces need unit identities before printing. Confirm physical quantities using Register codes on each product.`, `${missing} قطعة تحتاج تسجيل هويتها قبل الطباعة. افتح «تسجيل الأكواد» في المنتج وأكد العدد الفعلي.`)}</span></div>` : ''}
      <div class="iu-product-toolbar"><label class="iu-check"><input id="iu-select-invoice" type="checkbox" ${readonly(invoice) || !invoice.lines.some(line => line.createdUnits) ? 'disabled' : ''}>${tr('Select coded pieces', 'تحديد القطع ذات الأكواد')}</label><div class="iu-product-tools"><label class="iu-field">${icon('search')}<input id="iu-product-query" type="search" maxlength="160" placeholder="${tr('Search products', 'بحث في المنتجات')}" aria-label="${tr('Search invoice products', 'بحث منتجات الفاتورة')}" value="${html(state.productQuery)}"></label><select id="iu-product-filter" aria-label="${tr('Product code status', 'حالة أكواد المنتج')}"><option value="all">${tr('All products', 'كل المنتجات')}</option><option value="ready">${tr('Has codes', 'لها أكواد')}</option><option value="missing">${tr('Needs codes', 'تحتاج أكواد')}</option></select></div></div><div id="iu-receipt-products" class="iu-receipt-products"></div><footer class="iu-detail-footer">${tr('Each label identifies one registered physical piece.', 'كل ملصق يخص قطعة فعلية مسجلة بهوية مستقلة.')}</footer>`;
    const notice = purchaseChangeNotice(invoice);
    if (notice) host.querySelector('.iu-detail-head').insertAdjacentHTML('afterend', notice);
    host.querySelector('[data-review-purchase-units]')?.addEventListener('click', () => openStockUnits({ purchaseTransactionId: invoice.transactionId }));
    get('iu-product-filter').value = state.productFilter;
    renderProducts(); updateActions();
  }
  function purchaseChangeNotice(invoice) {
    const excess = invoice.lines.reduce((sum, line) => sum + Math.max(0, line.createdUnits - line.quantity), 0);
    const orphaned = Number(invoice.orphanedUnits) || 0;
    if (!invoice.quantityEditedAt && !excess && !orphaned) return '';
    const needs = invoice.lines.reduce((sum, line) => sum + Math.max(0, line.quantity - line.createdUnits), 0);
    return `<section class="iu-purchase-change ${excess || orphaned ? 'has-conflict' : ''}" role="status"><strong>${tr('Purchase quantities updated', 'تم تعديل كميات الفاتورة')}</strong><p>${excess || orphaned ? tr('Registered identities do not match the invoice. Review the pieces; do not create replacements for existing codes.', 'الهويات المسجلة لا تطابق الفاتورة. راجع القطع ولا تنشئ أكوادًا بديلة لأكواد موجودة.') : needs ? tr(`${needs} pieces still need codes. Existing identities and print history are preserved.`, `${needs} قطعة تحتاج أكوادًا. الهويات الحالية وسجل الطباعة محفوظان.`) : tr('The remaining products have complete codes. Existing identities are preserved.', 'أكواد المنتجات الحالية مكتملة. الهويات الموجودة محفوظة.')}</p>${invoice.removedProducts?.length ? `<small>${tr('Removed from invoice: ', 'حُذف من الفاتورة: ')}${invoice.removedProducts.map(row => html(row.name || row.sku) + ' (' + Number(row.previousQuantity) + ')').join(' · ')}</small>` : ''}${excess || orphaned ? `<small>${tr(`Excess identities: ${excess} · Identities outside current lines: ${orphaned}`, `هويات زائدة عن الكمية: ${excess} · هويات خارج البنود الحالية: ${orphaned}`)}</small><button type="button" class="iu-link" data-review-purchase-units>${tr('Review invoice pieces', 'مراجعة قطع الفاتورة')}</button>` : ''}</section>`;
  }
  function purchaseLineChange(line) {
    const change = line.change, excess = line.createdUnits > line.quantity;
    if (!change && !excess) return '';
    const needed = Math.max(0, line.quantity - line.createdUnits);
    const label = excess ? tr('Identity count needs review', 'عدد الهويات يحتاج مراجعة') : change.kind === 'added' ? tr('Added product', 'منتج مضاف') : change.delta > 0 ? tr('Quantity increased', 'زادت الكمية') : tr('Quantity reduced', 'انخفضت الكمية');
    return `<div class="iu-line-change ${excess ? 'has-conflict' : ''}"><strong>${html(label)}</strong>${change ? `<span>${tr('Before', 'قبل')} <bdi>${Number(change.previousQuantity)}</bdi> · ${tr('Now', 'الآن')} <bdi>${line.quantity}</bdi></span>` : ''}${needed ? `<small>${tr(`${needed} additional codes needed`, `مطلوب ${needed} كود إضافي`)}</small>` : ''}</div>`;
  }
  function renderProducts() {
    const host = get('iu-receipt-products'), invoice = state.activeInvoice;
    if (!host || !invoice) return;
    const needle = state.productQuery.trim().toLowerCase();
    const lines = invoice.lines.filter(line => (!needle || (line.name + ' ' + line.sku).toLowerCase().includes(needle)) && (state.productFilter === 'all' || (state.productFilter === 'ready' ? line.createdUnits > 0 : line.createdUnits < line.quantity)));
    const markup = lines.map(line => {
      const key = sourceKey(invoice, line), count = lineSelected(key).length, range = rangeFor(invoice, line), complete = line.createdUnits === line.quantity && line.quantity > 0;
      const printed = Number(line.printedUnits) || 0;
      const allPrinted = line.quantity > 0 && printed === line.quantity && line.createdUnits === line.quantity;
      const remainingPrints = Math.max(0, line.quantity - printed);
      const printStatus = line.createdUnits > line.quantity ? tr('Quantity conflict', 'تعارض في الكمية') : allPrinted ? tr(`All labels sent to print (${printed} / ${line.quantity})`, `أُرسلت جميع الملصقات للطباعة (${printed} / ${line.quantity})`) : printed > 0 ? tr(`${printed} / ${line.quantity} sent to print · ${remainingPrints} remaining`, `أُرسل ${printed} من ${line.quantity} للطباعة · متبقي ${remainingPrints}`) : complete ? tr('Ready for labels', 'جاهز لطباعة الملصق') : line.createdUnits ? tr('Partial codes', 'أكواد جزئية') : tr('No codes recorded', 'لم تسجل الأكواد');
      const canRegister = !readonly(invoice) && !Number(invoice.orphanedUnits) && !invoice.lines.some(row => row.createdUnits > row.quantity) && has('inventory-units-receive') && Number.isSafeInteger(line.quantity) && line.quantity > line.createdUnits;
      return `<article class="iu-card iu-receipt-product ${line.change ? 'is-quantity-edited' : ''} ${count ? 'selected' : ''}" data-line-index="${line.lineIndex}"><div class="iu-product-heading"><div class="iu-product-identity">${productImage(line)}<div><h3 dir="auto">${html(line.name || line.sku || tr('Purchase item', 'صنف مشتريات'))}</h3><span class="iu-unit-sku">SKU <bdi>${html(line.sku)}</bdi></span></div></div><input type="checkbox" data-select-line="${line.lineIndex}" aria-label="${html(tr('Select ', 'تحديد ') + (line.name || line.sku))}" ${count ? 'checked' : ''} ${!line.createdUnits || readonly(invoice) ? 'disabled' : ''}></div>${purchaseLineChange(line)}<div class="iu-product-numbers"><span>${tr('Invoice qty', 'كمية الفاتورة')} <b>${line.quantity}</b></span><span>${tr('With codes', 'لها أكواد')} <bdi>${line.createdUnits} / ${line.quantity}</bdi></span></div><div class="iu-product-status"><span class="iu-badge ${allPrinted ? 'is-printed' : printed > 0 ? 'amber' : complete ? '' : line.createdUnits ? 'amber' : 'neutral'}">${allPrinted ? icon('check') : !printed && complete ? icon('clock') : ''}${html(printStatus)}</span><div>${line.createdUnits ? `<button class="iu-link" type="button" data-view-line="${line.lineIndex}">${tr('View pieces', 'عرض القطع')}</button>` : ''}${canRegister ? `<button class="iu-link" type="button" data-register-line="${line.lineIndex}">${tr('Register codes', 'تسجيل الأكواد')}</button>` : ''}</div></div><div class="iu-product-selection-slot ${line.createdUnits > 100 ? 'iu-wide-range' : ''}" ${!line.createdUnits ? 'hidden' : ''}>${count ? range.custom ? `<div class="iu-product-range"><small>${tr(`${count} pieces selected individually. Edit them in View pieces.`, `تم تحديد ${count} قطعة بعينها. عدّلها من عرض القطع.`)}</small></div>` : `<div class="iu-product-range"><label>${tr('Labels in batch', 'ملصقات هذه الدفعة')}<input type="number" min="1" max="${Math.min(100, line.createdUnits - range.start)}" step="1" value="${count}" data-line-count="${line.lineIndex}" aria-label="${html(tr('Label quantity for ', 'كمية ملصقات ') + line.name)}"></label>${line.createdUnits > 100 ? `<label>${tr('From piece', 'بدءًا من القطعة')}<input type="number" min="1" max="${line.createdUnits}" step="1" value="${range.start + 1}" data-line-start="${line.lineIndex}" aria-label="${html(tr('Start piece for ', 'القطعة الأولى لـ ') + line.name)}"></label><small>${tr('Range', 'النطاق')} <bdi>${range.start + 1}–${range.start + count}</bdi> ${tr('of', 'من')} ${line.createdUnits}</small>` : `<small>${tr('of', 'من')} ${line.createdUnits} ${tr('coded pieces', 'قطعة مسجلة')}</small>`}</div>` : line.createdUnits > 100 ? `<small class="iu-range-hint">${tr('Over 100 pieces. Select the product to set the quantity and starting piece.', 'أكثر من 100 قطعة. حدد المنتج لضبط العدد والقطعة التي تبدأ منها.')}</small>` : ''}</div></article>`;
    }).join('') || emptyState(tr('No matching products', 'لا توجد منتجات مطابقة'), tr('Change the search or filter.', 'غيّر البحث أو الفلتر.'));
    const eligible = invoice.lines.filter(line => line.createdUnits > 0), chosen = eligible.filter(line => lineSelected(sourceKey(invoice, line)).length > 0);
    patchCards(host, markup, 'data-line-index');
    const all = get('iu-select-invoice');
    if (all) { all.checked = eligible.length > 0 && eligible.every(line => lineSelected(sourceKey(invoice, line)).length === line.createdUnits); all.indeterminate = chosen.length > 0 && !all.checked; }
    updateActions();
  }
  async function lineRange(invoice, line, start, count) {
    const firstPage = Math.floor(start / 100) + 1, lastPage = Math.floor((start + count - 1) / 100) + 1, rows = [];
    for (let page = firstPage; page <= lastPage; page++) {
      const result = await api(`/inventory-units/purchases/${encodeURIComponent(invoice.transactionId)}/lines/${line.lineIndex}/units?` + new URLSearchParams({ page: String(page), limit: '100' }), { background: true });
      if (!Array.isArray(result.units) || !Number.isSafeInteger(result.total) || start + count > result.total) throw new Error(tr('Unit counts changed. Refresh this invoice before selecting labels.', 'تغير عدد القطع. حدّث الفاتورة قبل تحديد الملصقات.'));
      rows.push(...result.units.map(validateUnit));
    }
    const result = rows.slice(start % 100, start % 100 + count);
    if (result.length !== count || new Set(result.map(u => String(u._id))).size !== count || result.some(u => u.origin?.purchaseTransactionId !== invoice.transactionId || String(u.product?.code || '').trim() !== String(line.sku).trim())) throw new Error(tr('The pieces do not match this invoice product. Refresh before continuing.', 'القطع لا تطابق منتج الفاتورة. حدّث البيانات قبل المتابعة.'));
    return result.map(unit => ({ ...unit, sourceKey: sourceKey(invoice, line), invoiceRef: invoice.ref, sku: line.sku }));
  }
  async function selectLine(lineIndex, chosen, rangeOverride) {
    if (!state.ready || state.busy) return;
    const invoice = state.activeInvoice, line = invoice?.lines.find(l => l.lineIndex === lineIndex);
    if (!line || readonly(invoice) || !line.createdUnits) return;
    const key = sourceKey(invoice, line), previous = lineSelected(key);
    if (!chosen) { previous.forEach(u => state.selected.delete(String(u._id))); selectionChanged(); return; }
    const storedRange = rangeFor(invoice, line);
    const range = rangeOverride || (storedRange.custom ? { start: 0, count: Math.min(100, line.createdUnits) } : storedRange), available = 100 - (state.selected.size - previous.length);
    if (!Number.isSafeInteger(range.start) || range.start < 0 || !Number.isSafeInteger(range.count) || range.count < 1 || range.start + range.count > line.createdUnits || range.count > available) {
      message(tr(`Choose a valid piece range. This batch has room for ${available} labels.`, `اختر نطاق قطع صحيحًا. المتاح في هذه الدفعة ${available} ملصقًا.`), true); renderProducts(); return;
    }
    const generation = state.generation; setBusy(true, true);
    try {
      const units = await lineRange(invoice, line, range.start, range.count);
      if (generation !== state.generation) return;
      previous.forEach(u => state.selected.delete(String(u._id)));
      units.forEach(u => state.selected.set(String(u._id), u));
      state.ranges.set(key, { ...range }); selectionChanged();
      message(tr(`${units.length} registered pieces selected from this product.`, `تم تحديد ${units.length} قطعة مسجلة من هذا المنتج.`));
    } catch (error) { message(error.message, true); renderProducts(); }
    finally { if (generation === state.generation) setBusy(false); }
  }
  async function selectInvoice(checked) {
    const invoice = state.activeInvoice;
    if (!state.ready || !invoice || state.busy || readonly(invoice)) return;
    if (!checked) { for (const [id, unit] of state.selected) if (unit.origin?.purchaseTransactionId === invoice.transactionId) state.selected.delete(id); selectionChanged(); return; }
    const eligible = invoice.lines.filter(line => line.createdUnits > 0), own = [...state.selected.values()].filter(u => u.origin?.purchaseTransactionId === invoice.transactionId).length;
    const needed = eligible.reduce((sum, line) => sum + line.createdUnits, 0);
    if (needed + state.selected.size - own > 100) { message(tr('This invoice exceeds the remaining batch capacity. Select products and set a range of up to 100 pieces.', 'كمية الفاتورة تتجاوز سعة الدفعة. حدد المنتجات واضبط نطاقًا يصل إلى 100 قطعة.'), true); renderProducts(); return; }
    const generation = state.generation; setBusy(true, true);
    try {
      const units = [];
      for (const line of eligible) units.push(...await lineRange(invoice, line, 0, line.createdUnits));
      if (generation !== state.generation) return;
      for (const [id, unit] of state.selected) if (unit.origin?.purchaseTransactionId === invoice.transactionId) state.selected.delete(id);
      units.forEach(unit => state.selected.set(String(unit._id), unit));
      eligible.forEach(line => state.ranges.set(sourceKey(invoice, line), { start: 0, count: line.createdUnits }));
      selectionChanged(); message(tr(`${units.length} invoice pieces selected.`, `تم تحديد ${units.length} قطعة من الفاتورة.`));
    } catch (error) { message(error.message, true); renderProducts(); }
    finally { if (generation === state.generation) setBusy(false); }
  }
  function addUnit(unit, checked) {
    if (state.busy || !state.ready) return;
    try {
      validateUnit(unit);
      if (checked && !state.selected.has(String(unit._id)) && state.selected.size >= 100) throw new Error(tr('Maximum 100 pieces per label batch.', 'الحد الأقصى 100 قطعة في دفعة الملصقات.'));
      checked ? state.selected.set(String(unit._id), unit) : state.selected.delete(String(unit._id));
      if (unit.sourceKey) state.ranges.set(unit.sourceKey, { ...(state.ranges.get(unit.sourceKey) || { start: 0, count: 0 }), custom: true });
      selectionChanged();
    } catch (error) { message(error.message, true); syncUnitChecks(); }
  }
  function openRegistration(lineIndex) {
    if (!state.ready || state.busy || !has('inventory-units-receive')) return;
    const invoice = state.activeInvoice, line = invoice?.lines.find(l => l.lineIndex === lineIndex);
    if (!line || readonly(invoice) || !Number.isSafeInteger(line.quantity) || line.quantity <= line.createdUnits) return;
    state.registration = { invoice, line };
    const form = get('iu-register-form'); form.reset(); form.elements.warehouseCode.value = invoice.warehouseCode || 'MAIN';
    if (!form.elements.warehouseCode.value) form.elements.warehouseCode.dataset.preferredWarehouse = invoice.warehouseCode || 'MAIN';
    else delete form.elements.warehouseCode.dataset.preferredWarehouse;
    form.querySelector('[data-dialog-message]').textContent = '';
    get('iu-register-title').textContent = tr('Register codes · ', 'تسجيل أكواد · ') + (line.name || line.sku);
    get('iu-register-detail').textContent = tr(`Invoice quantity ${line.quantity}. ${line.createdUnits} identities exist, ${line.onHandUnits} are on hand. Enter the total physically counted pieces from this invoice.`, `كمية الفاتورة ${line.quantity}. المسجل ${line.createdUnits} هوية، منها ${line.onHandUnits} في المخزن. أدخل إجمالي ما عددته فعليًا من قطع هذه الفاتورة.`);
    form.elements.physicalQuantity.min = Math.max(1, line.onHandUnits + 1); form.elements.physicalQuantity.max = line.quantity;
    showDialog('iu-register-dialog');
  }
  async function registerUnits(event) {
    event.preventDefault(); if (!state.ready || state.busy || !state.registration || !has('inventory-units-receive')) return;
    const form = event.target; if (!form.reportValidity()) return;
    const { invoice, line } = state.registration, count = Number(form.elements.physicalQuantity.value);
    if (!Number.isSafeInteger(count) || count <= line.onHandUnits || count > line.quantity || !form.elements.physicalPossessionConfirmed.checked) { message(tr('Confirm a valid physical count within the invoice quantity.', 'أكد عددًا فعليًا صحيحًا ضمن كمية الفاتورة.'), true); return; }
    const data = { sku: line.sku, expectedQuantity: line.quantity, physicalQuantity: count, physicalPossessionConfirmed: true, warehouseCode: form.elements.warehouseCode.value.trim(), reason: form.elements.reason.value.trim() };
    if (!data.warehouseCode || !data.reason) { message(tr('Warehouse and count evidence are required.', 'أدخل المخزن ومرجع الجرد.'), true); return; }
    const key = sourceKey(invoice, line), fingerprint = JSON.stringify(data), previous = state.registrationRequests.get(key);
    const pending = previous?.fingerprint === fingerprint ? previous : { fingerprint, payload: { ...data, operationKey: requestKey() } };
    state.registrationRequests.set(key, pending); const generation = state.generation; setBusy(true);
    try {
      const result = await post(`/purchases/${encodeURIComponent(invoice.transactionId)}/lines/${line.lineIndex}/identify`, pending.payload);
      if (generation !== state.generation) return;
      if (!result?.lineId || !Number.isSafeInteger(result.createdUnits) || result.createdUnits < 1 || result.stockChanged !== false) throw new Error(tr('Invalid registration response; refresh before continuing.', 'استجابة التسجيل غير صحيحة؛ حدّث البيانات قبل المتابعة.'));
      state.registrationRequests.delete(key); state.ranges.delete(key);
      get('iu-register-dialog').close(); get('iu-register-dialog').hidden = true;
      message(tr(`${result.createdUnits} unit identities recorded. Stock and purchase quantity were not changed.`, `تم تسجيل ${result.createdUnits} هوية قطعة. لم تتغير كمية الفاتورة أو المخزون.`));
      try {
        const updated = await fetchInvoice(invoice.transactionId);
        if (generation !== state.generation) return;
        state.receipts = state.receipts.map(item => item.transactionId === updated.transactionId ? updated : item);
        if (state.activeInvoice?.transactionId === updated.transactionId) { state.activeInvoice = updated; renderDetail(); }
        renderReceipts();
      } catch { message(tr('Registration succeeded. Refresh invoice data to see the new counts.', 'نجح التسجيل. حدّث بيانات الفاتورة لإظهار الأعداد الجديدة.'), true); }
    } catch (error) { message(error.message, true); }
    finally { if (generation === state.generation) setBusy(false); }
  }
  function unitRows(rows) {
    if (!rows.length) return emptyState(tr('No matching pieces', 'لا توجد قطع مطابقة'), tr('Search by product, SKU or a piece barcode, or change the status filter.', 'ابحث بالمنتج أو SKU أو باركود القطعة، أو غيّر فلتر الحالة.'));
    const body = rows.map(unit => {
      const created = unit.createdAt ? new Date(unit.createdAt) : null;
      const validDate = created && Number.isFinite(created.getTime());
      const origin = unit.origin || {};
      const source = origin.kind === 'purchase' ? tr('Purchase invoice', 'فاتورة شراء') : origin.kind === 'opening-stock' ? tr('Opening stock', 'رصيد افتتاحي') : tr('Existing stock registration', 'تكويد رصيد سابق');
      const purchaseId = String(origin.purchaseTransactionId || '');
      const invoiceLink = has('purchase-view') && /^[a-f\d]{24}$/i.test(purchaseId)
        ? `<a class="iu-link" href="#barcodes/receipt/${encodeURIComponent(purchaseId)}">${html(unit.invoiceRef ? tr('Invoice #', 'فاتورة #') + unit.invoiceRef : tr('Open source invoice', 'فتح فاتورة المصدر'))}</a>` : '';
      return `<tr data-log-unit="${html(unit._id)}" class="${state.selected.has(String(unit._id)) ? 'selected' : ''}">
        <td class="iu-log-select"><input type="checkbox" data-unit-id="${html(unit._id)}" ${state.selected.has(String(unit._id)) ? 'checked' : ''} aria-label="${html(tr('Select unit ', 'تحديد قطعة ') + unit.barcode)}"></td>
        <td class="iu-log-product"><button type="button" class="iu-product-open" data-piece-actions="${html(unit._id)}" dir="auto">${html(unit.product?.name || tr('Unknown product', 'منتج غير معروف'))}</button><span class="iu-unit-sku">SKU <bdi>${html(unit.product?.code || '—')}</bdi></span></td>
        <td class="iu-log-invoice" data-label="${tr('Invoice reference', 'مرجع الفاتورة')}">${unit.invoiceRef ? `<bdi>${html(unit.invoiceRef)}</bdi>` : '<span class="iu-muted">—</span>'}</td>
        <td class="iu-log-identity"><div class="iu-log-code"><code dir="ltr">${html(unit.manualCode || unit.barcode)}</code><button type="button" class="iu-link iu-copy-code" data-copy-barcode="${html(unit.manualCode || unit.barcode)}" aria-label="${html(tr('Copy barcode ', 'نسخ الباركود ') + unit.barcode)}">${icon('copy')}</button></div><details class="iu-log-details"><summary>${tr('Piece details', 'تفاصيل القطعة')}</summary><dl><div><dt>${tr('Unit ID', 'هوية القطعة')}</dt><dd><code dir="ltr">${html(unit._id)}</code></dd></div><div><dt>${tr('Source', 'المصدر')}</dt><dd>${html(source)} ${invoiceLink}</dd></div>${origin.reconciliationRef ? `<div><dt>${tr('Count reference', 'مرجع الجرد')}</dt><dd dir="auto">${html(origin.reconciliationRef)}</dd></div>` : ''}${unit.registeredBy ? `<div><dt>${tr('Registered by', 'سجّلها')}</dt><dd dir="auto">${html(unit.registeredBy)}</dd></div>` : ''}</dl><button type="button" class="iu-link iu-piece-actions" data-piece-actions="${html(unit._id)}">${tr('Piece actions & history', 'إجراءات القطعة وسجلها')}</button></details></td>
        <td class="iu-log-status">${pieceStatus(unit, true)}<div class="iu-row-meta"><button type="button" class="iu-link iu-history-open" data-piece-actions="${html(unit._id)}">${icon('clock')}${tr('History & actions', 'السجل والإجراءات')}</button><span title="${tr('Print requests', 'طلبات الطباعة')}">${icon('printer')}${Number(unit.printCount) || 0}</span></div></td>
        <td class="iu-log-location" data-label="${tr('Warehouse', 'المخزن')}"><span dir="auto" data-warehouse-name="${html(unit.warehouseCode || 'MAIN')}">${html(window.SouliaWarehouses?.name(unit.warehouseCode) || unit.warehouseCode || 'المخزن الرئيسي')}</span></td>
        <td class="iu-log-date" data-label="${tr('Registered', 'التسجيل')}">${validDate ? `<time datetime="${html(created.toISOString())}" title="${html(created.toLocaleString(tr('en-GB', 'ar-EG')))}">${html(created.toLocaleDateString(tr('en-GB', 'ar-EG'), { day: 'numeric', month: 'short', year: 'numeric' }))}</time><small>${html(created.toLocaleTimeString(tr('en-GB', 'ar-EG'), { hour: '2-digit', minute: '2-digit' }))}</small>` : '<span>—</span>'}</td>
      </tr>`;
    }).join('');
    return `<div class="iu-unit-log"><table><caption class="iu-visually-hidden">${tr('Registered pieces, newest first. Each row represents one physical piece.', 'سجل القطع المسجلة، الأحدث أولًا. كل صف يمثل قطعة فعلية واحدة.')}</caption><thead><tr><th scope="col"><span class="iu-visually-hidden">${tr('Select', 'تحديد')}</span>${icon('check')}</th><th scope="col">${tr('Product / SKU', 'المنتج / SKU')}</th><th scope="col" class="iu-col-invoice">${tr('Invoice reference', 'مرجع الفاتورة')}</th><th scope="col">${tr('Piece code', 'كود القطعة')}</th><th scope="col">${tr('Status', 'الحالة')}</th><th scope="col" class="iu-col-warehouse">${tr('Warehouse', 'المخزن')}</th><th scope="col" class="iu-col-registered">${tr('Registered', 'تاريخ التسجيل')}</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const pieceActionLabels = {
    reserve: ['Reserve for customer order', 'حجز لطلب عميل'], release: ['Release from order', 'فك الحجز من الطلب'],
    inspect: ['Confirm sound condition', 'اعتماد الفحص — القطعة سليمة'], damage: ['Record damaged piece', 'تسجيل قطعة تالفة'],
    lost: ['Record loss after physical count', 'تسجيل فقد بعد الجرد'], ship: ['Confirm carrier handover', 'تأكيد التسليم لشركة الشحن'],
    deliver: ['Confirm customer delivery', 'تأكيد التسليم للعميل'], return: ['Receive customer return', 'استلام مرتجع العميل'],
    'supplier-return': ['Link to completed supplier return', 'ربط بمرتجع مورد مكتمل'],
    'receive-supplier-return': ['Receive piece after supplier return reversal', 'استلام القطعة بعد عكس مرتجع المورد'],
  };
  const pieceActionHelp = {
    reserve: ['Assigns this exact piece to a sale line in the same warehouse. Does not deduct stock again.', 'يخصص هذه القطعة لسطر فاتورة عميل من نفس المخزن، دون خصم الرصيد مرة أخرى.'],
    release: ['Removes the order assignment. The piece awaits inspection before reuse.', 'يفك ارتباط القطعة بالطلب ويعيدها لانتظار الفحص قبل استخدامها مجددًا.'],
    inspect: ['Confirms you inspected this piece and found it sound. It becomes available.', 'يؤكد أنك فحصت القطعة وهي سليمة، ويجعلها متاحة للحجز والتحضير.'],
    damage: ['Blocks barcode reservation and preparation. The piece remains physically in the warehouse; aggregate stock is unchanged.', 'يمنع حجز القطعة وتحضيرها بالباركود. تظل بالمخزن فعليًا ولا يغير هذا الإجراء إجمالي الرصيد.'],
    lost: ['Requires a completed physical count. Records the identity as lost; any balance correction is a separate reviewed inventory adjustment.', 'يتطلب جردًا فعليًا. يسجل هوية القطعة كمفقودة؛ تصحيح الرصيد، عند الحاجة، يتم من تسوية المخزون.'],
    ship: ['Use only after physically handing the prepared piece to the carrier. Does not update the carrier order.', 'أكد فقط بعد تسليم القطعة المجهزة فعليًا لشركة الشحن. لا يرسل هذا الإجراء طلبًا لشركة الشحن.'],
    deliver: ['Records confirmed customer delivery for this piece. Does not change the invoice payment.', 'يسجل تأكيد تسليم هذه القطعة للعميل، دون تغيير سداد الفاتورة.'],
    return: ['Records physical custody of the returned piece. Complete the customer return financial process separately; inspect before reuse.', 'يسجل استلام القطعة المرتجعة فعليًا. أكمل المعالجة المالية من مرتجع العميل، وافحص القطعة قبل إتاحتها.'],
    'supplier-return': ['First complete the supplier return from Supplier returns. Then link this exact piece after physical handover. The source invoice, warehouse and quantity must match. No second stock deduction or settlement is posted.', 'أكمل مرتجع المورد أولًا من صفحة مرتجعات الموردين، ثم اربط هذه القطعة بعد تسليمها فعليًا. يجب تطابق فاتورة الشراء والمخزن والكمية. لا يُخصم رصيد ولا تُسجل تسوية مالية مرة ثانية.'],
    'receive-supplier-return': ['The supplier return has been reversed financially. Confirm actual receipt of this exact piece; it will await inspection. No second stock correction is posted.', 'تم عكس مرتجع المورد ماليًا. أكّد استلام هذه القطعة بعينها فعليًا؛ ستعود بانتظار الفحص، دون تعديل الرصيد مرة أخرى.'],
  };
  function actionDialogMarkup() {
    return `<dialog id="iu-action-dialog" class="iu-dialog iu-action-dialog" aria-labelledby="iu-action-title" hidden><form id="iu-action-form"><header class="iu-dialog-header"><h2 id="iu-action-title">${tr('Piece actions & history', 'إجراءات القطعة وسجلها')}</h2><button type="button" class="btn iu-icon-button" data-iu-close="iu-action-dialog" aria-label="${tr('Close', 'إغلاق')}">${icon('close')}</button></header><div class="iu-dialog-body"><div id="iu-action-piece" class="iu-action-piece"></div><p data-dialog-message role="status" aria-live="polite"></p><div id="iu-action-fields" hidden><label class="iu-form-field">${tr('Action', 'الإجراء')}<select id="iu-action-kind"><option value="">${tr('Choose an action', 'اختر الإجراء')}</option></select></label><p id="iu-action-help" class="iu-action-help"></p><div id="iu-action-order-search" class="iu-action-search" hidden><label class="iu-form-field">${tr('Find customer order', 'البحث عن طلب العميل')}<input id="iu-action-query" type="search" maxlength="100" placeholder="${tr('Invoice reference or customer name', 'رقم الفاتورة أو اسم العميل')}"></label><button id="iu-action-find" type="button" class="btn btn-outline">${tr('Search', 'بحث')}</button></div><label id="iu-action-choice-field" class="iu-form-field" hidden><span id="iu-action-choice-title"></span><select id="iu-action-choice"></select></label><div id="iu-action-confirm-fields" hidden><label class="iu-form-field">${tr('Reason', 'السبب')}<textarea id="iu-action-reason" maxlength="1000" rows="2"></textarea></label><label id="iu-action-evidence-field" class="iu-form-field">${tr('Evidence / handover reference', 'مرجع الإثبات / التسليم')}<input id="iu-action-evidence" maxlength="200" placeholder="${tr('Receipt, delivery or count reference', 'مرجع الاستلام أو التسليم أو الجرد')}"></label><label class="iu-check iu-confirm"><input id="iu-action-confirm" type="checkbox"><span id="iu-action-confirm-text"></span></label><p class="iu-help">${tr('Your name, time, reason and previous/new status are recorded. This is an audited operation.', 'يُحفظ اسمك والوقت والسبب والحالة السابقة والجديدة. الإجراء مسجل في سجل القطعة.')}</p></div></div><section class="iu-action-history"><h3>${tr('Piece history', 'سجل القطعة')}</h3><div id="iu-action-events"></div></section></div><footer class="iu-dialog-footer"><button type="button" id="iu-action-reload" class="btn btn-outline">${tr('Refresh piece', 'تحديث القطعة')}</button><button type="button" class="btn btn-outline" data-iu-close="iu-action-dialog">${tr('Close', 'إغلاق')}</button><button type="submit" id="iu-action-submit" class="btn btn-primary" disabled>${tr('Confirm action', 'تأكيد الإجراء')}</button></footer></form></dialog>`;
  }
  function actionEventLabel(event) {
    const labels = { registered: ['Registered', 'تسجيل القطعة'], reserved: ['Reserved', 'حجز للعميل'], released: ['Released', 'فك الحجز'],
      'inspection-passed': ['Inspection approved', 'اعتماد الفحص'], damaged: ['Damaged', 'تسجيل تالف'], lost: ['Lost', 'تسجيل فقد'],
      'picking-started': ['Picking started', 'بدء التحضير'], 'picking-undone': ['Picking undone', 'تراجع عن التحضير'],
      'supplier-returned': ['Returned to supplier', 'تسليم للمورد'], 'supplier-return-reserved': ['Reserved for supplier return', 'حجز لمرتجع مورد'], 'supplier-return-released': ['Supplier return reservation released', 'فك حجز مرتجع المورد'], 'warehouse-changed': ['Warehouse transfer', 'نقل بين المخازن'] };
    Object.assign(labels, { 'inspection-required': ['Awaiting inspection', 'إعادة للفحص'],
      'label-print-requested': ['Label print requested', 'طلب طباعة ملصق'], 'label-reprint-requested': ['Label reprint requested', 'طلب إعادة طباعة ملصق'],
      'scan-validated': ['Barcode verified', 'التحقق من الباركود'], 'manual-selection-confirmed': ['Manual selection confirmed', 'تأكيد الاختيار اليدوي'] });
    return labels[event.action] ? tr(...labels[event.action]) : statuses[event.toStatus] ? statusLabel(event.toStatus) : event.action;
  }
  async function openPieceActions(id, existing) {
    if (!state.ready || state.busy) return;
    const source = existing || state.unitScope?.rows.find(u => String(u._id) === id) || state.rows.find(u => String(u._id) === id);
    const request = ++state.pieceActionRequest, generation = state.generation;
    state.pieceAction = { id, unit: source, options: null, pending: null };
    get('iu-action-piece').textContent = tr('Loading piece…', 'جارٍ تحميل القطعة…');
    get('iu-action-events').replaceChildren(); get('iu-action-fields').hidden = true; get('iu-action-submit').disabled = true;
    get('iu-action-dialog').querySelector('[data-dialog-message]').textContent = '';
    showDialog('iu-action-dialog');
    const results = await Promise.allSettled([api('/inventory-units/' + encodeURIComponent(id), { background: true }), api('/inventory-units/' + encodeURIComponent(id) + '/action-options', { background: true })]);
    if (generation !== state.generation || request !== state.pieceActionRequest) return;
    const failed = results.find(r => r.status === 'rejected');
    if (failed) { message(failed.reason.message, true); return; }
    const detail = results[0].value, options = results[1].value;
    if (String(detail.unit?._id) !== id || !Number.isSafeInteger(detail.unit?.__v) || !Array.isArray(options.actions)) { message(tr('Invalid piece response. Refresh.', 'تعذر قراءة بيانات القطعة. أعد التحديث.'), true); return; }
    const unit = { ...source, ...detail.unit }; state.pieceAction = { id, unit, options, pending: null, events: detail.events || [], historyFilter: 'changes', historyLimit: 10 };
    get('iu-action-piece').innerHTML = `<div><strong dir="auto">${html(unit.product?.name || tr('Physical piece', 'قطعة فعلية'))}</strong><code dir="ltr">${html(unit.manualCode || unit.barcode)}</code></div>${pieceStatus(unit)}<small>${html(window.SouliaWarehouses?.name(unit.warehouseCode) || unit.warehouseCode || 'MAIN')}</small>${unit.assignment ? `<small>${tr('Linked order ID', 'هوية الطلب المرتبط')}: <bdi>${html(unit.assignment.transactionId)}</bdi></small>` : ''}`;
    get('iu-action-piece').insertAdjacentHTML('beforeend', `<small>${tr('Recorded print requests: ', 'طلبات الطباعة المسجلة: ')}${Number(unit.printCount) || 0}</small>`);
    get('iu-action-kind').innerHTML = `<option value="">${tr('Choose an action', 'اختر الإجراء')}</option>` + options.actions.filter(a => pieceActionLabels[a]).map(a => `<option value="${html(a)}">${html(tr(...pieceActionLabels[a]))}</option>`).join('');
    get('iu-action-fields').hidden = false; get('iu-action-query').value = ''; get('iu-action-reason').value = ''; get('iu-action-evidence').value = '';
    renderPieceActionFields();
    renderPieceActionHistory();
    if (!options.actions.length) message(tr('No permitted state changes for this piece. Its history is shown below.', 'لا توجد تغييرات مسموحة لهذه القطعة بصلاحياتك وحالتها الحالية. يمكنك مراجعة سجلها.'));
  }
  function renderPieceActionHistory() {
    const current = state.pieceAction;
    if (!current) return;
    const events = current.events || [], changes = events.filter(event => event.fromStatus !== event.toStatus);
    const filtered = current.historyFilter === 'all' ? events : changes;
    const shown = filtered.slice(0, current.historyLimit || 10);
    get('iu-action-events').innerHTML = `<div class="iu-history-toolbar"><div role="group" aria-label="${tr('History filter', 'عرض السجل')}"><button type="button" data-iu-history-filter="changes" aria-pressed="${current.historyFilter !== 'all'}">${tr('Changes', 'التغييرات')} <b>${changes.length}</b></button><button type="button" data-iu-history-filter="all" aria-pressed="${current.historyFilter === 'all'}">${tr('All events', 'كل الأحداث')} <b>${events.length}</b></button></div><small>${tr('Newest first', 'الأحدث أولًا')}</small></div><div class="iu-history-list" role="list">${shown.map(event => {
      const at = new Date(event.createdAt), validDate = Number.isFinite(at.getTime());
      const changed = event.fromStatus && event.fromStatus !== event.toStatus;
      const detail = [event.reason, event.notes].filter(Boolean).map(text => `<p dir="auto">${html(text)}</p>`).join('');
      return `<article class="iu-action-event" role="listitem"><header><strong>${html(actionEventLabel(event))}</strong><time ${validDate ? `datetime="${at.toISOString()}" title="${html(at.toLocaleString(tr('en-GB','ar-EG')))}"` : ''}>${validDate ? html(at.toLocaleString(tr('en-GB','ar-EG'),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})) : '—'}</time></header><div class="iu-history-meta"><span>${html(event.by || '—')}</span><span class="iu-history-status">${changed ? `${html(statusLabel(event.fromStatus))} <span aria-hidden="true">←</span> ` : ''}${html(statusLabel(event.toStatus))}</span></div>${detail ? `<details class="iu-history-detail"><summary>${tr('Details', 'التفاصيل')}</summary>${detail}</details>` : ''}${event.details?.inspectionAtReceipt ? `<small>${tr('Sound condition confirmed at receipt', 'تم اعتماد سلامة القطعة أثناء الاستلام')}</small>` : ''}${event.details?.supplierReturnRef ? `<small>${tr('Supplier return', 'مرتجع المورد')}: ${html(event.details.supplierReturnRef)}</small>` : ''}</article>`;
    }).join('') || `<p class="iu-help">${tr('No recorded changes.', 'لا توجد تغييرات مسجلة.')}</p>`}</div>${filtered.length > shown.length ? `<button type="button" class="iu-link iu-history-more" data-iu-history-more>${tr('Show more', 'عرض المزيد')} (${filtered.length - shown.length})</button>` : ''}`;
  }
  function renderPieceActionFields() {
    const action = get('iu-action-kind').value, options = state.pieceAction?.options;
    get('iu-action-help').textContent = pieceActionHelp[action] ? tr(...pieceActionHelp[action]) : '';
    get('iu-action-confirm-fields').hidden = !action; get('iu-action-submit').disabled = !action || state.busy;
    const inspecting = action === 'inspect';
    get('iu-action-submit').textContent = inspecting ? tr('Approve sound condition', 'اعتماد سلامة القطعة') : pieceActionLabels[action] ? tr(...pieceActionLabels[action]) : tr('Confirm action', 'تأكيد الإجراء');
    get('iu-action-reason').closest('label').firstChild.textContent = tr('Reason / note (optional)', 'السبب / ملاحظة (اختياري)');
    get('iu-action-evidence').closest('label').firstChild.textContent = tr('Reference (optional)', 'المرجع (اختياري)');
    get('iu-action-confirm').closest('label').hidden = true;
    let extras = get('iu-action-extras');
    if (!extras) {
      extras = document.createElement('details'); extras.id = 'iu-action-extras'; extras.className = 'iu-action-extras';
      const summary = document.createElement('summary'); summary.textContent = tr('Add a note or reference (optional)', 'إضافة ملاحظة أو مرجع (اختياري)'); extras.appendChild(summary);
      const reasonField = get('iu-action-reason').closest('label'); reasonField.before(extras);
      extras.append(reasonField, get('iu-action-evidence-field'));
    }
    extras.open = false;
    if (inspecting) get('iu-action-help').textContent = tr('Clicking “Approve sound condition” confirms you inspected this piece and found it sound. It becomes available immediately. Reason and reference are optional.', 'بالضغط على «اعتماد سلامة القطعة» تؤكد أنك فحصتها وهي سليمة. تصبح متاحة مباشرة، والسبب ومرجع الإثبات اختياريان.');
    get('iu-action-confirm').checked = false;
    get('iu-action-order-search').hidden = action !== 'reserve';
    get('iu-action-choice-field').hidden = !['reserve', 'supplier-return'].includes(action);
    get('iu-action-evidence-field').hidden = action === 'reserve';
    get('iu-action-choice-title').textContent = action === 'reserve' ? tr('Customer invoice / line', 'فاتورة العميل / السطر') : tr('Completed supplier return', 'مرتجع المورد المكتمل');
    const choices = action === 'reserve' ? options?.sales || [] : options?.supplierReturns || [];
    get('iu-action-choice').innerHTML = `<option value="">${tr('Choose…', 'اختر…')}</option>` + choices.map((row, i) => `<option value="${i}">#${html(row.ref)} · ${html(row.client || row.supplier || '')} · ${tr('Remaining', 'المتبقي')} ${row.remaining}</option>`).join('');
    if (['reserve', 'supplier-return'].includes(action) && !choices.length) {
      get('iu-action-submit').disabled = true;
      message(action === 'reserve' ? tr('No matching open sale lines. Search by reference/name. Missing line IDs must be identified from order preparation.', 'لا توجد سطور بيع متاحة مطابقة. ابحث برقم الفاتورة أو الاسم. السطور بدون هوية تُعالج من تحضير الطلب.') : tr('No matching completed supplier return. Complete it from Supplier returns first.', 'لا يوجد مرتجع مورد مكتمل ومطابق. أكمله من صفحة مرتجعات الموردين أولًا.'));
    } else get('iu-action-dialog').querySelector('[data-dialog-message]').textContent = '';
    get('iu-action-confirm-text').textContent = action === 'lost' ? tr('I completed a physical count and confirmed this exact piece is missing.', 'أؤكد أنني أجريت جردًا فعليًا وتأكدت من فقد هذه القطعة بعينها.') : action === 'supplier-return' ? tr('I confirm this exact piece was physically handed to the supplier for the selected completed return.', 'أؤكد تسليم هذه القطعة بعينها فعليًا للمورد ضمن المرتجع المكتمل المحدد.') : action === 'inspect' ? tr('I physically inspected this exact piece and confirm it is sound and ready.', 'أؤكد أنني فحصت هذه القطعة فعليًا وهي سليمة وجاهزة.') : action === 'deliver' ? tr('I have evidence confirming this exact piece was delivered to the customer.', 'لدي إثبات يؤكد تسليم هذه القطعة بعينها للعميل.') : action === 'ship' ? tr('I confirm physical handover of this exact piece to the carrier.', 'أؤكد تسليم هذه القطعة بعينها فعليًا لشركة الشحن.') : tr('I confirm physical possession and the selected action for this exact piece.', 'أؤكد الحيازة الفعلية والإجراء المحدد لهذه القطعة بعينها.');
    const explanation = get('iu-action-confirm-fields').querySelector('p.iu-help');
    explanation.textContent = action ? tr('The action button confirms this statement: ', 'الضغط على زر الإجراء يؤكد الآتي: ') + get('iu-action-confirm-text').textContent + ' ' + tr('Your name and time are recorded automatically.', 'يُحفظ اسمك والوقت تلقائيًا.') : '';
  }
  async function findPieceActionOrders() {
    const current = state.pieceAction; if (!current || state.busy) return;
    const button = get('iu-action-find'), query = get('iu-action-query').value;
    if (button.disabled) return;
    button.disabled = true; get('iu-action-submit').disabled = true; get('iu-action-choice').disabled = true; get('iu-action-kind').disabled = true;
    get('iu-action-confirm').checked = false;
    try {
      const options = await api('/inventory-units/' + encodeURIComponent(current.id) + '/action-options?' + new URLSearchParams({ q: query }), { background: true });
      if (state.pieceAction !== current) return;
      current.options = options; renderPieceActionFields();
    } catch (error) { if (state.pieceAction === current) message(error.message, true); }
    finally { button.disabled = false; get('iu-action-choice').disabled = false; get('iu-action-kind').disabled = false;
      if (state.pieceAction === current) get('iu-action-submit').disabled = !get('iu-action-kind').value || !current.options?.sales?.length;
    }
  }
  async function submitPieceAction(event) {
    event.preventDefault();
    const current = state.pieceAction, action = get('iu-action-kind').value;
    if (!current?.options?.actions.includes(action) || state.busy) return;
    const reason = get('iu-action-reason').value.trim(), evidence = get('iu-action-evidence').value.trim();
    const body = { action, expectedVersion: current.unit.__v, reason, physicalPossessionConfirmed: action !== 'lost',
      ...(action !== 'reserve' ? { evidenceReference: evidence } : {}), ...(action === 'inspect' ? { inspectionPassed: true } : {}), ...(action === 'lost' ? { physicalCountConfirmed: true } : {}) };
    if (['reserve', 'supplier-return'].includes(action)) {
      const rows = action === 'reserve' ? current.options.sales : current.options.supplierReturns;
      const index = get('iu-action-choice').value, choice = index !== '' ? rows?.[Number(index)] : null;
      if (!choice) { message(tr('Choose the matching invoice or return.', 'اختر الفاتورة أو المرتجع المطابق.'), true); return; }
      if (action === 'reserve') { body.transactionId = choice.transactionId; body.lineId = choice.lineId; }
      else body.supplierReturnId = choice.id;
    }
    const fingerprint = JSON.stringify(body);
    if (current.pending && current.pending.fingerprint !== fingerprint) { message(tr('Retry the previous action unchanged, or refresh the piece to check its outcome.', 'أعد محاولة الإجراء السابق دون تعديل، أو حدّث القطعة للتحقق من نتيجته أولًا.'), true); return; }
    if (!current.pending) current.pending = { fingerprint, body: { ...body, operationKey: requestKey() } };
    setBusy(true); get('iu-action-submit').disabled = true;
    get('iu-action-form').querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
    let saved;
    try { saved = await post('/' + encodeURIComponent(current.id) + '/actions', current.pending.body); }
    catch (error) { message(error.message + ' ' + tr('Retry unchanged or refresh the piece before a different action.', 'أعد المحاولة دون تعديل أو حدّث القطعة قبل إجراء مختلف.'), true); }
    finally {
      setBusy(false);
      get('iu-action-form').querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = false; });
    }
    if (!saved) return;
    if (String(saved.unit?._id) !== current.id || !Number.isSafeInteger(saved.unit?.__v)) {
      message(tr('Could not verify the saved piece. Refresh it before trying again.', 'تعذر التحقق من نتيجة الحفظ. حدّث القطعة قبل المحاولة مجددًا.'), true); return;
    }
    current.pending = null;
    closeDialog('iu-action-dialog');
    const success = tr('Piece action saved successfully.', 'تم حفظ إجراء القطعة بنجاح.');
    message(success);
    if (typeof toast === 'function') toast(success);
    window.InvoiceUnitIdentities?.changed();
    const updated = { ...current.unit, ...saved.unit };
    if (state.selected.has(current.id)) state.selected.set(current.id, updated);
    state.rows = state.rows.map(u => String(u._id) === current.id ? updated : u);
    if (state.unitScope) {
      state.unitScope.rows = state.unitScope.rows.map(u => String(u._id) === current.id ? updated : u);
      get('iu-line-units').innerHTML = unitRows(state.unitScope.rows);
    }
    if (state.unitsReady) get('iu-units').innerHTML = unitRows(state.rows);
    invalidatePreview();
    if (state.view === 'units') await loadUnits();
  }
  async function loadUnits() {
    if (!state.ready) return;
    const request = ++state.unitRequest, generation = state.generation;
    state.unitLoading = true; state.unitsReady = false; get('iu-unit-error').hidden = true;
    document.querySelectorAll('[data-quick-status]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.quickStatus === state.status)));
    get('iu-units').setAttribute('aria-busy', 'true');
    get('iu-log-loading').hidden = false;
    if (!get('iu-units').children.length) get('iu-units').innerHTML = '<div class="iu-skeleton"></div>';
    updateActions();
    try {
      const scope = state.stockScope;
      const response = await api('/inventory-units?' + new URLSearchParams({ q: state.q, status: state.status, page: String(state.page), limit: scope ? '100' : '30',
        ...(scope?.unitIds ? { unitIds: scope.unitIds.join(',') } : {}),
        ...(scope?.purchaseTransactionId ? { purchaseTransactionId: scope.purchaseTransactionId } : {}), ...(scope?.productId ? { productId: scope.productId } : {}), ...(scope?.warehouseCode ? { warehouseCode: scope.warehouseCode } : {}),
        ...(scope?.reconciliationRef ? { reconciliationRef: scope.reconciliationRef } : {}) }), { background: true });
      if (generation !== state.generation || request !== state.unitRequest) return;
      if (!Array.isArray(response.units) || !Number.isSafeInteger(response.total) || !Number.isSafeInteger(response.limit)) throw new Error(tr('Could not read the piece list. Refresh and retry.', 'تعذر قراءة قائمة القطع. حدّث القائمة وحاول مجددًا.'));
      state.rows = response.units.map(validateUnit).map(decorateUnit); state.total = response.total; state.limit = response.limit; state.unitsReady = true;
      get('iu-units').innerHTML = unitRows(state.rows);
      get('iu-stat-units').textContent = String(state.total); get('iu-stat-page').textContent = String(state.rows.length);
      get('iu-page').textContent = tr(`Page ${state.page} · ${state.total} pieces`, `صفحة ${state.page} · ${state.total} قطعة`);
      get('iu-products').innerHTML = (response.products || []).map(p => `<article class="iu-catalog-product"><strong dir="auto">${html(p.name)}</strong><small>SKU <bdi>${html(p.code)}</bdi></small></article>`).join('');
      get('iu-products-count').textContent = String((response.products || []).length);
      if (response.invoiceMatch) get('iu-products').closest('details').open = true;
      get('iu-product-limit').textContent = response.productsTruncated ? tr('First 100 matching products. Refine the search.', 'أول 100 منتج مطابق. ضيّق البحث.') : '';
    } catch (error) {
      if (generation !== state.generation || request !== state.unitRequest) return;
      state.rows = []; get('iu-unit-error').hidden = false; get('iu-unit-error-text').textContent = error.message;
      get('iu-units').innerHTML = emptyState(tr('Units could not be loaded', 'تعذر تحميل القطع'));
      get('iu-stat-units').textContent = '—'; get('iu-stat-page').textContent = '—'; get('iu-page').textContent = '—';
    } finally { if (generation === state.generation && request === state.unitRequest) { state.unitLoading = false; get('iu-units').setAttribute('aria-busy', 'false'); get('iu-log-loading').hidden = true; updateActions(); } }
  }
  async function viewLine(lineIndex, page = 1) {
    if (!state.ready || state.busy) return;
    const invoice = state.activeInvoice, line = invoice?.lines.find(l => l.lineIndex === lineIndex);
    if (!line) return;
    const request = ++state.unitDialogRequest, generation = state.generation;
    state.unitScope = { invoice, line, page, rows: [], total: 0 };
    if (state.labelAudit?.key !== sourceKey(invoice, line)) state.labelAudit = null;
    renderLabelAudit();
    get('iu-units-title').textContent = (line.name || line.sku) + ' · ' + tr('Unit identities', 'هويات القطع');
    get('iu-line-units').innerHTML = '<div class="iu-skeleton"></div>';
    get('iu-line-units-meta').textContent = tr('Loading registered pieces…', 'جارٍ تحميل القطع المسجلة…');
    get('iu-line-prev').disabled = true; get('iu-line-next').disabled = true; showDialog('iu-units-dialog');
    try {
      const response = await api(`/inventory-units/purchases/${encodeURIComponent(invoice.transactionId)}/lines/${line.lineIndex}/units?` + new URLSearchParams({ page: String(page), limit: '30' }));
      if (request !== state.unitDialogRequest || generation !== state.generation) return;
      if (!Array.isArray(response.units) || !Number.isSafeInteger(response.total)) throw new Error(tr('Could not read this product’s pieces. Refresh the invoice.', 'تعذر قراءة قطع الصنف. حدّث الفاتورة.'));
      const rows = response.units.map(validateUnit).map(u => ({ ...u, sourceKey: sourceKey(invoice, line), invoiceRef: invoice.ref }));
      state.unitScope = { invoice, line, page, rows, total: response.total };
      if (state.labelAudit && state.labelAudit.units.length !== response.total) state.labelAudit = null;
      get('iu-line-units').innerHTML = unitRows(rows);
      renderLabelAudit();
      get('iu-line-units-meta').textContent = tr(`Invoice #${invoice.ref} · page ${page} · ${response.total} pieces`, `فاتورة #${invoice.ref} · صفحة ${page} · ${response.total} قطعة`);
      get('iu-line-prev').disabled = page <= 1; get('iu-line-next').disabled = page * 30 >= response.total;
    } catch (error) { if (request === state.unitDialogRequest && generation === state.generation) get('iu-line-units').innerHTML = emptyState(tr('Units could not be loaded', 'تعذر تحميل القطع'), error.message); }
  }
  function renderLabelAudit() {
    const host = get('iu-label-audit');
    if (!host) return;
    const audit = state.labelAudit;
    host.innerHTML = !audit ? `<button type="button" class="btn btn-outline" id="iu-audit-start">${icon('scan')}${tr('Check physical labels', 'فحص وجرد الملصقات')}</button>` : `
      <strong>${tr('Physical label check', 'جرد الملصقات الفعلية')}</strong>
      <p class="iu-help">${tr('Scan each existing label or enter its piece code, then press Enter. Unchecked pieces may need printing. Refreshing the page or changing products resets this check.', 'امسح كل ملصق موجود أو أدخل كود القطعة ثم اضغط Enter. القطع غير المفحوصة قد تحتاج للطباعة. يُصفّر الفحص عند تحديث الصفحة أو تغيير الصنف.')}</p>
      <form id="iu-audit-form" class="iu-audit-controls"><input id="iu-audit-code" dir="ltr" autocomplete="off" maxlength="160" aria-label="${tr('Scan label or enter piece code', 'امسح الملصق أو أدخل كود القطعة')}" placeholder="${tr('Scan / piece code', 'مسح / كود القطعة')}"><button class="btn btn-primary" type="submit">${tr('Check', 'فحص')}</button></form>
      <p id="iu-audit-feedback" role="status" aria-live="polite"></p>
      <p><b>${audit.checked.size}</b> ${tr('checked', 'تم فحصها')} · <b>${audit.units.length - audit.checked.size}</b> ${tr('unchecked', 'لم تُفحص')} · ${audit.units.length} ${tr('total across all pages', 'الإجمالي في كل الصفحات')}</p>
      <div class="iu-audit-controls"><button id="iu-audit-preview" class="btn btn-outline" type="button" ${audit.checked.size === audit.units.length || !has('inventory-units-print') ? 'disabled' : ''}>${icon('printer')}${tr('Preview unchecked labels', 'معاينة ملصقات غير المفحوص')}</button><button id="iu-audit-reset" class="iu-link" type="button">${tr('Start a new check', 'بدء فحص جديد')}</button></div>
      <p class="iu-help">${tr('Replaces the label batch with up to 100 unchecked pieces. Printing alone does not mark a piece as checked; scan its label afterward.', 'يستبدل دفعة الطباعة بما يصل إلى 100 قطعة غير مفحوصة. الطباعة وحدها لا تؤكد الفحص؛ امسح الملصق بعد خروجه.')}</p>`;
    if (!audit) { get('iu-audit-start').onclick = startLabelAudit; get('iu-audit-start').disabled = !state.unitScope?.total; return; }
    get('iu-audit-form').onsubmit = checkLabel;
    get('iu-audit-reset').onclick = startLabelAudit;
    get('iu-audit-preview').onclick = previewUncheckedLabels;
    for (const row of get('iu-line-units').querySelectorAll('[data-log-unit]')) {
      row.querySelector('.iu-audit-mark')?.remove();
      const checked = audit.checked.has(row.dataset.logUnit);
      const mark = document.createElement('button');
      mark.type = 'button'; mark.className = 'iu-audit-mark iu-link';
      mark.dataset.checked = String(checked);
      mark.textContent = checked ? tr('✓ Checked · undo', '✓ تم الفحص · تراجع') : tr('Not checked', 'لم تُفحص');
      mark.disabled = !checked;
      mark.onclick = () => { if (state.busy) return; audit.checked.delete(row.dataset.logUnit); renderLabelAudit(); };
      row.querySelector('.iu-log-identity').append(mark);
    }
  }
  async function startLabelAudit() {
    if (state.busy || !state.ready || !state.unitScope) return;
    const scope = state.unitScope, generation = state.generation;
    setBusy(true);
    try {
      const units = await lineRange(scope.invoice, scope.line, 0, scope.total);
      if (generation !== state.generation || state.unitScope !== scope) return;
      state.labelAudit = { key: sourceKey(scope.invoice, scope.line), units, checked: new Set() };
      renderLabelAudit();
      get('iu-audit-code').focus();
    } catch (error) { message(error.message, true); }
    finally { if (generation === state.generation) setBusy(false); }
  }
  function checkLabel(event) {
    event.preventDefault();
    if (state.busy || !state.labelAudit) return;
    const input = get('iu-audit-code'), code = input.value.trim().toUpperCase();
    if (!code) return;
    const audit = state.labelAudit;
    const unit = audit.units.find(unit => [unit.barcode, unit.manualCode].some(value => value && String(value).toUpperCase() === code));
    let feedback;
    if (!unit) feedback = tr('This code does not belong to this invoice product. Nothing counted.', 'الكود لا يخص قطع هذا الصنف في الفاتورة. لم يتم احتسابه.');
    else if (audit.checked.has(String(unit._id))) feedback = tr('Already checked. Not counted twice.', 'تم فحص القطعة من قبل. لم تُحتسب مرتين.');
    else { audit.checked.add(String(unit._id)); feedback = tr('Label checked: ', 'تم فحص الملصق: ') + (unit.manualCode || unit.barcode); }
    renderLabelAudit();
    get('iu-audit-feedback').textContent = feedback;
    get('iu-audit-code').focus();
  }
  async function previewUncheckedLabels() {
    if (state.busy || !state.ready || !state.labelAudit || !has('inventory-units-print')) return;
    const units = state.labelAudit.units.filter(unit => !state.labelAudit.checked.has(String(unit._id))).slice(0, 100);
    if (!units.length) return;
    state.selected.clear();
    units.forEach(unit => state.selected.set(String(unit._id), unit));
    selectionChanged();
    closeDialog('iu-units-dialog');
    if (state.sizeId) await preview();
    else message(tr('Unchecked pieces selected. Choose the label dimensions, then preview and print.', 'تم تحديد القطع غير المفحوصة. اختر مقاس الملصق ثم عاين واطبع.'));
  }
  function groupedLabelSheets(batch) {
    const groups = new Map();
    for (const label of batch.labels) {
      const key = String(label.sku);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(label);
    }
    const sheets = [];
    for (const labels of groups.values()) {
      if (sheets.length) sheets.push({ separator: true });
      sheets.push(...labels.map(label => ({ label })));
    }
    return sheets;
  }
  function separatorHtml(size) {
    return `<article class="iu-label iu-label-separator" style="--label-width:${Number(size.widthMm)}mm;--label-height:${Number(size.heightMm)}mm;--separator-font:${Math.min(10, Number(size.heightMm) / 4)}mm" aria-label="فاصل"><strong dir="rtl">فاصل</strong></article>`;
  }
  function previewSheets(batch, separateProducts = false) {
    const sheets = separateProducts ? groupedLabelSheets(batch) : batch.labels.map(label => ({ label }));
    let index = 0;
    return sheets.map(({ label, separator }) => separator
      ? `<figure class="iu-preview-sheet"><figcaption>${tr('Product separator', 'فاصل بين المنتجات')}</figcaption>${separatorHtml(batch.size)}<small class="iu-print-count">${tr('Extra roll label', 'ملصق إضافي على الرول')}</small></figure>`
      : `<figure class="iu-preview-sheet"><figcaption><span>${tr('Label', 'ملصق')} ${++index}</span><bdi>${html(label.sku)}</bdi></figcaption>${labelHtml(label, batch.size)}<small class="iu-print-count">${tr('Recorded print requests: ', 'طلبات الطباعة المسجلة: ')}<b>${Number(label.printCount) || 0}</b></small></figure>`).join('');
  }
  async function preview() {
    if (!state.ready || state.busy || !state.sizeId || !state.selected.size) return;
    if (get('iu-units-dialog').open) closeDialog('iu-units-dialog');
    const ids = selectedIds(), sizeId = state.sizeId, generation = state.generation;
    invalidatePreview(); setBusy(true); get('iu-previews').innerHTML = '<div class="iu-skeleton"></div>';
    get('iu-preview-total').textContent = tr(`${ids.length} piece label(s)`, `${ids.length} ملصق قطعة`);
    get('iu-preview-size').textContent = get('iu-paper-size').textContent; get('iu-preview-zoom').value = '100'; get('iu-previews').style.setProperty('--iu-preview-zoom', '1'); showDialog('iu-preview-section'); revealSurface(get('iu-preview-section'));
    message(tr('Preparing the actual unit labels…', 'جارٍ تجهيز ملصقات القطع الفعلية…'));
    try {
      const batch = validateBatch(await post('/labels/preview', { unitIds: ids, sizeId, operationKey: requestKey(), reason: 'Operator reviewed physical unit labels before printing' }), ids, sizeId);
      if (generation !== state.generation) return;
      get('iu-preview-section').querySelector('.iu-preview-stage-note').textContent = tr(
        `Printer stock: width ${batch.size.widthMm} mm across the roll × ${batch.size.heightMm} mm feed length. Use 100% scale, zero margins, headers/footers off, and disable driver rotation.`,
        `إعداد ورق الطابعة: عرض ${batch.size.widthMm} مم عبر الرول × طول تغذية ${batch.size.heightMm} مم. استخدم مقياس 100٪، وهوامش صفر، وأوقف الترويسات والتذييلات وتدوير تعريف الطابعة.`);
      get('iu-previews').innerHTML = previewSheets(batch, true);
      const separatorCount = groupedLabelSheets(batch).length - batch.labels.length;
      if (separatorCount) get('iu-preview-total').textContent += tr(` + ${separatorCount} separator(s)`, ` + ${separatorCount} فاصل`);
      await waitForLayout(get('iu-previews'));
      if (generation !== state.generation) return;
      state.preview = { batch, ids, sizeId }; message(tr('Preview validated. Check the paper dimensions before printing.', 'تم التحقق من المعاينة. راجع مقاس الورق قبل الطباعة.'));
    } catch (error) {
      if (generation !== state.generation) return;
      state.preview = null; get('iu-previews').innerHTML = emptyState(tr('Preview unavailable', 'تعذرت المعاينة'), error.message); message(error.message, true);
    } finally { if (generation === state.generation) setBusy(false); }
  }
  async function print() {
    if (!state.ready || state.busy || !state.preview || !has('inventory-units-print')) return;
    const { ids, sizeId } = state.preview;
    if (JSON.stringify(ids) !== JSON.stringify(selectedIds()) || sizeId !== state.sizeId) { invalidatePreview(); message(tr('Selection changed. Preview the labels again.', 'تغير التحديد. عاين الملصقات مجددًا.'), true); return; }
    let popup = window.open('', '_blank', 'width=850,height=750');
    if (!popup) { message(tr('Allow popups to open the print preview.', 'اسمح بالنوافذ المنبثقة لفتح معاينة الطباعة.'), true); return; }
    popup.document.body.textContent = tr('Preparing labels…', 'جارٍ تجهيز الملصقات…'); setBusy(true);
    try {
      if (!state.pendingPrint) {
        const fresh = validateBatch(await post('/labels/preview', { unitIds: ids, sizeId, operationKey: requestKey(), reason: 'Check recorded print history before label printing' }), ids, sizeId);
        const reprints = fresh.labels.filter(label => Number(label.printCount) > 0);
        state.preview.batch = fresh; get('iu-previews').innerHTML = previewSheets(fresh, true);
        if (reprints.length) {
          popup.close();popup=await confirmReprint(reprints);
          if (!popup) { message(tr('Reprint cancelled. No new print request recorded.', 'تم إلغاء إعادة الطباعة دون تسجيل طلب جديد.')); return; }
        }
        if (popup.closed) throw new Error(tr('Print window was closed before submission.', 'أُغلقت نافذة الطباعة قبل إرسال الطلب.'));
        state.pendingPrint = { unitIds: ids, sizeId, operationKey: requestKey(), allowReprint: reprints.length > 0, reason: 'Operator requested browser label printing; physical outcome unverified' };
      }
      const batch = validateBatch(await post('/labels/requests', state.pendingPrint), ids, sizeId), size = batch.size;
      state.preview.batch = batch; get('iu-previews').innerHTML = previewSheets(batch, true);
      const printedInvoiceIds = [...new Set(batch.labels.map(label => state.selected.get(label.unitId)?.origin?.purchaseTransactionId).filter(Boolean))];
      if (printedInvoiceIds.length && has('purchase-view')) void refreshPrintedInvoices(printedInvoiceIds);
      for (const label of batch.labels) {
        const unit = state.rows.find(row => String(row._id) === label.unitId); if (unit) unit.printCount = label.printCount;
      }
      if (state.unitsReady) get('iu-units').innerHTML = unitRows(state.rows);
      popup.document.open();
      popup.document.write(`<!doctype html><html dir="ltr"><head><meta charset="utf-8"><title>SOULIA · ${size.widthMm}x${size.heightMm} mm labels</title><link rel="stylesheet" href="${location.origin}/inventory-units.css?v=${VERSION}"><style>
        @page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0;page-orientation:upright}
        @page unit-label{size:${size.widthMm}mm ${size.heightMm}mm;margin:0;page-orientation:upright}
        html,body{margin:0!important;padding:0!important;border:0!important;background:white;width:${size.widthMm}mm;min-width:0;direction:ltr;writing-mode:horizontal-tb}
        .iu-print-sheet{page:unit-label;display:block;position:relative;box-sizing:border-box;width:${size.widthMm}mm;height:${size.heightMm}mm;margin:0;padding:0;overflow:hidden;break-inside:avoid;page-break-inside:avoid;break-after:page;page-break-after:always}
        .iu-print-sheet:last-child{break-after:auto;page-break-after:auto}
        .iu-print-sheet>.iu-label{display:block;width:${size.widthMm}mm!important;height:${size.heightMm}mm!important;margin:0!important;transform:none!important;zoom:1!important;break-inside:avoid;print-color-adjust:exact;-webkit-print-color-adjust:exact}
        </style></head><body>${groupedLabelSheets(batch).map(({ label, separator }) => `<section class="iu-print-sheet">${separator ? separatorHtml(size) : labelHtml(label, size)}</section>`).join('')}</body></html>`);
      popup.document.close();
      await new Promise((resolve, reject) => {
        const css = popup.document.querySelector('link'), timeout = setTimeout(() => reject(new Error(tr('Print stylesheet timed out.', 'انتهت مهلة تحميل تنسيق الطباعة.'))), 15000);
        const finish = () => { clearTimeout(timeout); resolve(); };
        if (css.sheet) finish(); else { css.onload = finish; css.onerror = () => { clearTimeout(timeout); reject(new Error(tr('Print stylesheet could not be loaded.', 'تعذر تحميل تنسيق الطباعة.'))); }; }
      });
      await waitForLayout(popup.document);
      if (popup.closed) throw new Error(tr('Print window closed. The request remains recorded.', 'أُغلقت نافذة الطباعة. يظل الطلب مسجلًا.'));
      popup.focus(); popup.print(); state.pendingPrint = null;
      state.preview.printedIds = [...ids];
      printSuccess(batch.labels.length);
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      if (error.status === 409 && (error.code === 'LABEL_REPRINT_CONFIRMATION_REQUIRED' || (error.originalMessage || error.message).includes('سبق طلب طباعة'))) {
        state.pendingPrint = null; message(error.message + tr(' Click Print again to review the updated counts.', ' اضغط الطباعة مجددًا لمراجعة الأعداد المحدثة.'), true);
      } else message(error.message + tr(' Retry uses the same request key.', ' إعادة المحاولة تستخدم نفس مفتاح الطلب.'), true);
    }
    finally { setBusy(false); }
  }
  function switchView(view) {
    if (state.busy || view === 'receipts' && !has('purchase-view')) return;
    const changed = state.view !== view;
    state.view = view; get('iu-workspace').dataset.view = view;
    get('iu-invoice-rail').hidden = view !== 'receipts'; get('iu-invoice-detail').hidden = view !== 'receipts'; get('iu-registry').hidden = view !== 'units';
    document.querySelectorAll('#page-barcodes [data-iu-tab]').forEach(button => { const active = button.dataset.iuTab === view; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; button.setAttribute('aria-controls', button.dataset.iuTab === 'receipts' ? 'iu-invoice-detail' : 'iu-registry'); });
    if (view === 'units' && !state.unitsReady) loadUnits();
    if (changed) revealSurface(get(view === 'units' ? 'iu-registry' : 'iu-invoice-detail'));
  }
  async function refreshData() {
    if (!state.ready || state.busy) return;
    const generation = state.generation, activeId = state.activeInvoice?.transactionId;
    const results = await Promise.allSettled([has('purchase-view') ? loadReceipts(true) : Promise.resolve(), activeId ? fetchInvoice(activeId) : Promise.resolve(null), state.view === 'units' ? loadUnits() : Promise.resolve()]);
    if (generation !== state.generation) return;
    if (results[1].status === 'fulfilled' && results[1].value && state.activeInvoice?.transactionId === activeId) { state.activeInvoice = results[1].value; renderDetail(); renderReceipts(); }
    else if (results[1].status === 'rejected') message(results[1].reason.message, true);
  }
  function bindEvents(root) {
    if (!root.dataset.productImageFallback) {
      root.addEventListener('error', event => {
        if (event.target.matches?.('img[data-product-image]')) event.target.hidden = true;
      }, true);
      root.dataset.productImageFallback = 'true';
    }
    root.onkeydown = event => {
      const picker = event.target.closest('#iu-size-picker');
      if (picker) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); picker.open = false; picker.querySelector('summary').focus(); return; }
        if (state.ready && !state.busy && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); picker.open = true;
          const options = [...picker.querySelectorAll('[data-paper-size]')], index = options.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[next]?.focus(); return;
        }
      }
      const tab = event.target.closest('[data-iu-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...root.querySelectorAll('[data-iu-tab]:not([hidden])')], index = tabs.indexOf(tab);
      const offset = event.key === 'ArrowRight' ? (root.dir === 'rtl' ? -1 : 1) : (root.dir === 'rtl' ? 1 : -1);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length;
      event.preventDefault(); switchView(tabs[next].dataset.iuTab); tabs[next].focus();
    };
    root.onclick = event => {
      const picker = get('iu-size-picker');
      if (picker?.open && !picker.contains(event.target)) picker.open = false;
      if (event.target.closest('#iu-size-picker summary') && (!state.ready || state.busy)) { event.preventDefault(); return; }
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.pieceActions) { openPieceActions(button.dataset.pieceActions); return; }
      if (button.dataset.copyBarcode) {
        const code = button.dataset.copyBarcode;
        if (!navigator.clipboard?.writeText) { message(tr('Select and copy the barcode text.', 'حدد نص الباركود وانسخه.'), true); return; }
        navigator.clipboard.writeText(code).then(() => message(tr('Piece barcode copied.', 'تم نسخ باركود القطعة.'))).catch(() => message(tr('Copy was unavailable. Select and copy the barcode text.', 'تعذر النسخ التلقائي. حدد نص الباركود وانسخه.'), true));
        return;
      }
      if (button.dataset.paperSize) {
        get('iu-size').value = button.dataset.paperSize; get('iu-size').dispatchEvent(new Event('change', { bubbles: true }));
        picker.open = false; picker.querySelector('summary').focus();
      }
      if (button.dataset.iuTab) switchView(button.dataset.iuTab);
      if (button.dataset.invoiceId) { const invoice = state.receipts.find(inv => inv.transactionId === button.dataset.invoiceId); if (invoice) chooseInvoice(invoice); }
      if (button.dataset.receiptFilter) { state.receiptFilter = button.dataset.receiptFilter; renderReceipts(); }
      if (button.dataset.viewLine !== undefined) viewLine(Number(button.dataset.viewLine));
      if (button.dataset.registerLine !== undefined) openRegistration(Number(button.dataset.registerLine));
      if (button.dataset.iuClose) closeDialog(button.dataset.iuClose);
      if (button.dataset.removeGroup && !state.busy) { for (const [id, u] of state.selected) if ((u.sourceKey || (u.origin?.purchaseTransactionId || '') + ':' + u.productId) === button.dataset.removeGroup) state.selected.delete(id); selectionChanged(); }
    };
    root.oninput = event => {
      const el = event.target;
      if (el.id === 'iu-receipt-query') { clearTimeout(state.receiptTimer); state.receiptQuery = el.value; state.receiptTimer = setTimeout(() => loadReceipts(true), 300); }
      if (el.id === 'iu-product-query') { state.productQuery = el.value; renderProducts(); }
      if (el.id === 'iu-query') { clearTimeout(state.unitTimer); state.unitTimer = setTimeout(() => get('iu-search-form')?.requestSubmit(), 300); }
    };
    root.onchange = event => {
      const el = event.target;
      if (el.dataset.selectLine !== undefined) selectLine(Number(el.dataset.selectLine), el.checked);
      if (el.id === 'iu-select-invoice') selectInvoice(el.checked);
      if (el.id === 'iu-product-filter') { state.productFilter = el.value; renderProducts(); }
      if (el.dataset.lineCount !== undefined || el.dataset.lineStart !== undefined) {
        const index = Number(el.dataset.lineCount ?? el.dataset.lineStart), line = state.activeInvoice.lines.find(l => l.lineIndex === index), old = rangeFor(state.activeInvoice, line), range = { ...old };
        if (el.dataset.lineCount !== undefined) range.count = Number(el.value);
        else { range.start = Number(el.value) - 1; range.count = Math.min(range.count, line.createdUnits - range.start); }
        selectLine(index, true, range);
      }
      if (el.dataset.unitId) { const rows = el.closest('#iu-line-units') ? state.unitScope?.rows : state.rows, unit = rows?.find(u => String(u._id) === el.dataset.unitId); if (unit) addUnit(unit, el.checked); }
    };
    get('iu-refresh').onclick = refreshData;
    get('iu-more-receipts').onclick = () => loadReceipts(false); get('iu-receipts-retry').onclick = () => loadReceipts(true);
    get('iu-unit-retry').onclick = loadUnits;
    get('iu-search-form').onsubmit = event => { event.preventDefault(); if (state.busy || !state.ready) return; clearTimeout(state.unitTimer); state.stockScope = null; state.q = window.BarcodeInput?.normalize(get('iu-query').value) ?? get('iu-query').value; state.status = get('iu-status').value; state.page = 1; loadUnits(); };
    get('iu-status').onchange = () => get('iu-search-form').requestSubmit();
    get('iu-reset-search').onclick = () => {
      if (state.busy || !state.ready) return;
      get('iu-query').value = ''; get('iu-status').value = '';
      get('iu-search-form').requestSubmit(); get('iu-query').focus();
    };
    root.querySelectorAll('[data-quick-status]').forEach(button => {
      button.onclick = () => {
        if (state.busy || !state.ready) return;
        get('iu-status').value = button.dataset.quickStatus;
        get('iu-search-form').requestSubmit();
      };
    });
    root.querySelectorAll('[data-iu-column]').forEach(input => {
      input.onchange = () => get('iu-registry').classList.toggle('iu-hide-' + input.dataset.iuColumn, !input.checked);
    });
    get('iu-size').onchange = event => { state.sizeId = event.target.value; invalidatePreview(); renderBatch(); };
    get('iu-size-picker').ontoggle = event => {
      const picker = event.target; if (!picker.open) return;
      if (!state.ready || state.busy) { picker.open = false; return; }
      const rect = picker.getBoundingClientRect(), above = rect.top - 24, below = innerHeight - rect.bottom - 24;
      picker.classList.toggle('opens-up', below < 300 && above > below);
      get('iu-size-options').style.maxHeight = Math.max(150, Math.min(320, above > below && below < 300 ? above : below)) + 'px';
    };
    get('iu-preview-zoom').onchange = event => get('iu-previews').style.setProperty('--iu-preview-zoom', String(Number(event.target.value) / 100));
    get('iu-select-page').onclick = () => {
      if (state.busy || !state.unitsReady) return;
      if (state.rows.length && state.rows.every(unit => state.selected.has(String(unit._id)))) {
        for (const unit of state.rows) state.selected.delete(String(unit._id));
        selectionChanged(); return;
      }
      for (const unit of state.rows) { if (state.selected.size >= 100 && !state.selected.has(String(unit._id))) continue; state.selected.set(String(unit._id), unit); }
      selectionChanged(); if (state.rows.some(u => !state.selected.has(String(u._id)))) message(tr('Only part of this page fits the 100-label batch.', 'تسع دفعة الـ100 ملصق جزءًا من هذه الصفحة فقط.'), true);
    };
    get('iu-clear').onclick = () => { if (state.busy) return; state.selected.clear(); selectionChanged(); message(tr('Label batch cleared.', 'تم مسح تحديد دفعة الملصقات.')); };
    get('iu-prev').onclick = () => { state.page--; loadUnits(); }; get('iu-next').onclick = () => { state.page++; loadUnits(); };
    get('iu-preview').onclick = preview; get('iu-mobile-preview').onclick = preview; get('iu-line-preview').onclick = () => closeDialog('iu-units-dialog'); get('iu-print').onclick = print;
    get('iu-line-prev').onclick = () => viewLine(state.unitScope.line.lineIndex, state.unitScope.page - 1);
    get('iu-line-next').onclick = () => viewLine(state.unitScope.line.lineIndex, state.unitScope.page + 1);
    get('iu-register-form').onsubmit = registerUnits;
    get('iu-action-form').onsubmit = submitPieceAction;
    get('iu-action-events').onclick = event => {
      const filter = event.target.closest('[data-iu-history-filter]');
      if (!state.pieceAction || state.busy) return;
      if (filter) { state.pieceAction.historyFilter = filter.dataset.iuHistoryFilter; state.pieceAction.historyLimit = 10; renderPieceActionHistory(); }
      else if (event.target.closest('[data-iu-history-more]')) { state.pieceAction.historyLimit += 10; renderPieceActionHistory(); }
    };
    get('iu-action-kind').onchange = renderPieceActionFields;
    get('iu-action-choice').onchange = () => { get('iu-action-confirm').checked = false; };
    get('iu-action-find').onclick = findPieceActionOrders;
    get('iu-action-query').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); findPieceActionOrders(); } };
    get('iu-action-reload').onclick = () => { if (state.pieceAction) openPieceActions(state.pieceAction.id, state.pieceAction.unit); };
    root.querySelectorAll('dialog').forEach(dialog => {
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog.id); });
      dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(dialog.id); } });
    });
  }
  function registryHtml() {
    return `<section id="iu-registry" class="iu-panel iu-registry" role="tabpanel" aria-labelledby="iu-tab-units" hidden><div class="iu-panel-heading"><div><h2>${tr('Find a piece', 'البحث عن قطعة')}</h2><p>${tr('One row per piece. Search its identity, review its status, or select it for printing.', 'كل صف يمثل قطعة واحدة. ابحث عن هويتها، راجع حالتها أو حددها للطباعة.')}</p></div>${icon('scan')}</div><form id="iu-search-form" class="iu-search-panel"><label class="iu-field iu-unit-search">${icon('search')}<input id="iu-query" type="search" maxlength="160" value="${html(state.q)}" placeholder="${tr('Product, invoice number, SKU or barcode', 'المنتج، رقم الفاتورة، SKU أو الباركود')}" aria-label="${tr('Find units', 'البحث عن القطع')}" disabled></label><button id="iu-reset-search" type="button" class="iu-link" aria-label="${tr('Clear search and filters', 'مسح البحث والفلاتر')}">${icon('close')}${tr('Reset', 'مسح')}</button><select id="iu-status" aria-label="${tr('Unit status', 'حالة القطعة')}" disabled><option value="">${tr('All statuses', 'كل الحالات')}</option></select><button id="iu-search" class="btn btn-outline" type="submit" disabled>${tr('Search', 'بحث')}</button></form><div id="iu-unit-error" class="iu-inline-error" hidden><span id="iu-unit-error-text"></span><button id="iu-unit-retry" class="iu-link" type="button">${tr('Retry', 'إعادة المحاولة')}</button></div><div class="iu-quick-filters" role="group" aria-label="${tr('Quick status filters', 'تصفية سريعة بالحالة')}">${[['', tr('All pieces', 'كل القطع')], ['available', statusLabel('available')], ['prepared', statusLabel('prepared')], ['inspection-required', tr('To inspect', 'للفحص')]].map(([value, label]) => `<button type="button" data-quick-status="${value}" aria-pressed="${state.status === value}">${html(label)}</button>`).join('')}</div><div class="iu-registry-tools"><span role="status" aria-live="polite">${tr('Matching pieces', 'قطع مطابقة')} <b id="iu-stat-units">—</b></span><span>${tr('On this page', 'في الصفحة')} <b id="iu-stat-page">—</b></span><button id="iu-select-page" class="btn btn-outline" type="button" disabled>${tr('Select this page', 'تحديد الصفحة')}</button></div><div class="iu-log-caption"><details class="iu-column-picker"><summary>${tr('Columns', 'الأعمدة')}</summary><div>${[['invoice', tr('Invoice reference', 'مرجع الفاتورة')], ['warehouse', tr('Warehouse', 'المخزن')], ['registered', tr('Registered', 'تاريخ التسجيل')]].map(([key, label]) => `<label><input type="checkbox" data-iu-column="${key}" checked>${label}</label>`).join('')}</div></details><strong>${tr('Piece register', 'سجل القطع')}</strong><span>${tr('Newest registrations first', 'الأحدث تسجيلًا أولًا')}</span><span id="iu-log-loading" role="status" hidden>${tr('Searching…', 'جارٍ البحث…')}</span></div><div id="iu-units" class="iu-units" aria-busy="false"></div><div class="iu-pagination"><span id="iu-page"></span><div><button id="iu-prev" class="btn btn-outline" type="button" disabled>${tr('Previous', 'السابق')}</button><button id="iu-next" class="btn btn-outline" type="button" disabled>${tr('Next', 'التالي')}</button></div></div><details class="iu-catalog"><summary>${tr('Matching products · shared SKU', 'منتجات مطابقة · SKU مشترك')} <span id="iu-products-count">0</span></summary><p id="iu-product-limit"></p><div id="iu-products"></div></details></section>`;
  }
  function dialogsHtml() { return actionDialogMarkup() + baseDialogsHtml(); }
  function baseDialogsHtml() {
    return `<dialog id="iu-register-dialog" class="iu-dialog iu-register-dialog" aria-labelledby="iu-register-title" hidden><form id="iu-register-form"><header class="iu-dialog-header"><h2 id="iu-register-title"></h2><button class="btn iu-icon-button" type="button" data-iu-close="iu-register-dialog" aria-label="${tr('Close', 'إغلاق')}">${icon('close')}</button></header><div class="iu-dialog-body"><p id="iu-register-detail" class="iu-help"></p><label class="iu-form-field">${tr('Physical count now', 'العدد الموجود فعليًا الآن')}<input name="physicalQuantity" type="number" step="1" required></label><label class="iu-form-field">${tr('Warehouse / location', 'المخزن / الموقع')}<select name="warehouseCode" data-warehouse-select required>${window.SouliaWarehouses?.options() || '<option value="MAIN">المخزن الرئيسي</option>'}</select></label><label class="iu-form-field">${tr('Count reference / reason', 'مرجع الجرد / سبب التسجيل')}<input name="reason" maxlength="1000" required></label><label class="iu-check iu-confirm"><input name="physicalPossessionConfirmed" type="checkbox" required><span>${tr('I physically counted these pieces from this invoice.', 'أؤكد أنني عددت هذه القطع من هذه الفاتورة فعليًا.')}</span></label><p class="iu-help">${tr('This records missing identities only. It does not add stock or duplicate the purchase. New pieces await quality inspection.', 'يسجل الهويات الناقصة فقط. لا يضيف مخزونًا ولا يكرر الشراء. تنتظر القطع الجديدة فحص الجودة.')}</p><p data-dialog-message role="status"></p></div><footer class="iu-dialog-footer"><button class="btn btn-outline" type="button" data-iu-close="iu-register-dialog">${tr('Cancel', 'إلغاء')}</button><button class="btn btn-primary" type="submit">${tr('Register unit codes', 'تسجيل أكواد القطع')}</button></footer></form></dialog>
      <dialog id="iu-units-dialog" class="iu-dialog iu-wide-dialog" aria-labelledby="iu-units-title" hidden><header class="iu-dialog-header"><h2 id="iu-units-title"></h2><button class="btn iu-icon-button" type="button" data-iu-close="iu-units-dialog" aria-label="${tr('Close', 'إغلاق')}">${icon('close')}</button></header><div class="iu-dialog-body"><p id="iu-line-units-meta" class="iu-help"></p><section id="iu-label-audit" class="iu-label-audit"></section><p data-dialog-message role="status"></p><div id="iu-line-units"></div></div><footer class="iu-dialog-footer"><button id="iu-line-prev" class="btn btn-outline" type="button">${tr('Previous', 'السابق')}</button><button id="iu-line-next" class="btn btn-outline" type="button">${tr('Next', 'التالي')}</button><button id="iu-line-preview" class="btn btn-primary" type="button">${tr('Back to label batch', 'الرجوع لدفعة الملصقات')}</button></footer></dialog>
      <dialog id="iu-preview-section" class="iu-dialog iu-preview-dialog" aria-labelledby="iu-preview-title" hidden><header class="iu-dialog-header"><h2 id="iu-preview-title">${tr('Label preview', 'معاينة الملصقات')}</h2><button class="btn iu-icon-button" type="button" data-iu-close="iu-preview-section" aria-label="${tr('Close', 'إغلاق')}">${icon('close')}</button></header><div class="iu-preview-layout"><div class="iu-preview-summary"><strong id="iu-preview-total"></strong><p id="iu-preview-size" dir="ltr"></p></div><div class="iu-preview-stage"><div class="iu-preview-toolbar"><span>${tr('Check your labels before printing', 'راجع الملصقات قبل الطباعة')}</span><label>${tr('Zoom', 'نسبة التكبير')}<select dir="ltr" id="iu-preview-zoom" aria-label="${tr('Preview zoom', 'تكبير المعاينة')}"><option value="100">${tr('100%', '100٪')}</option><option value="125">${tr('125%', '125٪')}</option><option value="150">${tr('150%', '150٪')}</option><option value="200">${tr('200%', '200٪')}</option></select></label></div><div id="iu-previews" class="iu-previews"></div><p class="iu-preview-stage-note">${tr('Print at 100% scale with matching paper and no margins.', 'اطبع بمقياس 100٪ وبمقاس الورق المطابق دون هوامش.')}</p></div><p class="iu-preview-message" data-dialog-message role="status"></p></div><footer class="iu-dialog-footer"><button class="btn btn-outline" type="button" data-iu-close="iu-preview-section">${tr('Back to selection', 'الرجوع للتحديد')}</button><button id="iu-print" class="btn btn-primary" type="button" disabled>${icon('printer')}${tr('Print / reprint', 'طباعة / إعادة طباعة')}</button></footer></dialog>`;
  }
  window.renderBarcodeManagement = async function () {
    if (state.busy) { state.refreshQueued = true; return; }
    const root = get('page-barcodes'); if (!root) return;
    const generation = ++state.generation; ++state.receiptRequest; ++state.unitRequest; ++state.unitDialogRequest; ++state.pieceActionRequest;
    state.pieceAction = null;
    clearTimeout(state.receiptTimer); clearTimeout(state.unitTimer);
    root.querySelectorAll('dialog[open]').forEach(d => d.close());
    const actor = typeof currentUser === 'undefined' ? null : currentUser, actorId = String(actor?._id || actor?.id || actor?.userId || actor?.username || '');
    if (state.stockScope?.actor && state.stockScope.actor !== actorId) state.stockScope = null;
    if (actorId !== state.actor) { state.selected.clear(); state.activeInvoice = null; state.sizeId = ''; state.registrationRequests.clear(); state.ranges.clear(); state.receipts = []; state.actor = actorId; }
    if (!has('inventory-units-view')) { state.selected.clear(); root.innerHTML = emptyState(tr('Permission denied', 'الصلاحية غير متاحة'), tr('Ask an administrator for inventory-unit access.', 'تواصل مع المسؤول لإتاحة الوصول إلى القطع.')); return; }
    state.labelAudit = null; state.ready = false; state.config = null; state.preview = null; state.unitsReady = false; state.unitLoading = false; state.receiptLoading = false;
    const match = location.hash.match(/^#barcodes\/receipt\/([a-f\d]{24})(?:\/([^/]+))?$/i), linkedId = match?.[1]?.toLowerCase();
    const canPurchase = has('purchase-view'); if (!canPurchase) state.view = 'units'; else if (linkedId) state.view = 'receipts';
    root.dir = tr('ltr', 'rtl'); root.classList.add('iu-option-a');
    root.innerHTML = `<header class="iu-header"><div><h1>${tr('Barcode management', 'إدارة الباركود')}</h1><p class="iu-subtitle">${tr('Choose an invoice, select pieces, then preview and print their labels.', 'اختر الفاتورة، حدد القطع، ثم عاين الملصقات واطبعها.')}</p></div><div class="iu-header-actions"><span id="iu-connection" class="iu-connection" data-state="loading">${tr('Connecting…', 'جار الاتصال…')}</span><button id="iu-refresh" class="btn btn-outline iu-icon-button" type="button" aria-label="${tr('Refresh data', 'تحديث البيانات')}">${icon('refresh')}</button></div></header>
      <nav class="iu-tabs" role="tablist" aria-label="${tr('Barcode views', 'عروض الباركود')}"><button id="iu-tab-receipts" type="button" role="tab" data-iu-tab="receipts" ${canPurchase ? '' : 'hidden'}>${tr('Print by invoice', 'الطباعة حسب الفاتورة')} <span id="iu-tab-invoice-count" class="iu-count">0</span></button><button id="iu-tab-units" type="button" role="tab" data-iu-tab="units">${tr('Find a piece', 'البحث عن قطعة')}</button></nav>
      <div id="iu-message" role="status" aria-live="polite"></div><section id="iu-error" class="iu-inline-error" role="alert" hidden><div><strong id="iu-error-title"></strong><p id="iu-error-detail"></p></div><button id="iu-retry" class="btn btn-outline" type="button">${tr('Retry', 'إعادة المحاولة')}</button></section><div id="iu-receipt-filter" hidden></div>
      <div id="iu-workspace" class="iu-workspace" data-view="receipts"><aside id="iu-invoice-rail" class="iu-panel iu-invoice-rail"><div class="iu-rail-head"><h2>${tr('Invoices', 'الفواتير')} <span id="iu-invoice-count" class="iu-count">0</span></h2><label class="iu-field">${icon('search')}<input id="iu-receipt-query" type="search" maxlength="160" value="${html(state.receiptQuery)}" placeholder="${tr('Invoice, supplier or product', 'الفاتورة، المورد أو المنتج')}" aria-label="${tr('Find invoices', 'البحث عن الفواتير')}"></label><div class="iu-rail-filters"><button class="iu-chip active" data-receipt-filter="all" type="button">${tr('All', 'الكل')}</button><button class="iu-chip" data-receipt-filter="missing" type="button">${tr('Needs codes', 'تحتاج أكواد')}</button><button class="iu-chip" data-receipt-filter="ready" type="button">${tr('Codes complete', 'مكتملة الأكواد')}</button></div></div><div id="iu-receipts-error" class="iu-inline-error" hidden><span id="iu-receipts-error-text"></span><button id="iu-receipts-retry" class="iu-link" type="button">${tr('Retry', 'إعادة المحاولة')}</button></div><div id="iu-receipt-list" class="iu-invoice-list"><div class="iu-skeleton"></div></div><div class="iu-rail-footer"><span id="iu-receipt-progress"></span><button id="iu-more-receipts" class="iu-link" type="button" hidden>${tr('Load more invoices', 'تحميل المزيد من الفواتير')}</button><p>${tr('Your label batch stays selected while switching invoices.', 'يظل تحديد الدفعة محفوظًا أثناء التنقل بين الفواتير.')}</p></div></aside>
      <section id="iu-invoice-detail" class="iu-panel iu-invoice-detail" role="tabpanel" aria-labelledby="iu-tab-receipts" aria-label="${tr('Invoice products', 'منتجات الفاتورة')}"></section>${registryHtml()}
      <aside class="iu-panel iu-label-panel"><div class="iu-panel-heading iu-print-heading">${icon('printer')}<h2>${tr('Label batch', 'دفعة الملصقات')}</h2></div><div class="iu-print-body"><div class="iu-print-first"><p class="iu-step"><b>1</b>${tr('Selected pieces', 'القطع المحددة')}</p><div class="iu-batch-total"><strong id="iu-stat-selected">0</strong><span>${tr('piece labels', 'ملصق قطعة')}</span></div><div class="iu-capacity"><i id="iu-capacity"></i></div><div class="iu-capacity-caption"><span id="iu-batch-source"></span><span>${tr('Limit 100', 'الحد 100')}</span></div><div id="iu-queue" class="iu-queue"></div></div><div class="iu-print-second"><p class="iu-step"><b>2</b>${tr('Label dimensions', 'مقاس الملصق')}</p>${paperPickerHtml()}<div class="iu-paper-placeholder"><div class="iu-demo-label" role="img" aria-label="${tr('Sample label for illustration only, not for scanning', 'نموذج ملصق توضيحي فقط، غير مخصص للمسح')}"><div class="iu-demo-brand"><b>SOULIA HOME</b><span>${tr('SAMPLE', 'نموذج')}</span></div><div class="iu-demo-content"><svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M1 1h10v10H1zm20 0h10v10H21zM1 21h10v10H1zM14 2h4v5h-4zm0 9h4v7h-4zM2 14h7v4H2zm19 0h4v4h-4zm7 0h3v7h-3zM14 22h4v9h-4zm7-1h4v4h-4zm3 7h7v3h-7z"/><path fill="white" d="M3 3h6v6H3zm20 0h6v6h-6zM3 23h6v6H3z"/><path fill="currentColor" d="M5 5h2v2H5zm20 0h2v2h-2zM5 25h2v2H5z"/></svg><div><strong>${tr('Sample product', 'منتج تجريبي')}</strong><bdi>SKU: SAMPLE-01</bdi><span>EGP 250.00</span></div></div><div class="iu-demo-code">SAMPLE · NOT FOR SCANNING</div></div><span id="iu-paper-size" dir="ltr"></span><small>${tr('Illustration only · preview your actual labels before printing', 'نموذج توضيحي · عاين الملصقات الفعلية قبل الطباعة')}</small></div><button id="iu-preview" class="btn btn-primary iu-full-button" type="button" disabled>${icon('eye')}${tr('Preview labels', 'معاينة الملصقات')}</button><p class="iu-help" id="iu-preview-hint"></p><p id="iu-selection" class="iu-selection-caption"></p><button id="iu-clear" class="iu-clear" type="button" disabled>${tr('Clear batch selection', 'مسح تحديد الدفعة')}</button><details class="iu-print-help"><summary>${tr('Printer setup', 'إعدادات الطابعة')}</summary><p>${tr('Use matching paper, 100% scale, zero margins, and disable headers and footers.', 'استخدم الورق المطابق، ومقياس 100٪، ودون هوامش أو ترويسات.')} ${tr('Physical printing is verified by the operator.', 'يتحقق الموظف من خروج الملصقات فعليًا.')}</p></details></div></div></aside></div>
      <div id="iu-mobile-bar" class="iu-mobile-bar" hidden><span><b id="iu-mobile-total">0</b> ${tr('labels selected', 'ملصق محدد')}</span><button id="iu-mobile-preview" class="btn btn-primary" type="button" disabled>${tr('Preview & print', 'معاينة وطباعة')}</button></div>${dialogsHtml()}`;
    bindEvents(root); renderDetail(); renderBatch(); switchView(state.view);
    try {
      const config = await api('/inventory-units/config');
      if (generation !== state.generation) return;
      if (!Array.isArray(config.statuses) || !Array.isArray(config.labelSizes) || config.symbology && config.symbology !== 'QR') throw new Error(tr('Unsupported barcode configuration.', 'إعدادات الباركود غير مدعومة.'));
      state.config = config; state.ready = true;
      if (!config.labelSizes.some(s => s.id === state.sizeId)) state.sizeId = config.labelSizes.find(size => size.id === '50x25')?.id || config.labelSizes[0]?.id || '';
      get('iu-size').insertAdjacentHTML('beforeend', config.labelSizes.map(size => `<option value="${html(size.id)}">${size.widthMm} × ${size.heightMm} mm</option>`).join('')); get('iu-size').value = state.sizeId;
      get('iu-status').insertAdjacentHTML('beforeend', config.statuses.map(s => `<option value="${html(s)}">${html(statusLabel(s))}</option>`).join('')); get('iu-status').value = state.status;
      get('iu-size-options').innerHTML = config.labelSizes.map(size => `<button class="iu-size-option" type="button" role="option" data-paper-size="${html(size.id)}" aria-selected="false"><span class="iu-size-thumbnail"><i style="width:${Math.min(44, Number(size.widthMm) / 2)}px;height:${Math.min(30, Number(size.heightMm) / 2)}px"></i></span><span><bdi>${size.widthMm} × ${size.heightMm} mm</bdi><small>${tr('Width × height', 'العرض × الارتفاع')}</small></span><span class="iu-size-tick">${icon('check')}</span></button>`).join('');
      syncSizePicker();
      get('iu-connection').textContent = tr('Connected', 'متصل'); get('iu-connection').dataset.state = 'ready';
      if (!has('inventory-units-print')) get('iu-print').title = tr('Printing permission required', 'تتطلب صلاحية الطباعة');
      if (linkedId && canPurchase) {
        try {
          const invoice = await fetchInvoice(linkedId); if (generation !== state.generation) return; chooseInvoice(invoice, false);
        } catch (error) { if (generation === state.generation) message(error.message, true); }
      }
      if (generation !== state.generation) return;
      await Promise.allSettled([canPurchase ? loadReceipts() : Promise.resolve(), state.view === 'units' ? loadUnits() : Promise.resolve()]);
      if (generation !== state.generation) return;
      renderBatch();
      if (state.stockScope?.preview && state.unitsReady) {
        state.stockScope.preview = false;
        if (state.stockScope.unitIds && (state.rows.length !== state.stockScope.unitIds.length || state.rows.some(unit => !state.stockScope.unitIds.includes(String(unit._id))))) {
          message(tr('Some selected pieces changed. Review the count before printing.', 'تغيرت بعض القطع المختارة. راجع الجرد قبل الطباعة.'), true); return;
        }
        for (const unit of state.rows) state.selected.set(String(unit._id), unit);
        syncUnitChecks(); renderBatch();
        await preview();
      }
    } catch (error) {
      if (generation !== state.generation) return;
      state.ready = false; get('iu-error').hidden = false;
      get('iu-error-title').textContent = [401, 403].includes(error.status) ? tr('Permission denied', 'الصلاحية غير متاحة') : tr('Barcode service unavailable', 'خدمة الباركود غير متاحة');
      get('iu-error-detail').textContent = error.status === 404 ? tr('The running backend needs an update. Rebuild and restart, then retry.', 'يلزم تحديث الباك إند الحالي وإعادة بنائه وتشغيله ثم إعادة المحاولة.') : error.message;
      get('iu-connection').textContent = tr('Connection unavailable', 'الاتصال غير متاح'); get('iu-connection').dataset.state = 'error';
      get('iu-retry').onclick = () => window.renderBarcodeManagement(); updateActions();
    }
  };
  function openStockUnits(scope) {
    if (!has('inventory-units-view')) return;
    const actor = typeof currentUser === 'undefined' ? null : currentUser;
    state.stockScope = { ...scope, actor: String(actor?._id || actor?.id || actor?.userId || actor?.username || '') }; state.selected.clear(); state.view = 'units'; state.page = 1; state.q = scope.identifier || ''; state.status = '';
    if (currentPage === 'barcodes') { history.replaceState(null, '', '#barcodes'); void window.renderBarcodeManagement(); }
    else navigateTo('barcodes');
  }
  window.InventoryUnitLabels = { labelHtml, validateBatch, waitForLayout, openStockUnits, previewSheets, printSuccess, confirmReprint,
    receiptChanged: id => {
      if (typeof currentPage === 'undefined' || currentPage !== 'barcodes' || !state.ready) return;
      if (id && state.activeInvoice?.transactionId !== String(id) && !state.receipts.some(invoice => invoice.transactionId === String(id))) return;
      if (state.busy) { state.refreshQueued = true; return; }
      if (!state.pendingPrint) invalidatePreview();
      void refreshData();
    },
    refreshAfterPackChange: () => { state.selected.clear(); syncUnitChecks(); renderBatch(); void refreshData(); },
    refreshAfterPackPrint: refreshData,
    selection: () => ({ ids: selectedIds(), units: [...state.selected.values()], sizeId: state.sizeId, ready: state.ready, busy: state.busy, config: state.config }) };
  if (typeof currentPage !== 'undefined' && currentPage === 'barcodes') window.renderBarcodeManagement();
}());

