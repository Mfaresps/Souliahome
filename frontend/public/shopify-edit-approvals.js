/* Staff order edits remain proposals until an administrator reviews them. */
function spEditText(ar, en) { return currentLang === 'en' ? en : ar; }

function _spEditProposalChanges(order, proposal) {
  const lines = [];
  const invoice = proposal.invoice;
  const items = invoice?.items || proposal.items;
  if (items) {
    const group = rows => {
      const map = new Map();
      for (const item of rows || []) {
        const key = String(item.productId || item.code || item.name || '');
        const previous = map.get(key);
        map.set(key, { name: item.name || item.code || key,
          qty: Number(item.qty || 0) + (previous?.qty || 0), price: Number(item.price || 0) });
      }
      return map;
    };
    const before = group(order.items), after = group(items);
    for (const [key, item] of after) {
      const previous = before.get(key);
      if (!previous) lines.push(spEditText('إضافة صنف', 'Add item') + `: ${item.name} (${item.qty})`);
      else {
        if (item.qty !== previous.qty) lines.push(spEditText('كمية', 'Quantity') + ` ${item.name}: ${previous.qty} → ${item.qty}`);
        if (item.price !== previous.price) lines.push(spEditText('سعر', 'Price') + ` ${item.name}: ${fmtJ(previous.price)} → ${fmtJ(item.price)}`);
      }
    }
    for (const [key, item] of before) {
      if (!after.has(key)) lines.push(spEditText('حذف صنف', 'Remove item') + `: ${item.name} (${item.qty})`);
    }
  }
  const labels = {
    client: ['العميل', 'Customer'], phone: ['الهاتف', 'Phone'], ref: ['رقم الطلب', 'Order reference'],
    notes: ['الملاحظات', 'Notes'], shippingAddress: ['العنوان', 'Address'], shippingCity: ['المدينة', 'City'],
    shippingGov: ['المحافظة', 'Governorate'], shipCo: ['شركة الشحن', 'Carrier'], shipZone: ['منطقة الشحن', 'Shipping zone'],
    shipCost: ['الشحن', 'Shipping'], payment: ['طريقة الدفع', 'Payment method'],
    deposit: ['العربون', 'Deposit'], depMethod: ['خزنة العربون', 'Deposit account'],
    discount: ['الخصم', 'Discount'], manualDiscount: ['الخصم اليدوي', 'Manual discount'],
    codesDiscount: ['خصم الأكواد', 'Code discount'], discountCode: ['كود الخصم', 'Discount code'],
    total: ['الإجمالي', 'Total'], remaining: ['المتبقي', 'Remaining'], transactionDate: ['تاريخ الفاتورة', 'Invoice date'],
  };
  const money = new Set(['shipCost', 'deposit', 'discount', 'manualDiscount', 'codesDiscount', 'total', 'remaining']);
  const patch = invoice || proposal.discount || {};
  for (const [key, label] of Object.entries(labels)) {
    if (!(key in patch)) continue;
    const before = order[key] ?? (money.has(key) ? 0 : ''), after = patch[key] ?? '';
    if (money.has(key) ? Number(before) === Number(after) : String(before) === String(after)) continue;
    lines.push(spEditText(...label) + ': ' + (money.has(key) ? fmtJ(Number(before)) : String(before || '—'))
      + ' → ' + (money.has(key) ? fmtJ(Number(after)) : String(after || '—')));
  }
  if (!invoice && (items || proposal.discount)) {
    const itemsTotal = (items || order.items || []).reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0);
    const discount = Number(order.discount || 0) + Number(proposal.discount?.manualDiscount ?? order.manualDiscount ?? 0)
      + Number(proposal.discount?.codesDiscount ?? order.codesDiscount ?? 0);
    const total = Math.max(0, itemsTotal - Math.min(itemsTotal, discount) + Number(order.shipCost || 0));
    if (total !== Number(order.total || 0)) lines.push(spEditText('الإجمالي', 'Total') + `: ${fmtJ(order.total || 0)} → ${fmtJ(total)}`);
  }
  for (const correction of invoice?.depositVaultCorrections || []) {
    lines.push(spEditText('تصحيح خزنة الدفعة', 'Change payment account') + ` ${correction.id}: ${correction.method}`);
  }
  if (proposal.itemConflict) lines.push(proposal.itemConflict.source === 'shopify'
    ? spEditText('استخدام أصناف Shopify المتعارضة', 'Use the conflicting Shopify items')
    : spEditText('الاحتفاظ بأصناف النظام', 'Keep the system items'));
  return lines;
}

let _spProposalReviewActive = false;
async function _spConfirmEditSubmission(order, proposal) {
  if (isAdmin() || hasPerm('shopify-edit-direct')) return true;
  if (_spProposalReviewActive) return false;
  const changes = _spEditProposalChanges(order, proposal);
  if (!changes.length) { toast(spEditText('لا توجد تعديلات لإرسالها', 'No changes to send.')); return false; }
  _spProposalReviewActive = true;
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="sp-proposal-title" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:16px;max-width:560px;width:100%;max-height:85dvh;overflow:auto;padding:20px">
    <h3 id="sp-proposal-title">${esc(spEditText('مراجعة التعديلات قبل الإرسال', 'Review changes before sending'))} <bdi>#${esc(order.ref || '')}</bdi></h3>
    <ul style="padding-inline-start:22px;margin:16px 0;display:grid;gap:10px;overflow-wrap:anywhere">${changes.map(change => `<li>${esc(change)}</li>`).join('')}</ul>
    <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">${esc(spEditText('سيتم تطبيق التعديلات بعد موافقة الأدمن.', 'Changes will be applied after admin approval.'))}</p>
    <div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" class="btn btn-primary" data-send>${esc(spEditText('إرسال للأدمن للموافقة', 'Send to admin for approval'))}</button><button type="button" class="btn btn-outline" data-back>${esc(spEditText('رجوع للتعديل', 'Back to editing'))}</button></div>
    </section>`;
  return new Promise(resolve => {
    let done = false;
    const finish = approved => {
      if (done) return;
      done = true; _spProposalReviewActive = false;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove(); previousFocus?.focus(); resolve(approved);
    };
    const send = overlay.querySelector('[data-send]'), back = overlay.querySelector('[data-back]');
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
      if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === send ? back : send).focus(); }
    };
    send.addEventListener('click', () => finish(true));
    back.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay); send.focus();
  });
}

function _spOrderEditMark(order) {
  const request = order.editRequest;
  if (!request) return '';
  const pending = request.status === 'معلق';
  const label = pending ? spEditText('تعديل ينتظر الموافقة', 'Edit awaiting approval')
    : request.status === 'معتمد' ? spEditText('تم قبول التعديل', 'Edit approved') : spEditText('تم رفض التعديل', 'Edit rejected');
  return `<button type="button" class="btn btn-outline btn-sm" style="padding:2px 6px;min-height:24px;font-size:.7rem" title="${esc(label)}" aria-label="${esc(label)}" onclick="event.stopPropagation();openShopifyEditReview('${esc(order._id)}')">${pending ? '⏳' : request.status === 'معتمد' ? '✓' : '✕'}</button>`;
}

function _spEditRequestDetail(order) {
  const r = order.editRequest;
  return `<p>${esc(spEditText('مقدم الطلب', 'Requested by'))}: ${esc(r.requestedBy)} · ${fmtDateTime(r.requestedAt)}</p>
    <ul>${(r.changes || []).map(change => `<li>${esc(change)}</li>`).join('')}</ul>
    ${r.status === 'معلق' ? `<p>${esc(spEditText('التغييرات لم تُطبّق بعد على الأوردر.', 'These changes have not been applied to the order.'))}</p>` : ''}
    ${r.reviewedBy ? `<p>${esc(r.status)} · ${esc(r.reviewedBy)} · ${fmtDateTime(r.reviewedAt)}</p>` : ''}
    ${r.rejectedReason ? `<p>${esc(spEditText('سبب الرفض', 'Rejection reason'))}: ${esc(r.rejectedReason)}</p>` : ''}`;
}

function _spEditReviewActions(order) {
  if (!isAdmin() || order.editRequest?.status !== 'معلق') return '';
  return `<div class="appr-actions">
    <button type="button" class="btn btn-primary btn-sm" onclick="decideShopifyEdit('${esc(order._id)}',true)">✓ ${esc(spEditText('قبول التعديل', 'Approve edit'))}</button>
    <button type="button" class="btn btn-outline btn-sm" onclick="decideShopifyEdit('${esc(order._id)}',false)">✕ ${esc(spEditText('رفض', 'Reject'))}</button></div>`;
}

function openShopifyEditReview(id, requestId = '') {
  let order = (_shopifyOrders || []).find(o => o._id === id);
  if (requestId && order?.editRequest?.id !== requestId) {
    const archived = (order?.editRequestHistory || []).find(r => r.id === requestId);
    if (!archived) return;
    order = { ...order, editRequest: archived };
  }
  if (!order?.editRequest) return;
  openModal(`<h3>${esc(spEditText('مراجعة تعديل الأوردر', 'Review order edit'))} #${esc(order.ref)}</h3>
    ${_spEditRequestDetail(order)}${isAdmin() && order.editRequest.status === 'معلق' ? `<label for="sp-edit-rejection-reason">${esc(spEditText('سبب الرفض (اختياري)', 'Rejection reason (optional)'))}</label><textarea id="sp-edit-rejection-reason" rows="2" maxlength="500" style="width:100%;margin:8px 0 16px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit"></textarea>` : ''}${_spEditReviewActions(order)}`);
  qs('#modal-overlay').classList.add('shopify-edit-review');
  qs('#sp-edit-rejection-reason')?.setAttribute('data-order-id', id);
}

const _spEditDecisionsBusy = new Set();
async function decideShopifyEdit(id, approve) {
  if (!isAdmin() || _spEditDecisionsBusy.has(id)) return;
  const order = (_shopifyOrders || []).find(o => o._id === id);
  if (!order?.editRequest || order.editRequest.status !== 'معلق') return;
  let reason = '';
  if (!approve) {
    const reasonField = qs('#sp-edit-rejection-reason');
    if (!reasonField || reasonField.dataset.orderId !== id || !qs('#modal-overlay')?.classList.contains('active')) {
      openShopifyEditReview(id); qs('#sp-edit-rejection-reason')?.focus(); return;
    }
    reason = reasonField.value.trim();
  }
  _spEditDecisionsBusy.add(id);
  try {
    qs('#soulia-modal-overlay')?.classList.add('shopify-edit-decision');
    const decision = showConfirm(spEditText(approve ? 'قبول التعديلات المعروضة وتطبيقها على الطلب؟' : 'رفض التعديلات مع إبقاء الطلب كما هو؟',
      approve ? 'Approve the displayed changes and apply them to the order?' : 'Reject these changes and keep the order unchanged?'), {
      title: esc(spEditText(approve ? 'قبول تعديل الطلب' : 'رفض تعديل الطلب', approve ? 'Approve order edit' : 'Reject order edit')) + ' #' + esc(order.ref),
      icon: approve ? 'success' : 'warn', danger: !approve,
      rows: (order.editRequest.changes || []).map(change => [change, '']),
      confirmLabel: spEditText(approve ? 'قبول التعديل' : 'رفض التعديل', approve ? 'Approve edit' : 'Reject edit'),
      cancelLabel: spEditText('رجوع للمراجعة', 'Back to review'),
    });
    qs('#soulia-modal-confirm')?.focus?.();
    const accepted = await decision;
    if (!accepted) return;
    await api(`/shopify/orders/${id}/edit-request/${order.editRequest.id}/${approve ? 'approve' : 'reject'}`, {
      method: 'PATCH', body: JSON.stringify({ reason }),
    });
    closeModal();
    await loadShopifyOrders();
    if (currentPage === 'approvals') renderApprovals();
    toast(spEditText(approve ? 'تم قبول التعديل وإشعار الموظف' : 'تم رفض التعديل وإشعار الموظف', approve ? 'Edit approved; employee notified.' : 'Edit rejected; employee notified.'));
  } catch (e) { toast(e.message, true); }
  finally { qs('#soulia-modal-overlay')?.classList.remove('shopify-edit-decision'); _spEditDecisionsBusy.delete(id); }
}

document.addEventListener('keydown', event => {
  const decisionOverlay = qs('#soulia-modal-overlay');
  if (decisionOverlay?.classList.contains('active') && decisionOverlay.classList.contains('shopify-edit-decision')) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); qs('#soulia-modal-cancel')?.click();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const confirm = qs('#soulia-modal-confirm'), cancel = qs('#soulia-modal-cancel');
      (document.activeElement === confirm ? cancel : confirm)?.focus();
    }
    return;
  }
  if (event.key !== 'Escape' || !qs('#hv-otp-modal')?.classList.contains('active') || qs('#soulia-modal-overlay')?.classList.contains('active')) return;
  event.preventDefault(); event.stopImmediatePropagation(); closeHighValueOtpModal();
}, true);

function _apprRowShopifyEdit(order) {
  const r = order.editRequest, pending = r.status === 'معلق';
  return { key: 'shopify-edit:' + order._id, kindLabel: spEditText('تعديل أوردر شوبيفاي', 'Shopify order edit'),
    isPending: pending, amount: r.patch.total ?? order.total,
    title: `#${esc(order.ref)}`, subtitle: esc(order.client || ''), party: r.requestedBy,
    dateLabel: fmtDate(r.requestedAt), statusLabel: r.status, statusClass: _APPR_STATUS_CLASS[r.status] || 'st-pending',
    actions: _spEditReviewActions(order), detail: _spEditRequestDetail(order),
    haystack: [order.ref, order.client, r.requestedBy, ...(r.changes || [])].join(' ').toLowerCase() };
}

const spEditKindFilter = document.querySelector('#appr-kind-filter');
if (spEditKindFilter && !spEditKindFilter.querySelector('[value="shopify-edit"]')) {
  const option = new Option(t('apprKindShopifyEdit'), 'shopify-edit');
  option.setAttribute('data-i18n', 'apprKindShopifyEdit');
  spEditKindFilter.add(option);
}

async function _requestShopifyInvoiceDiscountOtp() {
  await resendHighValueOtp();
  if (_hvOtpCtx.otpId) qs('#hv-otp-modal').classList.add('active');
}

async function _submitShopifyInvoiceEdit(id, body) {
  try {
    const original = transactions.find(tx => tx._id === id);
    if (!original || !(await _spConfirmEditSubmission(original, { invoice: body }))) return;
    const res = await api(`/shopify/transactions/${id}/edit`, { method: 'PATCH', body: JSON.stringify(body) });
    releaseEditMovementLock(id);
    closeModal();
    await loadShopifyOrders();
    transactions = await api('/transactions');
    try { inventoryCache = await api('/transactions/inventory'); } catch (_) {}
    if (currentPage === 'invoice-view') renderInvoiceViewPage();
    if (currentPage === 'movements') renderMovements();
    syncVaultState();
    toast(res.pendingApproval ? spEditText('تم إرسال التعديل لموافقة المدير', 'Changes sent for admin approval.') : spEditText('تم حفظ التعديل', 'Changes saved.'));
  } catch (e) { toast(e.message, true); }
}
