/* Purchase receipt metadata only. Invoice posting and physical unit identities remain server-owned. */
(function () {
  'use strict';
  const tr = (en, ar) => currentLang === 'en' ? en : ar;
  window.purchaseReceiptFields = function (prefix = 'conv') {
    const warehouseField = prefix === 'conv' ? (window.SouliaWarehouses?.field(prefix) || '') : '';
    if (!hasPerm('inventory-units-receive')) return warehouseField;
    if (!['conv', 'tx'].includes(prefix)) throw new Error('Unsupported receipt form');
    let pending = false;
    if (prefix === 'tx') { try { pending = !!pendingManualReceipt(); } catch { /* Sending remains blocked if storage is unavailable. */ } }
    return `${warehouseField}<div class="purchase-receipt purchase-receipt-compact" id="${prefix}-receipt" role="group" aria-label="${tr('Unit barcodes', 'باركود القطع')}">
      <label class="purchase-receipt-check"><input id="${prefix}-track-units" type="checkbox" aria-controls="${prefix}-receipt-details" aria-expanded="false" onchange="togglePurchaseReceiptFields('${prefix}')"><span>${tr('Received in good condition · create barcodes', 'استلمت القطع سليمة — إنشاء باركود')}</span></label>
      <div id="${prefix}-receipt-details" class="purchase-receipt-details" hidden>
      <input id="${prefix}-unit-reason" maxlength="1000" aria-label="${tr('Reference (optional)', 'مرجع (اختياري)')}" placeholder="${tr('Reference (optional)', 'مرجع (اختياري)')}" disabled></div>
      ${prefix === 'tx' ? `<div class="purchase-receipt-recovery" ${pending ? '' : 'hidden'}><button type="button" class="btn btn-outline" onclick="resumeManualPurchaseReceipt()">${tr('Review / retry a pending receipt', 'مراجعة / إعادة استلام معلق')}</button></div>` : ''}</div>`;
  };
  window.togglePurchaseReceiptFields = function (prefix) {
    const checkbox = document.getElementById(prefix + '-track-units'), details = document.getElementById(prefix + '-receipt-details');
    if (!checkbox || !details) return;
    details.hidden = !checkbox.checked; checkbox.setAttribute('aria-expanded', String(checkbox.checked));
    details.querySelectorAll('input').forEach(input => { input.disabled = !checkbox.checked; });
  };
  window.readPurchaseReceiptTracking = function (prefix = 'conv') {
    if (!document.getElementById(prefix + '-track-units')?.checked) return null;
    if (!hasPerm('inventory-units-receive')) throw new Error(tr('Unit receiving permission required.', 'صلاحية استلام الوحدات مطلوبة.'));
    const warehouseCode = window.SouliaWarehouses?.read(prefix) || 'MAIN';
    const reason = document.getElementById(prefix + '-unit-reason')?.value.trim() || '';
    const physicalPossessionConfirmed = document.getElementById(prefix + '-track-units')?.checked === true;
    if (!warehouseCode || !physicalPossessionConfirmed) throw new Error(tr('Confirm physical receipt and sound condition, and select the warehouse first.', 'أكّد الاستلام الفعلي وسلامة القطع واختر المخزن أولاً.'));
    return { physicalPossessionConfirmed, inspectionPassed: true, warehouseCode, reason };
  };
  window.openPurchaseReceiptLabels = function (transactionId) {
    if (!/^[a-f\d]{24}$/i.test(transactionId) || !hasPerm('inventory-units-view')) return;
    closeModal(); history.pushState(null, '', '#barcodes/receipt/' + transactionId); navigateTo('barcodes', false);
  };
  window.showPurchaseReceiptSummary = async function (poId, saved) {
    let summary;
    try {
      if (poId && hasPerm('purchase-view')) summary = await api('/purchase-orders/' + encodeURIComponent(poId) + '/receipt');
      else if (saved?.receipt) summary = { ...saved.receipt, transactionId: saved.transaction._id, lines: saved.receipt.lines || [], labelRequests: 0 };
      else throw new Error(tr('Purchase view permission required.', 'صلاحية عرض المشتريات مطلوبة.'));
      const rows = (summary.lines || []).map(line => {
        const product = typeof products !== 'undefined' ? products.find(product => product.code === line.sku) : null;
        return `<tr><td><strong dir="auto">${esc(line.name || product?.name || line.sku || '')}</strong><bdi>${esc(line.sku || '')}</bdi></td><td>${Number(line.receivedQty)}</td><td>${Number(line.createdUnits)}</td></tr>`;
      }).join('');
      openModal(`<section class="purchase-receipt-summary"><h3>${tr('Receipt summary', 'ملخص الاستلام')}</h3>
        <div class="prs-totals"><span>${tr('Pieces with codes', 'قطع لها أكواد')}<strong>${Number(summary.createdUnits || 0)}</strong></span><span>${tr('Labels sent to print', 'ملصقات أُرسلت للطباعة')}<strong>${Number(summary.labelRequests || 0)}</strong></span></div>
        <div class="prs-table"><table><thead><tr><th>${tr('Product', 'المنتج')}</th><th>${tr('Received', 'المستلم')}</th><th>${tr('Coded', 'المكود')}</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="prs-note">${tr('Print labels now, or later from Barcode management.', 'اطبع الملصقات الآن، أو لاحقًا من إدارة الباركود.')}</p>
        ${(summary.unresolvedErrors || []).map(error => `<p role="alert" style="color:var(--red)">${esc(error)}</p>`).join('')}
        <footer>${summary.createdUnits && summary.transactionId && hasPerm('inventory-units-view') ? `<button class="btn btn-primary" onclick="openPurchaseReceiptLabels('${esc(summary.transactionId)}')">${tr('Preview and print labels', 'معاينة الملصقات وطباعتها')}</button>` : ''}<button class="btn btn-outline" onclick="closeModal()">${tr('Close', 'إغلاق')}</button></footer></section>`, 'max-width:640px;max-height:85vh;overflow:auto');
    } catch (error) { toast(tr('Invoice was not reposted. Receipt summary: ', 'لم تتم إعادة ترحيل الفاتورة. ملخص الاستلام: ') + error.message, true); }
  };
  function manualStorageKey() {
    const actor = typeof currentUser === 'undefined' ? null : currentUser;
    const id = actor?._id || actor?.id || actor?.userId || actor?.username;
    if (!id) throw new Error(tr('Authenticated user required.', 'يلزم مستخدم مسجل الدخول.'));
    return 'soulia-manual-receipt:v1:' + encodeURIComponent(id);
  }
  function pendingManualReceipt() { return JSON.parse(sessionStorage.getItem(manualStorageKey()) || 'null'); }
  window.hasPendingManualPurchaseReceipt = () => !!pendingManualReceipt();
  window.resumeManualPurchaseReceipt = function () {
    try {
      const pending = pendingManualReceipt();
      if (!pending) { toast(tr('No pending manual receipt.', 'لا يوجد استلام يدوي معلق.')); return; }
      pendingTxData = { ...pending.invoice, _unitTracking: pending.tracking };
      showTxConfirmation(pendingTxData);
    } catch (error) { toast(error.message, true); }
  };
  let manualBusy = false;
  window.submitManualPurchaseWithUnits = async function (body) {
    if (manualBusy) throw new Error(tr('Receipt request already in progress.', 'طلب الاستلام قيد التنفيذ بالفعل.'));
    const storageKey = manualStorageKey();
    const { _unitTracking: tracking, ...invoice } = body;
    const previous = pendingManualReceipt();
    // The form cannot silently replace a request whose financial outcome is unknown.
    if (previous && (JSON.stringify(previous.invoice) !== JSON.stringify(invoice) || JSON.stringify(previous.tracking) !== JSON.stringify(tracking))) throw new Error(tr('Review and retry the original pending receipt first.', 'راجع وأعد محاولة الاستلام المعلق الأصلي أولًا.'));
    const request = previous || { operationKey: crypto.randomUUID(), invoice, tracking };
    manualBusy = true; const controller = new AbortController(); let timer, dispatched = false;
    try {
      if (navigator.onLine === false) throw new Error(tr('A live connection is required; the invoice was not submitted.', 'يلزم اتصال مباشر؛ لم تُرسل الفاتورة.'));
      if (!previous) {
        timer = setTimeout(() => controller.abort(), 15000);
        const readiness = await api('/inventory-units/purchases/readiness', { signal: controller.signal });
        clearTimeout(timer);
        if (controller.signal.aborted) throw new Error(tr('Readiness check timed out; no invoice was submitted.', 'انتهت مهلة التحقق من الجاهزية؛ لم تُرسل الفاتورة.'));
        if (!readiness.writesReady) throw new Error(tr('Unit receiving is not configured on this server. MongoDB transactions and tracking indexes must be prepared by an administrator first.', 'استلام الوحدات غير مجهز على هذا الخادم. يلزم تجهيز معاملات MongoDB وفهارس التتبع بواسطة المسؤول أولًا.'));
      }
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      dispatched = true;
      const result = await Promise.race([
        api('/inventory-units/purchases/receive', { method: 'POST', body: JSON.stringify(request), signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, 20000); })
      ]);
      if (!result?.transaction?._id || !result?.receipt || !result.operationId) throw new Error('Invalid receipt response');
      sessionStorage.removeItem(storageKey);
      return { ...result.transaction, _unitReceipt: result };
    } catch (error) {
      if (!dispatched) throw error;
      // A denial on a retry says nothing about whether the ORIGINAL request committed.
      if (!previous && [400, 401, 403, 422].includes(error.status)) { sessionStorage.removeItem(storageKey); throw error; }
      throw new Error(tr('Receipt outcome is unknown. Do not create another invoice; review/retry the original pending receipt. ', 'نتيجة الاستلام غير مؤكدة. لا تنشئ فاتورة أخرى؛ راجع أو أعد نفس الاستلام المعلق. ') + request.operationKey);
    } finally {
      clearTimeout(timer); manualBusy = false;
      let pending = true; try { pending = !!pendingManualReceipt(); } catch { /* Keep recovery visible on uncertain storage state. */ }
      document.querySelectorAll('.purchase-receipt-recovery').forEach(element => { element.hidden = !pending; });
    }
  };
}());
