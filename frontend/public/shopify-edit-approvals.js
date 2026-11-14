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
/* ← بالعربي و→ بالإنجليزي: «→» وسط نص عربي يُعرض معكوساً. */
function _spEditArrow() { return typeof currentLang !== 'undefined' && currentLang === 'en' ? '→' : '←'; }
/* كل قيمة معزولة (FSI…PDI) حتى لا يسحب اسم لاتيني قبلها السهمَ إلى اتجاه إنجليزي. */
function _spEditPair(a, b) { return `⁨${a}⁩ ${_spEditArrow()} ⁨${b}⁩`; }
function _spEditComparisonHtml(before = {}, patch = {}, fallback = []) {
  const e = value => esc(String(value ?? ''));
  const beforeLabel = spEditText('قبل التعديل', 'Before');
  const afterLabel = spEditText('بعد التعديل', 'After');
  const row = (label, oldValue, newValue, extra = '') => `<div class="edit-change-row ${extra}"><span class="edit-change-label">${e(label)}</span><div class="edit-change-values"><span class="edit-change-before"><small>${e(beforeLabel)}</small><bdi>${e(oldValue)}</bdi></span><span class="edit-change-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg></span><span class="edit-change-after"><small>${e(afterLabel)}</small><bdi>${e(newValue)}</bdi></span></div></div>`;
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
      const thumbnail = _spEditThumb(imageItem, imageIndex, 'edit-product-thumb');
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
/* Product photo for an edit line: the Shopify page's thumb when that page is loaded, else the line
   snapshot / live catalogue (_pwItemImgUrl), else initials. A broken image removes itself. */
function _spEditThumb(item, imageIndex, cls) {
  const inventoryItem = imageIndex && typeof _spLookupInvItem === 'function' ? _spLookupInvItem(item, imageIndex) : null;
  if (typeof _spThumbHtml === 'function') return _spThumbHtml(item, inventoryItem, cls);
  const name = String(item?.name || item?.code || '?');
  const url = (typeof _pwItemImgUrl === 'function' ? _pwItemImgUrl(item) : '') || item?.imageUrl || '';
  const safe = /^https?:\/\//i.test(String(url)) ? url : '';
  return `<span class="${cls}" aria-hidden="true"><span class="sp-th-ini">${esc(name.trim().slice(0, 2))}</span>${safe ? `<img src="${escHtml(safe)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
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
        if (item.qty !== previous.qty) lines.push(spEditText('كمية', 'Quantity') + ` ${item.name}: ${_spEditPair(previous.qty, item.qty)}`);
        if (item.price !== previous.price) lines.push(spEditText('سعر', 'Price') + ` ${item.name}: ${_spEditPair(_spEditMoneyText(previous.price), _spEditMoneyText(item.price))}`);
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
    lines.push(spEditText(...label) + ': ' + _spEditPair(money.has(key) ? _spEditMoneyText(Number(before)) : String(before || '—'),
      money.has(key) ? _spEditMoneyText(Number(after)) : String(after || '—')));
  }
  if (!invoice && (items || proposal.discount)) {
    const itemsTotal = (items || order.items || []).reduce((sum, item) => sum + Number(item.qty) * Number(item.price), 0);
    const discount = Number(order.discount || 0) + Number(proposal.discount?.manualDiscount ?? order.manualDiscount ?? 0)
      + Number(proposal.discount?.codesDiscount ?? order.codesDiscount ?? 0);
    const total = Math.max(0, itemsTotal - Math.min(itemsTotal, discount) + Number(order.shipCost || 0));
    if (total !== Number(order.total || 0)) lines.push(spEditText('الإجمالي', 'Total') + `: ${_spEditPair(_spEditMoneyText(order.total || 0), _spEditMoneyText(total))}`);
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

function _spOrderEditMark(order, compact = false) {
  const request = order.editRequest;
  if (!request) return '';
  const pending = request.status === 'معلق' || request.status === 'قيد التنفيذ';
  const label = pending ? _spEditPendingLabel()
    : request.status === 'معتمد' ? spEditText('تم قبول التعديل', 'Edit approved') : spEditText('تم رفض التعديل', 'Edit rejected');
  if (compact === 'items') {
    const state = pending ? 'pending' : request.status === 'معتمد' ? 'approved' : 'rejected';
    const shortLabel = pending ? spEditText('طلب تعديل', 'Edit request')
      : state === 'approved' ? spEditText('تم التعديل', 'Edited') : spEditText('تعديل مرفوض', 'Rejected');
    return `<button type="button" class="sp-edit-status is-items is-${state}${isAdmin() ? ' is-admin' : ''}" title="${esc(label)}" aria-label="${esc(label)}" onclick="event.stopPropagation();openShopifyEditReview('${esc(order._id)}')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5M4 20l4.5-1 12-12a2.12 2.12 0 0 0-3-3l-12 12L4 20Z"/></svg><span>${esc(shortLabel)}</span></button>`;
  }
  if (request.status === 'معتمد') {
    return `<button type="button" class="sp-edit-status is-approved is-compact" title="${esc(label)}" aria-label="${esc(label)}" onclick="event.stopPropagation();openShopifyEditReview('${esc(order._id)}')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg></button>`;
  }
  return `<button type="button" class="sp-edit-status ${pending ? 'is-pending' : request.status === 'معتمد' ? 'is-approved' : 'is-rejected'}${isAdmin() ? ' is-admin' : ''}${compact ? ' is-compact' : ''}" title="${esc(label)}" aria-label="${esc(label)}" onclick="event.stopPropagation();openShopifyEditReview('${esc(order._id)}')"><span aria-hidden="true">${pending ? '◷' : request.status === 'معتمد' ? '✓' : '✕'}</span>${compact ? '' : `<span>${esc(label)}</span>`}</button>`;
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

/* ── Edit history: every edit on the order, newest first ──────────────────────────────────────────
   Requests (approved / rejected / direct) come from editRequestHistory + the current editRequest;
   other edits (items, discount, item-conflict review) from editHistory. An editHistory row that
   only mirrors a request (same time) is skipped, so nothing is listed twice. The list endpoint
   leaves both histories out, so they are read from GET /shopify/orders/detail/:id. */
const _SP_EH_REQUEST_ACTIONS = new Set(['تعديل أوردر', 'اعتماد تعديل أوردر', 'اعتماد تعديل الفاتورة']);
const _SP_EH_ACTION_EN = { 'تعديل الأصناف': 'Items edited', 'تعديل الخصم': 'Discount edited', 'مراجعة تعارض الأصناف': 'Item conflict reviewed' };
function _spEditHistoryEntries(order) {
  const requests = new Map();
  for (const r of [...(order.editRequestHistory || []), ...(order.editRequest ? [order.editRequest] : [])]) {
    if (r) requests.set(r.id || `${r.requestedAt}|${r.status}`, r);
  }
  const requestTimes = new Set();
  const entries = [...requests.values()].map(r => {
    if (r.requestedAt) requestTimes.add(r.requestedAt);
    if (r.reviewedAt) requestTimes.add(r.reviewedAt);
    const pending = r.status === 'معلق' || r.status === 'قيد التنفيذ';
    const direct = !pending && r.status === 'معتمد' && r.reviewedBy && r.reviewedBy === r.requestedBy && r.reviewedAt === r.requestedAt;
    return { request: r, at: r.requestedAt || r.reviewedAt || '', by: r.requestedBy || '',
      state: pending ? 'pending' : r.status === 'معتمد' ? 'approved' : 'rejected', direct,
      before: r.before || {}, after: r.patch || {}, changes: r.changes || [] };
  });
  for (const h of order.editHistory || []) {
    if (_SP_EH_REQUEST_ACTIONS.has(h.action) && requestTimes.has(h.editedAt)) continue;
    entries.push({ at: h.editedAt || '', by: h.editedBy || '', state: 'approved', direct: true, action: h.action,
      approvedBy: h.approvedBy, before: h.before || {}, after: h.after || {}, changes: h.changes || [] });
  }
  return entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
function _spEhTitle(entry) {
  if (entry.action) return currentLang === 'en' ? (_SP_EH_ACTION_EN[entry.action] || 'Order edited') : entry.action;
  if (entry.state === 'pending') return _spEditPendingLabel();
  if (entry.state === 'rejected') return spEditText('تعديل مرفوض', 'Edit rejected');
  return entry.direct ? spEditText('تعديل مباشر', 'Direct edit') : spEditText('تعديل معتمد', 'Approved edit');
}
/* The products an edit touched, for the summary line's photos. */
function _spEhTouchedItems(before, after) {
  if (!Array.isArray(after.items)) return [];
  const oldItems = _spEditGroupItems(before.items), newItems = _spEditGroupItems(after.items), out = [];
  for (const key of new Set([...oldItems.keys(), ...newItems.keys()])) {
    const o = oldItems.get(key), n = newItems.get(key);
    if (o && n && o.qty === n.qty && o.amount === n.amount && o.name === n.name) continue;
    out.push({ ...o, ...n });
  }
  return out;
}
function _spEhEntryHtml(entry, index, open) {
  const imageIndex = typeof _spBuildInvIndex === 'function' ? _spBuildInvIndex() : null;
  const touched = _spEhTouchedItems(entry.before, entry.after);
  const thumbs = touched.slice(0, 3).map(i => _spEditThumb(i, imageIndex, 'sp-eh-thumb')).join('')
    + (touched.length > 3 ? `<span class="sp-eh-more">+${touched.length - 3}</span>` : '');
  const totalMoved = 'total' in entry.after && Number(entry.before.total || 0) !== Number(entry.after.total || 0);
  const total = totalMoved ? `<span class="sp-eh-total"><bdi>${esc(_spEditMoneyText(entry.before.total))}</bdi><span aria-hidden="true">${_spEditArrow()}</span><b><bdi>${esc(_spEditMoneyText(entry.after.total))}</bdi></b></span>` : '';
  const r = entry.request;
  const audit = [
    r?.reviewedBy && !entry.direct ? `${esc(spEditText(entry.state === 'approved' ? 'اعتمدها' : 'رفضها', entry.state === 'approved' ? 'Approved by' : 'Rejected by'))} <b>${esc(r.reviewedBy)}</b> · ${esc(fmtDateTime(r.reviewedAt))}` : '',
    entry.approvedBy && entry.approvedBy !== entry.by ? `${esc(spEditText('اعتمدها', 'Approved by'))} <b>${esc(entry.approvedBy)}</b>` : '',
  ].filter(Boolean).join('<br>');
  const reason = r?.rejectedReason ? `<p class="sp-eh-reason">${esc(spEditText('سبب الرفض', 'Rejection reason'))}: <span dir="auto">${esc(r.rejectedReason)}</span></p>` : '';
  return `<details class="sp-eh-entry is-${entry.state}"${open ? ' open' : ''}>
    <summary><span class="sp-eh-dot" aria-hidden="true"></span>
      <span class="sp-eh-head"><span class="sp-eh-titleline"><b>${esc(_spEhTitle(entry))}</b><span class="sp-eh-no">#${index}</span></span>
        <small><bdi>${esc(entry.by || '—')}</bdi> · ${esc(fmtDateTime(entry.at))}</small>${total}</span>
      ${thumbs ? `<span class="sp-eh-thumbs">${thumbs}</span>` : ''}
      <svg class="sp-eh-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
    <div class="sp-eh-body">${_spEditComparisonHtml(entry.before, entry.after, entry.changes)}${reason}${audit ? `<p class="edit-review-audit">${audit}</p>` : ''}</div>
  </details>`;
}
function _spEhListHtml(order, focusRequestId) {
  const entries = _spEditHistoryEntries(order).filter(e => e.state !== 'pending');
  if (!entries.length) return `<p class="sp-eh-empty">${esc(spEditText('لا توجد تعديلات سابقة على هذا الطلب.', 'No earlier edits on this order.'))}</p>`;
  const focusIdx = focusRequestId ? entries.findIndex(e => e.request?.id === focusRequestId) : -1;
  return entries.map((e, i) => _spEhEntryHtml(e, entries.length - i, focusIdx >= 0 ? i === focusIdx : i === 0)).join('');
}
function _spEhSummaryHtml(order) {
  const all = _spEditHistoryEntries(order).filter(e => e.state !== 'pending');
  if (!all.length) return '';
  const rejected = all.filter(e => e.state === 'rejected').length;
  const firstWithTotal = [...all].reverse().find(e => 'total' in (e.before || {}));
  const chips = [`<span><b>${all.length - rejected}</b> ${esc(spEditText('تعديل مطبّق', 'applied'))}</span>`];
  if (rejected) chips.push(`<span class="is-rej"><b>${rejected}</b> ${esc(spEditText('مرفوض', 'rejected'))}</span>`);
  if (firstWithTotal && Number(firstWithTotal.before.total || 0) !== Number(order.total || 0)) {
    chips.push(`<span>${esc(spEditText('الإجمالي', 'Total'))} <bdi>${esc(_spEditMoneyText(firstWithTotal.before.total))}</bdi> ${_spEditArrow()} <b><bdi>${esc(_spEditMoneyText(order.total))}</bdi></b></span>`);
  }
  return `<div class="sp-eh-summary">${chips.join('')}</div>`;
}

/* ── «What changed since Shopify», short, with product photos — for the confirm-with-a-difference dialog.
   Baseline = the order as it stood before its FIRST applied edit (what Shopify sent); compared with the
   order now. Returns '' when there is nothing to show, so the caller falls back to the server's lines. */
const _spSignedIso = n => `⁦${n > 0 ? '+' : '−'}${_spEditMoneyText(Math.abs(n)).replace('EGP ', '')}⁩`;
/** One row per product whose line changed between two item lists: photo, name, what changed, signed amount. */
function _spDxItemRows(beforeItems, afterItems) {
  const imageIndex = typeof _spBuildInvIndex === 'function' ? _spBuildInvIndex() : null;
  const oldItems = _spEditGroupItems(beforeItems || []), newItems = _spEditGroupItems(afterItems || []);
  const rows = [];
  for (const key of new Set([...oldItems.keys(), ...newItems.keys()])) {
    const o = oldItems.get(key), n = newItems.get(key);
    if (o && n && o.qty === n.qty && Math.abs(o.amount - n.amount) < 0.01) continue;
    const item = { ...o, ...n };
    let what;
    if (!o) what = spEditText('أُضيف', 'Added') + ` · <bdi>${n.qty} × ${esc(_spEditMoneyText(n.price))}</bdi>`;
    else if (!n) what = spEditText('حُذف', 'Removed') + ` · <bdi>${o.qty} × ${esc(_spEditMoneyText(o.price))}</bdi>`;
    else {
      const parts = [];
      if (o.qty !== n.qty) parts.push(`${esc(spEditText('الكمية', 'Qty'))} <bdi>${_spEditPair(o.qty, n.qty)}</bdi>`);
      if (Math.abs(o.price - n.price) >= 0.01) parts.push(`${esc(spEditText('السعر', 'Price'))} <bdi>${esc(_spEditPair(_spEditMoneyText(o.price), _spEditMoneyText(n.price)))}</bdi>`);
      what = parts.join(' · ');
    }
    const delta = (n?.amount || 0) - (o?.amount || 0);
    rows.push(`<li class="sp-dx-row is-${!o ? 'add' : !n ? 'rem' : 'chg'}">${_spEditThumb(item, imageIndex, 'sp-dx-thumb')}<span class="sp-dx-txt"><b><bdi>${esc(item.name || item.code || '')}</bdi></b><small>${what}</small></span><span class="sp-dx-amt">${_spSignedIso(delta)}</span></li>`);
  }
  return rows;
}
function _spDivergenceExplainHtml(order) {
  const applied = _spEditHistoryEntries(order).filter(e => e.state === 'approved' && Array.isArray(e.before?.items));
  const first = applied[applied.length - 1];
  if (!first) return '';
  const before = first.before;
  const rows = _spDxItemRows(before.items, order.items);
  const money = [['manualDiscount', 'الخصم اليدوي', 'Manual discount', -1], ['codesDiscount', 'خصم الأكواد', 'Code discount', -1], ['shipCost', 'الشحن', 'Shipping', 1]];
  for (const [k, ar, en, sign] of money) {
    const a = Number(before[k] || 0), b = Number(order[k] || 0);
    if (Math.abs(a - b) < 0.01) continue;
    rows.push(`<li class="sp-dx-row is-money"><span class="sp-dx-ico" aria-hidden="true">${k === 'shipCost' ? '⛟' : '%'}</span><span class="sp-dx-txt"><b>${esc(spEditText(ar, en))}</b><small><bdi>${esc(_spEditPair(_spEditMoneyText(a), _spEditMoneyText(b)))}</bdi></small></span><span class="sp-dx-amt">${_spSignedIso(sign * (b - a))}</span></li>`);
  }
  if (!rows.length) return '';
  const shown = rows.slice(0, 6), more = rows.length - shown.length;
  return `<div class="sp-dx"><p class="sp-dx-head">${esc(spEditText('التغييرات منذ استلام الطلب من Shopify:', 'What changed from the Shopify order:'))}</p><ul>${shown.join('')}</ul>${more > 0 ? `<p class="sp-dx-more">${esc(spEditText(`و${more} تغيير آخر — التفاصيل في سجل التعديلات`, `and ${more} more — see the edit history`))}</p>` : ''}</div>`;
}
/** The same notice for editing a CONFIRMED Shopify sale: this edit's lines before → after, plus the discount. */
function _txDivergenceExplainHtml(beforeItems, afterItems, oldDiscount, newDiscount) {
  const rows = _spDxItemRows(beforeItems, afterItems);
  const a = Number(oldDiscount) || 0, b = Number(newDiscount) || 0;
  if (Math.abs(a - b) >= 0.01) rows.push(`<li class="sp-dx-row is-money"><span class="sp-dx-ico" aria-hidden="true">%</span><span class="sp-dx-txt"><b>${esc(spEditText('الخصم', 'Discount'))}</b><small><bdi>${esc(_spEditPair(_spEditMoneyText(a), _spEditMoneyText(b)))}</bdi></small></span><span class="sp-dx-amt">${_spSignedIso(a - b)}</span></li>`);
  if (!rows.length) return '';
  const shown = rows.slice(0, 6), more = rows.length - shown.length;
  return `<div class="sp-dx"><p class="sp-dx-head">${esc(spEditText('التغييرات في هذا التعديل:', 'What this edit changes:'))}</p><ul>${shown.join('')}</ul>${more > 0 ? `<p class="sp-dx-more">${esc(spEditText(`و${more} تغيير آخر`, `and ${more} more`))}</p>` : ''}</div>`;
}
function _spDivergenceLinesHtml(divergence) {
  const lines = (divergence?.changes || []).slice(0, 6);
  return lines.length ? `<div class="sp-dx"><p class="sp-dx-head">${esc(spEditText('التغييرات:', 'What changed:'))}</p><ul class="sp-dx-plain">${lines.map(l => `<li dir="auto">${esc(String(l))}</li>`).join('')}</ul></div>` : '';
}

function openShopifyEditReview(id, requestId = '') {
  if (typeof _canAccessPage === 'function' && !_canAccessPage('shopify-orders') && !_canAccessPage('invoice-view')) {
    _requirePageAccess('shopify-orders'); return;
  }
  const order = (_shopifyOrders || []).find(o => o._id === id);
  if (!order) return;
  const pending = order.editRequest && (order.editRequest.status === 'معلق' || order.editRequest.status === 'قيد التنفيذ');
  // The pending request is drawn now, from memory, and never redrawn — a typed rejection reason survives
  // the history arriving; decideShopifyEdit reads #sp-edit-rejection-reason right after this call.
  const pendingHtml = pending ? `<section class="sp-eh-pending">${_spEditRequestDetail(order)}${isAdmin() && order.editRequest.status === 'معلق' ? `<label for="sp-edit-rejection-reason">${esc(spEditText('سبب الرفض (اختياري)', 'Rejection reason (optional)'))}</label><textarea id="sp-edit-rejection-reason" rows="2" maxlength="500" style="width:100%;margin:8px 0 16px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit"></textarea>` : ''}${_spEditReviewActions(order)}</section>` : '';
  const skeleton = `<div class="sp-eh-loading" aria-busy="true">${'<span class="sp-eh-skel"></span>'.repeat(2)}<span class="sr-only">${esc(spEditText('جارٍ تحميل سجل التعديلات…', 'Loading edit history…'))}</span></div>`;
  openModal(`<div class="sp-eh" data-order-id="${esc(id)}"><h3>${esc(spEditText('سجل تعديلات الطلب', 'Order edit history'))} <bdi>#${esc(order.ref)}</bdi></h3>
    ${pendingHtml}<div id="sp-eh-summary"></div>
    ${pending ? `<h4 class="sp-eh-subhead">${esc(spEditText('التعديلات السابقة', 'Earlier edits'))}</h4>` : ''}
    <div id="sp-eh-list" class="sp-eh-list">${skeleton}</div></div>`);
  qs('#modal-overlay').classList.add('shopify-edit-review');
  qs('#sp-edit-rejection-reason')?.setAttribute('data-order-id', id);
  api(`/shopify/orders/detail/${encodeURIComponent(id)}`).then(full => {
    const host = qs('#sp-eh-list');
    if (!host || host.closest('.sp-eh')?.dataset.orderId !== id) return;  // closed or another order opened
    const merged = { ...order, ...full, editRequest: full.editRequest || order.editRequest };
    host.innerHTML = _spEhListHtml(merged, requestId);
    const summary = qs('#sp-eh-summary'); if (summary) summary.innerHTML = _spEhSummaryHtml(merged);
  }).catch(() => {
    const host = qs('#sp-eh-list');
    if (!host || host.closest('.sp-eh')?.dataset.orderId !== id) return;
    host.innerHTML = `<p class="sp-eh-empty is-error">${esc(spEditText('تعذّر تحميل سجل التعديلات.', 'Could not load the edit history.'))} <button type="button" class="btn btn-outline btn-sm" onclick="openShopifyEditReview('${esc(id)}','${esc(requestId)}')">${esc(spEditText('إعادة المحاولة', 'Retry'))}</button></p>`;
  });
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
    // The server may ask first (bundle break · discount over the lines outside a bundle · a total that now
    // differs from Shopify) — answered here by whoever is editing, then resent (index.html _editAnswerServerQuestion).
    let res;
    for (let i = 0; i < 4 && !res; i++) {
      try { res = await api(`/shopify/transactions/${id}/edit`, { method: 'PATCH', body: JSON.stringify(body) }); }
      catch (e) {
        if (typeof _editAnswerServerQuestion !== 'function' || !(await _editAnswerServerQuestion(e, body, original))) throw e;
      }
    }
    if (!res) return;
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
