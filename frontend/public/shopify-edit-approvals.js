/* Staff order edits remain proposals until an administrator reviews them. */
function spEditText(ar, en) { return currentLang === 'en' ? en : ar; }

// Money used in text must never come from fmtJ, which returns HTML markup.
function _spEditMoneyText(value) {
  return 'EGP ' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0);
}
function _spEditPendingLabel() {
  return isAdmin() ? spEditText('طلب تعديل يحتاج موافقة', 'Edit request needs approval')
    : spEditText('في انتظار الموافقة على التعديل', 'Awaiting edit approval');
}
function _spEditGroupItems(items) {
  const grouped = new Map();
  for (const item of items || []) {
    const key = String(item.productId || item.code || item.sku || item.name || '');
    const previous = grouped.get(key);
    const qty = Number(item.qty) || 0;
    const amount = qty * (Number(item.price) || 0) + (previous?.amount || 0);
    const count = qty + (previous?.qty || 0);
    grouped.set(key, { ...previous, ...item, name: item.name || item.code || key, qty: count, amount, price: count ? amount / count : 0 });
  }
  return grouped;
}
function _spEditProposalPatch(order, proposal) {
  if (proposal.invoice) return proposal.invoice;
  const patch = { ...(proposal.discount || {}), ...(proposal.items ? { items: proposal.items } : {}) };
  if (proposal.items || proposal.discount) {
    const itemsTotal = (proposal.items || order.items || []).reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0);
    const discount = Number(order.discount || 0) + Number(patch.manualDiscount ?? order.manualDiscount ?? 0)
      + Number(patch.codesDiscount ?? order.codesDiscount ?? 0);
    patch.total = Math.max(0, itemsTotal - Math.min(itemsTotal, discount) + Number(order.shipCost || 0));
  }
  return patch;
}
function _spEditComparisonHtml(before = {}, patch = {}, fallback = []) {
  const e = value => esc(String(value ?? ''));
  const beforeLabel = spEditText('قبل التعديل', 'Before');
  const afterLabel = spEditText('بعد التعديل', 'After');
  const row = (label, oldValue, newValue, extra = '') => `<div class="edit-change-row ${extra}"><span class="edit-change-label">${e(label)}</span><div class="edit-change-values"><span class="edit-change-before"><small>${e(beforeLabel)}</small><bdi>${e(oldValue)}</bdi></span><span class="edit-change-arrow" aria-hidden="true">←</span><span class="edit-change-after"><small>${e(afterLabel)}</small><bdi>${e(newValue)}</bdi></span></div></div>`;
  const productRows = [];
  if (Array.isArray(patch.items)) {
    const imageIndex = typeof _spBuildInvIndex === 'function' ? _spBuildInvIndex() : null;
    const oldItems = _spEditGroupItems(before.items), newItems = _spEditGroupItems(patch.items);
    for (const key of new Set([...oldItems.keys(), ...newItems.keys()])) {
      const oldItem = oldItems.get(key), newItem = newItems.get(key);
      if (oldItem && newItem && oldItem.qty === newItem.qty && oldItem.amount === newItem.amount && oldItem.name === newItem.name) continue;
      const kind = !oldItem ? 'added' : !newItem ? 'removed' : 'changed';
      const label = !oldItem ? spEditText('إضافة منتج', 'Product added') : !newItem ? spEditText('حذف منتج', 'Product removed')
        : newItem.qty > oldItem.qty ? spEditText('زيادة الكمية', 'Quantity increased')
        : newItem.qty < oldItem.qty ? spEditText('تقليل الكمية', 'Quantity decreased') : spEditText('تعديل منتج', 'Product changed');
      const changes = [];
      if (!oldItem || !newItem || oldItem.qty !== newItem.qty) changes.push(row(spEditText('الكمية', 'Quantity'), oldItem?.qty || 0, newItem?.qty || 0));
      if (oldItem && newItem && oldItem.price !== newItem.price) changes.push(row(spEditText('سعر الوحدة', 'Unit price'), _spEditMoneyText(oldItem.price), _spEditMoneyText(newItem.price)));
      if (oldItem && newItem && oldItem.name !== newItem.name) changes.push(row(spEditText('اسم الصنف', 'Item name'), oldItem.name, newItem.name));
      const item = newItem || oldItem;
      const imageItem = { ...oldItem, ...item, imageUrl: item.imageUrl || oldItem?.imageUrl, image: item.image || oldItem?.image };
      const inventoryItem = imageIndex && typeof _spLookupInvItem === 'function' ? _spLookupInvItem(imageItem, imageIndex) : null;
      const thumbnail = typeof _spThumbHtml === 'function' ? _spThumbHtml(imageItem, inventoryItem, 'edit-product-thumb')
        : `<span class="edit-product-thumb" aria-hidden="true">${e(item.name.slice(0, 1))}</span>`;
      const context = !oldItem || !newItem ? `<p class="edit-product-context">${e(spEditText('سعر الوحدة', 'Unit price'))}: <bdi>${e(_spEditMoneyText(item.price))}</bdi> · ${e(spEditText('إجمالي الصنف', 'Item total'))}: <bdi>${e(_spEditMoneyText(item.amount))}</bdi></p>` : '';
      productRows.push(`<article class="edit-diff-product is-${kind}"><header><div class="edit-product-heading">${thumbnail}<b dir="auto">${e(item.name)}</b></div><span>${e(label)}</span></header>${changes.join('')}${context}</article>`);
    }
  }
  const labels = {
    client: ['العميل', 'Customer'], phone: ['الهاتف', 'Phone'], ref: ['رقم الطلب', 'Order reference'],
    notes: ['الملاحظات', 'Notes'], shippingAddress: ['العنوان', 'Address'], shippingCity: ['المدينة', 'City'],
    shippingGov: ['المحافظة', 'Governorate'], shipCo: ['شركة الشحن', 'Carrier'], shipZone: ['منطقة الشحن', 'Shipping zone'],
    payment: ['طريقة الدفع', 'Payment method'], depMethod: ['خزنة العربون', 'Deposit account'],
    transactionDate: ['تاريخ الفاتورة', 'Invoice date'], discountCode: ['كود الخصم', 'Discount code'],
    shipCost: ['الشحن', 'Shipping'], discount: ['الخصم', 'Discount'], manualDiscount: ['الخصم اليدوي', 'Manual discount'],
    codesDiscount: ['خصم الأكواد', 'Code discount'], deposit: ['العربون', 'Deposit'],
    total: ['الإجمالي', 'Total'], remaining: ['المتبقي', 'Remaining'],
  };
  const money = new Set(['shipCost', 'discount', 'manualDiscount', 'codesDiscount', 'deposit', 'total', 'remaining']);
  const fields = [];
  for (const [key, label] of Object.entries(labels)) {
    if (!(key in patch)) continue;
    const oldValue = before[key] ?? (money.has(key) ? 0 : '');
    const newValue = patch[key] ?? '';
    if (money.has(key) ? Number(oldValue) === Number(newValue) : String(oldValue) === String(newValue)) continue;
    const value = v => money.has(key) ? _spEditMoneyText(v) : String(v || '—');
    if (key === 'total') continue;
    const isDiscount = ['discount', 'manualDiscount', 'codesDiscount'].includes(key);
    const delta = Number(newValue) - Number(oldValue);
    const discountNote = isDiscount ? `<p class="edit-discount-note"><span class="edit-discount-icon" aria-hidden="true">%</span>${e(spEditText(delta > 0 ? (Number(oldValue) === 0 ? 'خصم مضاف' : 'زيادة الخصم بمقدار') : 'تقليل الخصم بمقدار', delta > 0 ? (Number(oldValue) === 0 ? 'Discount added' : 'Discount increased by') : 'Discount decreased by'))} <bdi>${e(_spEditMoneyText(Math.abs(delta)))}</bdi></p>` : '';
    fields.push(isDiscount ? `<div class="edit-discount-change">${row(spEditText(...label), value(oldValue), value(newValue))}${discountNote}</div>` : row(spEditText(...label), value(oldValue), value(newValue)));
  }
  const totalChanged = 'total' in patch && Number(before.total || 0) !== Number(patch.total || 0);
  const difference = Number(patch.total || 0) - Number(before.total || 0);
  const totalSummary = totalChanged ? `<section class="edit-total-summary">${row(spEditText('إجمالي الطلب', 'Order total'), _spEditMoneyText(before.total), _spEditMoneyText(patch.total))}<p>${e(spEditText(difference < 0 ? 'انخفض الإجمالي بمقدار' : 'زاد الإجمالي بمقدار', difference < 0 ? 'Total decreased by' : 'Total increased by'))} <bdi>${e(_spEditMoneyText(Math.abs(difference)))}</bdi></p></section>` : '';
  const corrections = (patch.depositVaultCorrections || []).map(c => `<p>${e(spEditText('تصحيح خزنة الدفعة', 'Change payment account'))}: <bdi>${e(c.id)}</bdi> · ${e(c.method)}</p>`).join('');
  const legacy = !productRows.length && !fields.length && !totalSummary && !corrections ? _spEditLegacyComparisonHtml(fallback) : '';
  return `<div class="edit-diff">${productRows.length ? `<section class="edit-diff-products" aria-label="${e(spEditText('تعديلات المنتجات', 'Product changes'))}">${productRows.join('')}</section>` : ''}
    ${fields.length ? `<section class="edit-diff-fields" aria-label="${e(spEditText('تفاصيل التعديل', 'Changed details'))}">${fields.join('')}</section>` : ''}${totalSummary}${corrections}${legacy}</div>`;
}
function _spEditLegacyComparisonHtml(changes) {
  return `<div class="edit-diff-fields">${changes.map(change => {
    const text = String(change.text || change).replace(/<[^>]*>/g, '');
    const pair = text.match(/^(.+?):\s*(.*?)\s*[←→]\s*(.*)$/);
    return pair ? `<div class="edit-diff-field"><b>${esc(pair[1])}</b><div><small>${esc(spEditText('قبل التعديل', 'Before'))}</small><bdi>${esc(pair[2])}</bdi></div><div><small>${esc(spEditText('بعد التعديل', 'After'))}</small><bdi>${esc(pair[3])}</bdi></div></div>`
      : `<div class="edit-diff-field edit-diff-note">${esc(text)}</div>`;
  }).join('')}</div>`;
}

function _spEditProposalChanges(order, proposal) {
  const lines = [];
  const invoice = proposal.invoice;
  const items = invoice?.items || proposal.items;
  if (items) {
    const group = _spEditGroupItems;
    const before = group(order.items), after = group(items);
    for (const [key, item] of after) {
      const previous = before.get(key);
      if (!previous) lines.push(spEditText('إضافة صنف', 'Add item') + `: ${item.name} (${item.qty})`);
      else {
        if (item.qty !== previous.qty) lines.push(spEditText('كمية', 'Quantity') + ` ${item.name}: ${previous.qty} → ${item.qty}`);
        if (item.price !== previous.price) lines.push(spEditText('سعر', 'Price') + ` ${item.name}: ${_spEditMoneyText(previous.price)} → ${_spEditMoneyText(item.price)}`);
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
    lines.push(spEditText(...label) + ': ' + (money.has(key) ? _spEditMoneyText(Number(before)) : String(before || '—'))
      + ' → ' + (money.has(key) ? _spEditMoneyText(Number(after)) : String(after || '—')));
  }
  if (!invoice && (items || proposal.discount)) {
    const itemsTotal = (items || order.items || []).reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0);
    const discount = Number(order.discount || 0) + Number(proposal.discount?.manualDiscount ?? order.manualDiscount ?? 0)
      + Number(proposal.discount?.codesDiscount ?? order.codesDiscount ?? 0);
    const total = Math.max(0, itemsTotal - Math.min(itemsTotal, discount) + Number(order.shipCost || 0));
    if (total !== Number(order.total || 0)) lines.push(spEditText('الإجمالي', 'Total') + `: ${_spEditMoneyText(order.total || 0)} → ${_spEditMoneyText(total)}`);
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
  overlay.innerHTML = `<section class="edit-proposal-dialog" role="dialog" aria-modal="true" aria-labelledby="sp-proposal-title">
    <h3 id="sp-proposal-title">${esc(spEditText('مراجعة التعديلات قبل الإرسال', 'Review changes before sending'))} <bdi>#${esc(order.ref || '')}</bdi></h3>
    ${_spEditComparisonHtml(order, _spEditProposalPatch(order, proposal), changes)}
    <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">${esc(spEditText('سيتم تطبيق التعديلات بعد موافقة الأدمن.', 'Changes will be applied after admin approval.'))}</p>
    <div class="edit-review-footer"><button type="button" class="btn btn-primary" data-send>${esc(spEditText('إرسال للأدمن للموافقة', 'Send to admin for approval'))}</button><button type="button" class="btn btn-outline" data-back>${esc(spEditText('رجوع للتعديل', 'Back to editing'))}</button></div>
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
  const pending = request.status === 'معلق' || request.status === 'قيد التنفيذ';
  const label = pending ? _spEditPendingLabel()
    : request.status === 'معتمد' ? spEditText('تم قبول التعديل', 'Edit approved') : spEditText('تم رفض التعديل', 'Edit rejected');
  if (request.status === 'معتمد') {
    return `<button type="button" class="sp-edit-status is-approved is-compact" title="${esc(label)}" aria-label="${esc(label)}" onclick="event.stopPropagation();openShopifyEditReview('${esc(order._id)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg></button>`;
  }
  return `<button type="button" class="sp-edit-status ${pending ? 'is-pending' : request.status === 'معتمد' ? 'is-approved' : 'is-rejected'}${isAdmin() ? ' is-admin' : ''}" title="${esc(label)}" aria-label="${esc(label)}" onclick="event.stopPropagation();openShopifyEditReview('${esc(order._id)}')"><span aria-hidden="true">${pending ? '◷' : request.status === 'معتمد' ? '✓' : '✕'}</span><span>${esc(label)}</span></button>`;
}

function _spEditRequestDetail(order) {
  const r = order.editRequest;
  const state = r.status === 'معلق' || r.status === 'قيد التنفيذ' ? 'pending' : r.status === 'معتمد' ? 'approved' : 'rejected';
  return `<div class="edit-request-meta"><span class="sp-edit-status is-${state}${isAdmin() ? ' is-admin' : ''}">${esc(state === 'pending' ? _spEditPendingLabel() : _apprStatusLabel(r.status))}</span><span>${esc(spEditText('مقدم الطلب', 'Requested by'))}: <b>${esc(r.requestedBy || '—')}</b></span><time>${esc(fmtDateTime(r.requestedAt))}</time></div>
    ${_spEditComparisonHtml(r.before && r.patch ? r.before : {}, r.before && r.patch ? r.patch : {}, r.changes || [])}
    <p class="edit-review-explanation">${esc(state === 'approved' ? spEditText('تم تطبيق التعديلات الموضحة أعلاه.', 'The changes above have been applied.') : state === 'rejected' ? spEditText('تم رفض هذه التعديلات ولم تُطبّق.', 'These changes were rejected and were not applied.') : spEditText('التعديلات بانتظار الموافقة ولم تُطبّق بعد.', 'These changes are awaiting approval and have not been applied.'))}</p>
    ${r.reviewedBy ? `<p class="edit-review-audit">${esc(spEditText(state === 'approved' ? 'اعتمدها' : 'راجعها', state === 'approved' ? 'Approved by' : 'Reviewed by'))} <b>${esc(r.reviewedBy)}</b> · ${esc(fmtDateTime(r.reviewedAt))}</p>` : ''}
    ${r.rejectedReason ? `<p>${esc(spEditText('سبب الرفض', 'Rejection reason'))}: ${esc(r.rejectedReason)}</p>` : ''}`;
}

function _spInvoiceEditMark(tx) {
  if (!tx?.shopifyOrderId) return '';
  const order = (_shopifyOrders || []).find(o => o.editRequest?.transactionId === tx._id
    || String(o.shopifyId || '') === String(tx.shopifyOrderId));
  return order ? _spOrderEditMark(order) : '';
}

function _spEditReviewActions(order) {
  if (!isAdmin() || order.editRequest?.status !== 'معلق') return '';
  return `<div class="appr-actions">
    <button type="button" class="btn btn-primary btn-sm" onclick="decideShopifyEdit('${esc(order._id)}',true)">✓ ${esc(spEditText('قبول التعديل', 'Approve edit'))}</button>
    <button type="button" class="btn btn-outline btn-sm" onclick="decideShopifyEdit('${esc(order._id)}',false)">✕ ${esc(spEditText('رفض التعديل', 'Reject edit'))}</button></div>`;
}

function openShopifyEditReview(id, requestId = '') {
  if (typeof _canAccessPage === 'function' && !_canAccessPage('shopify-orders') && !_canAccessPage('invoice-view')) {
    _requirePageAccess('shopify-orders'); return;
  }
  let order = (_shopifyOrders || []).find(o => o._id === id);
  if (requestId && order?.editRequest?.id !== requestId) {
    const archived = (order?.editRequestHistory || []).find(r => r.id === requestId);
    if (!archived) return;
    order = { ...order, editRequest: archived };
  }
  if (!order?.editRequest) return;
  openModal(`<h3>${esc(spEditText('تفاصيل تعديل الفاتورة', 'Invoice edit details'))} <bdi>#${esc(order.ref)}</bdi></h3>
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
    isPending: pending, amount: r.patch?.total ?? order.total,
    title: `#${esc(order.ref)}`, subtitle: esc(order.client || ''), party: r.requestedBy,
    dateLabel: fmtDate(r.requestedAt), statusLabel: pending ? _spEditPendingLabel() : _apprStatusLabel(r.status), statusClass: _APPR_STATUS_CLASS[r.status] || 'st-pending',
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
    toast(res.pendingApproval ? _spEditPendingLabel() : spEditText('تم حفظ التعديل', 'Changes saved.'));
  } catch (e) { toast(e.message, true); }
}
