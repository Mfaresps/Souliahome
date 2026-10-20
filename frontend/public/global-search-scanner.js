/* Header entry point for viewing a scanned unit's product using authenticated APIs. */
(function () {
  'use strict';
  const input = document.getElementById('global-search');
  const app = document.getElementById('app');
  if (!input || !app) return;
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const when = (value, includeTime = false) => {
    if (!value) return '';
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString(tr('en-GB', 'ar-EG-u-nu-latn'), { timeZone:'Africa/Cairo', year:'numeric', month:'2-digit', day:'2-digit', ...(includeTime ? {hour:'2-digit',minute:'2-digit'} : {}) });
  };
  const actorId = () => {
    const user = typeof currentUser === 'undefined' ? null : currentUser;
    return user && String(user._id || user.id || user.userId || user.username || '');
  };
  const allowed = () => !!actorId() && typeof hasPerm === 'function' && hasPerm('inventory-units-view');
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.id = 'global-search-scan'; trigger.className = 'global-scan-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'global-unit-scan-dialog');
  trigger.setAttribute('aria-keyshortcuts','F');
  trigger.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5"/><path d="M8 8h3v3H8zm6 0h2v3h-2zm-6 6h3v2H8zm6 0h2v2h-2z"/></svg>';
  input.parentElement.append(trigger);
  const dialog = document.createElement('dialog');
  dialog.id = 'global-unit-scan-dialog'; dialog.className = 'gs-unit-dialog'; dialog.setAttribute('aria-labelledby', 'gs-unit-scan-title');
  dialog.innerHTML = '<div class="gs-unit-dialog-heading"><h2 id="gs-unit-scan-title"></h2><button type="button" class="btn btn-outline" data-gs-close></button></div><div data-gs-scanner></div><section class="gs-unit-result" data-gs-result hidden aria-live="polite"></section>';
  app.append(dialog);
  let scanner, generation = 0, openingActor = '';
  const resultHost = dialog.querySelector('[data-gs-result]');
  function close() {
    generation++; scanner?.destroy(); scanner = null;
    if (dialog.open) dialog.close();
    if (allowed() && getComputedStyle(app).display !== 'none') trigger.focus();
  }
  dialog.querySelector('[data-gs-close]').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { generation++; scanner?.destroy(); scanner = null; });

  async function showUnit(unit) {
    const request = ++generation;
    resultHost.hidden = false;
    resultHost.textContent = tr('Loading product details…', 'جارٍ تحميل تفاصيل المنتج…');
    try {
      const [response, identity] = await Promise.all([
        api('/inventory-units?q=' + encodeURIComponent(unit.barcode) + '&limit=1', { signal: AbortSignal.timeout(10000) }),
        api('/inventory-units/' + encodeURIComponent(unit.barcode), { signal: AbortSignal.timeout(10000) })
      ]);
      if (request !== generation || !dialog.open || actorId() !== openingActor) return;
      if (!allowed()) throw new Error(tr('Permission denied.', 'ليس لديك صلاحية العرض.'));
      const found = response.units?.find(item => String(item._id) === String(unit._id));
      if (String(identity.unit?._id) !== String(unit._id)) throw new Error(tr('Unit details changed. Scan again.', 'تغيّرت بيانات القطعة. أعد المسح.'));
      const row = found ? { ...found, ...identity.unit, product: found.product } : identity.unit?.isPack ? {...identity.unit,product:{}} : null;
      if ((!row?.product?.code && !row?.isPack) || !row.productId) throw new Error(tr('The matched product is unavailable.', 'الصنف المرتبط بهذه الوحدة غير متاح.'));
      const [product, inventory, availableUnits] = await Promise.all([
        api('/products/' + encodeURIComponent(row.productId), { signal: AbortSignal.timeout(10000) }),
        api('/transactions/inventory', { signal: AbortSignal.timeout(10000) }),
        api('/inventory-units?productId=' + encodeURIComponent(row.productId) + '&status=available&limit=1', { signal: AbortSignal.timeout(10000) })
      ]);
      if (request !== generation || !dialog.open || actorId() !== openingActor || !allowed()) return;
      if (String(product._id) !== String(row.productId) || (!row.isPack && product.code !== row.product.code)) throw new Error(tr('Product details changed. Reload the details.', 'تغيّرت بيانات الصنف. أعد تحميل البيانات.'));
      resultHost.replaceChildren();
      const card = document.createElement('div'); card.className = 'gs-product-card';
      const image = document.createElement('img'); image.className = 'gs-product-image'; image.alt = product.name || ''; image.loading = 'lazy';
      image.onerror = () => { image.hidden = true; card.classList.add('gs-no-image'); };
      const imageUrl = product.imageUrl || product.image;
      if (imageUrl) image.src = imageUrl;
      else { image.hidden = true; card.classList.add('gs-no-image'); }
      card.append(image);
      const details = document.createElement('div'); details.className = 'gs-product-details';
      const name = document.createElement('h3'); name.textContent = product.name || row.product.name || ''; details.append(name);
      const statusNames = { opened: ['Opened pack','باك مفتوح'], mixed:['Mixed status','حالات مختلفة'], inconsistent:['Review pack','راجع الباك'], available: ['Available','متاحة'], reserved: ['Reserved','محجوزة'], picking: ['Being prepared','قيد التحضير'], prepared: ['Prepared','مجهّزة'], shipped: ['Shipped','مع شركة الشحن'], delivered: ['Delivered','تم التسليم'], returned: ['Returned','مرتجعة'], 'inspection-required': ['Awaiting inspection','بانتظار الفحص'], damaged: ['Damaged','تالفة'], lost: ['Lost','مفقودة'], retired: ['Retired','مستبعدة'], 'supplier-return-pending': ['Reserved for supplier return','محجوزة لمرتجع مورد'], 'returned-to-supplier': ['Returned to supplier','مرتجعة للمورد'] };
      const state = document.createElement('div'); state.className = 'gs-unit-state'; state.dataset.status = row.status;
      const badge = document.createElement('span'); badge.className = 'gs-unit-status'; badge.setAttribute('role','status');
      badge.textContent = (row.isPack ? `${row.quantity} ${tr('pieces / pack','قطع / باك')} · ` : '') + (statusNames[row.status] ? tr(...statusNames[row.status]) : row.status);
      state.append(badge);
      let salesInvoice;
      if (row.assignment?.transactionId) {
        const order = identity.assignmentOrder;
        const orderStates = { Pending:['Pending','معلّق'], Preparing:['Preparing','قيد التحضير'], Ready:['Ready','جاهز للشحن'], 'Picked-Up':['Picked up','تم الاستلام'], Shipped:['Shipped','تم الشحن'], Delivered:['Delivered','تم التسليم'] };
        if (order) { const status = document.createElement('span'); status.className = 'gs-linked-order-status'; status.textContent = tr('Order status: ','حالة الطلب: ') + (order.cancelled ? tr('Cancelled','ملغى') : order.archived ? tr('Archived','مؤرشف') : orderStates[order.pickupStatus] ? tr(...orderStates[order.pickupStatus]) : order.pickupStatus || tr('Not specified','غير محددة')); state.append(status); }
        const relation = document.createElement('div'); relation.className = 'gs-unit-order gs-unit-invoice gs-sales-invoice';
        const ref = document.createElement('strong'); ref.textContent = order ? tr('Sales invoice ', 'فاتورة البيع ') + (order.ref ? '#' + String(order.ref).replace(/^#+/,'') : tr('(no reference)', '(بدون رقم)')) : tr('Linked order unavailable', 'الطلب المرتبط غير متاح');
        relation.append(ref);
        if (order?.client) { const client = document.createElement('span'); client.dir = 'auto'; client.textContent = order.client; relation.append(client); }
        if (order?.date) { const date = document.createElement('small'); date.textContent = tr('Invoice date: ', 'تاريخ فاتورة العميل: ') + when(order.date); relation.append(date); }
        if (order?.cancelled || order?.archived) { const note = document.createElement('small'); note.className = 'gs-unit-order-warning'; note.textContent = order.cancelled ? tr('This order is cancelled', 'هذا الطلب ملغى') : tr('This order is archived', 'هذا الطلب مؤرشف'); relation.append(note); }
        salesInvoice = relation;
      }
      const purchase = identity.purchaseInvoice;
      if (purchase) {
        const source = document.createElement('div'); source.className = 'gs-unit-invoice gs-purchase-invoice';
        const title = document.createElement('strong'); title.textContent = tr('Purchase invoice ', 'فاتورة الشراء ') + (purchase.ref ? '#' + String(purchase.ref).replace(/^#+/,'') : '');
        source.append(title);
        if (purchase.date || purchase.createdAt) { const date = document.createElement('span'); date.textContent = tr('Invoice date: ', 'تاريخ الفاتورة: ') + when(purchase.date || purchase.createdAt); source.append(date); }
        if (purchase.createdAt) { const registered = document.createElement('small'); registered.textContent = tr('Invoice recorded: ', 'تسجيل الفاتورة: ') + when(purchase.createdAt, true); source.append(registered); }
        details.append(source);
      } else {
        const source = document.createElement('div'); source.className = 'gs-unit-invoice gs-purchase-invoice';
        const title = document.createElement('strong'); title.textContent = tr('Purchase invoice','فاتورة الشراء');
        const note = document.createElement('small'); note.textContent = tr('Purchase invoice details are unavailable.','بيانات فاتورة الشراء غير متاحة.');
        source.append(title,note);details.append(source);
      }
      if (row.createdAt) { const registered = document.createElement('small'); registered.className = 'gs-unit-recorded'; registered.textContent = tr('Piece registered: ', 'تسجيل القطعة: ') + when(row.createdAt, true); details.append(registered); }
      details.append(state);
      if (salesInvoice) details.append(salesInvoice);
      if (identity.supplierReturn && ['supplier-return-pending', 'returned-to-supplier'].includes(row.status)) {
        const note = document.createElement('p'); note.className = 'gs-unit-order-warning';
        note.textContent = window.SupplierReturnPieces?.returnMessage(identity.supplierReturn, row.status === 'supplier-return-pending') || identity.supplierReturn.reason;
        details.append(note);
      }
      const lines = [tr('Piece code: ', 'كود القطعة: ') + (row.manualCode || row.barcode), 'SKU: ' + product.code,
        ...(product.size ? [tr('Size: ', 'المقاس: ') + product.size] : []),
        ...(product.colors?.length ? [tr('Colors: ', 'الألوان: ') + (Array.isArray(product.colors) ? product.colors.join('، ') : product.colors)] : []),
        tr('Location: ', 'المخزن: ') + (row.warehouseCode || tr('Unverified', 'غير مؤكد'))];
      for (const text of lines) { const line = document.createElement('p'); line.textContent = text; details.append(line); }
      const price = document.createElement('p'); price.className = 'gs-unit-price';
      const priceLabel = document.createElement('span'); priceLabel.textContent = tr('Selling price: ', 'سعر البيع: ');
      const amount = document.createElement('span'); amount.className = 'amt-num';
      amount.textContent = typeof product.sellPrice === 'number' && Number.isFinite(product.sellPrice) && product.sellPrice >= 0
        ? new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(product.sellPrice) + tr(' EGP', ' ج.م') : tr('Unavailable', 'غير متاح');
      price.append(priceLabel, amount); details.append(price);
      const stock = inventory.find(item => String(item._id) === String(row.productId) || item.code === product.code);
      const qty = document.createElement('p'); qty.className = 'gs-unit-available';
      qty.textContent = tr('Available to sell: ', 'متاح للبيع: ') + (Number.isFinite(Number(availableUnits.total)) ? Number(availableUnits.total) : '—');
      details.append(qty);
      if (stock && Number.isFinite(Number(stock.current))) {
        const onHand = document.createElement('p'); onHand.className = 'gs-unit-stock';
        onHand.textContent = tr('Stock on hand: ', 'إجمالي رصيد المخزن: ') + Number(stock.current);
        details.append(onHand);
      }
      card.append(details); resultHost.append(card);
    } catch (error) {
      if (request !== generation || !dialog.open || actorId() !== openingActor) return;
      resultHost.textContent = tr('Unit was validated, but product details could not load. ', 'تم التحقق من الوحدة، لكن تعذر تحميل تفاصيل المنتج. ') + error.message;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-outline';
      retry.textContent = tr('Retry loading details', 'إعادة تحميل البيانات'); retry.onclick = () => showUnit(unit); resultHost.append(retry);
    }
  }

  function openScanner(identifier) {
    if (!allowed() || !window.SouliaScanner) return;
    closeSearchDropdown();
    if (dialog.open) return;
    openingActor = actorId(); generation++; resultHost.hidden = true; resultHost.replaceChildren();
    dialog.dir = typeof currentLang !== 'undefined' && currentLang === 'en' ? 'ltr' : 'rtl';
    dialog.querySelector('h2').textContent = tr('Scan to view product', 'امسح الباركود لعرض المنتج');
    dialog.querySelector('[data-gs-close]').textContent = tr('Close', 'إغلاق');
    dialog.showModal();
    scanner = window.SouliaScanner.mount(dialog.querySelector('[data-gs-scanner]'), {
      api, actorId: openingActor, workflowKey: 'global-search-lookup', context: { intent: 'lookup' },
      lang: typeof currentLang === 'undefined' ? 'ar' : currentLang, canManualSelect: false,
      onResult(code, result) {
        if (code === 'VALIDATED' && result?.unit) void showUnit(result.unit);
        else { generation++; resultHost.hidden = true; }
      }
    });
    dialog.querySelector('[data-scan-input]')?.focus();
    if (identifier) {
      dialog.querySelector('[data-scan-input]').value = identifier;
      dialog.querySelector('[data-scan-form]').requestSubmit();
    }
  }
  trigger.onclick = () => openScanner();
  function visibleModal() {
    return [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], .modal-overlay.active, #soulia-modal-overlay.active, #bsf-overlay, #inv-detail-overlay.active')].some(modal => {
      if (!modal.getClientRects().length) return false;
      for (let node = modal; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
      }
      return true;
    });
  }
  window.addEventListener('keydown', event => {
    const scanShortcut = event.code === 'KeyF' || String(event.key || '').toLowerCase() === 'f' || event.key === 'ب';
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !scanShortcut) return;
    if (!allowed() || getComputedStyle(app).display === 'none' || visibleModal()) return;
    if (event.target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); openScanner();
  }, true);
  let physicalKeys = '', lastKeyAt = 0;
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !allowed()) return;
    const now = performance.now(), key = window.BarcodeInput?.key(event) ?? event.key;
    if (event.key === 'Enter') {
      let value = window.BarcodeInput?.normalize(input.value.trim()) ?? input.value.trim();
      const pattern = /^(?:SU-[A-F\d]{24}|PK-[A-F\d]{24}|PK-?\d{6}-?\d|U-?\d{4}-?\d{4}-?\d)$/i;
      if (!pattern.test(value) && now - lastKeyAt < 100 && pattern.test(physicalKeys)) value = physicalKeys;
      physicalKeys = '';
      if (!pattern.test(value)) return;
      event.preventDefault(); event.stopImmediatePropagation(); openScanner(value.toUpperCase());
      return;
    }
    if (key.length === 1) {
      if (now - lastKeyAt > 100) physicalKeys = '';
      physicalKeys = (physicalKeys + key).slice(-160); lastKeyAt = now;
    }
  }, true);
  function update() {
    const permitted = allowed(); trigger.hidden = !permitted;
    trigger.title = tr('Scan barcode to view product (F)', 'امسح الباركود لعرض المنتج (F)'); trigger.setAttribute('aria-label', trigger.title);
    input.parentElement.classList.toggle('has-unit-scanner', permitted);
    input.closest('.header-search')?.classList.toggle('has-unit-scanner',permitted);
    if (dialog.open && (!permitted || actorId() !== openingActor || getComputedStyle(app).display === 'none')) close();
  }
  new MutationObserver(update).observe(app, { attributes: true, attributeFilter: ['style', 'class'] });
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'dir'] });
  window.addEventListener('pagehide', close);
  update();
}());
