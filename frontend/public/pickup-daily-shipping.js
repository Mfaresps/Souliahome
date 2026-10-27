/* Daily dispatch groups are a view of shipment registration, not a pickupStatus mutation. */
function _puDailyText(ar, en) { return currentLang === 'en' ? en : ar; }
const _puDailyDateFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
function _puDailyDay(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const dateOnly = new Date(text + 'T12:00:00Z');
    return Number.isFinite(dateOnly.getTime()) && dateOnly.toISOString().slice(0, 10) === text ? text : '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = _puDailyDateFormatter.formatToParts(date);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}
function _puDailyShipment(order) {
  if (order.deliverySource === 'MANUAL' || order.archived) return null;
  const events = (order.shipmentEvents || []).filter(event => ['sent', 'resent'].includes(event.type)
    && (!order.bostaOrderId || !event.bostaOrderId || String(event.bostaOrderId) === String(order.bostaOrderId))
    && Number.isFinite(Date.parse(event.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const registered = !!order.bostaOrderId || !!order.bostaTrackingNumber || events.length > 0;
  if (!registered && !['Shipped', 'Delivered'].includes(order.pickupStatus)) return null;
  const day = _puDailyDay(events[0]?.at || order.bostaCreatedAt || order.shippedAt || order.pickupDate)
    || _puDailyDay(/^SH-(\d{4}-\d{2}-\d{2})-/.exec(order.pickupRef || '')?.[1]) || '';
  const rawCarrier = String(order.shipCo || (registered ? 'Bosta' : '')).trim();
  const carrier = /^(bosta|بوسطة|بوسطه)$/i.test(rawCarrier) ? 'Bosta' : rawCarrier;
  return { day, carrier: carrier || _puDailyText('شركة غير مسجلة', 'Carrier not recorded') };
}
function _puDailyAwaitingPickup(order) {
  const code = String(order.bostaStatus || '').trim();
  if (code === 'CREATED') return true;
  if (code && code !== 'VALIDATION_ERROR') return false;
  return ['Pending', 'Preparing', 'Ready', 'Picked-Up'].includes(_puDisplayStatus(order));
}
function _puDailyShippingGroups(orders, stage = 'all') {
  const groups = new Map();
  const seen = new Set();
  for (const order of orders || []) {
    const shipment = _puDailyShipment(order);
    if (!shipment || seen.has(String(order._id))) continue;
    const waiting = _puDailyAwaitingPickup(order);
    if ((stage === 'ready' && !waiting) || (stage === 'shipped' && waiting)) continue;
    if (stage === 'ready' && !['Ready', 'Picked-Up'].includes(order.pickupStatus || 'Pending')) continue;
    seen.add(String(order._id));
    const key = _puShippingReceivedRef(shipment.carrier, shipment.day || 'unknown');
    if (!groups.has(key)) groups.set(key, { key, pickupRef: key, pickupDate: shipment.day,
      shipCo: shipment.carrier, isDailyShipping: true, stage, orders: [] });
    groups.get(key).orders.push(order);
  }
  return [...groups.values()].sort((a, b) => b.pickupDate.localeCompare(a.pickupDate) || a.shipCo.localeCompare(b.shipCo));
}
function _puDailyOrderStatus(order) {
  const labels = {
    CREATED: ['بانتظار استلام شركة الشحن', 'Awaiting courier pickup', 'waiting'],
    PICKED_UP: ['استلمتها شركة الشحن', 'Collected by courier', 'transit'],
    IN_TRANSIT: ['قيد النقل', 'In transit', 'transit'],
    OUT_FOR_DELIVERY: ['خرج للتسليم', 'Out for delivery', 'transit'],
    DELIVERED: ['تم التسليم', 'Delivered', 'delivered'],
    RETURNED: ['مرتجع', 'Returned', 'failed'], CANCELLED: ['ملغي', 'Cancelled', 'failed'],
    DELETED: ['حُذفت الشحنة', 'Shipment deleted', 'failed'],
    FAILED_ATTEMPT: ['تعذر التسليم', 'Delivery attempt failed', 'failed'],
  };
  const status = String(order.bostaStatus || '').trim();
  let entry = labels[status];
  if (!entry) {
    const stage = _puDisplayStatus(order);
    entry = stage === 'Delivered' ? labels.DELIVERED : stage === 'Shipped'
      ? ['تم الشحن', 'Shipped', 'transit'] : labels.CREATED;
    if (status && order.bostaStatusLabel) entry = [order.bostaStatusLabel, order.bostaStatusLabel, 'waiting'];
  }
  return { label: _puDailyText(entry[0], entry[1]), tone: entry[2] };
}
function _puDailyStatusHtml(order) {
  const status = _puDailyOrderStatus(order);
  return `<span class="pu-daily-state is-${status.tone}">${esc(status.label)}</span>`;
}
function _puDailyPickupHtml(orders, compact = false) {
  if (orders.every(order => !order.bostaOrderId && !(order.shipmentEvents || []).some(event => ['sent', 'resent'].includes(event.type)) && order.shipCo && !/^(bosta|بوسطة|بوسطه)$/i.test(order.shipCo.trim()))) {
    return `<span class="pu-daily-pickup is-unknown">${esc(_puDailyText('شركة الشحن غير مرتبطة بطلبات استلام بوسطة', 'Carrier has no Bosta pickup requests'))}</span>`;
  }
  if (typeof _bostaPickupRequestsKnown === 'undefined' || !_bostaPickupRequestsKnown) {
    const failed = typeof _bostaPickupRequestsState !== 'undefined' && _bostaPickupRequestsState === 'error';
    return `<span class="pu-daily-pickup is-unknown">${esc(failed ? _puDailyText('تعذر تحميل حالة طلب الاستلام', 'Pickup request status unavailable') : _puDailyText('جارٍ التحقق من طلب الاستلام', 'Checking pickup request'))}</span>`;
  }
  const covered = { created: new Set(), pending: new Set(), rejected: new Set() };
  const requestDays = new Set();
  for (const order of orders) {
    const matching = _bostaPickupRequests.filter(request => (request.orderIds || []).map(String).includes(String(order._id)));
    const created = matching.find(r => r.status === 'created');
    const pending = matching.find(r => r.status === 'pending');
    const rejected = matching.find(r => r.status === 'rejected');
    const request = created || pending;
    if (request) { covered[created ? 'created' : 'pending'].add(String(order._id)); if (request.scheduledDate) requestDays.add(request.scheduledDate); }
    else if (rejected) covered.rejected.add(String(order._id));
  }
  const title = esc([...requestDays].sort().join(' · '));
  const counts = count => compact && orders.length === 1 ? '' : `<bdi>${count}/${orders.length}</bdi>`;
  const parts = [];
  if (covered.created.size) parts.push(`<span class="pu-daily-pickup is-requested" title="${title}">✓ ${esc(_puDailyText('تم إرسال طلب الاستلام لبوسطة', 'Pickup request sent to Bosta'))} ${counts(covered.created.size)}</span>`);
  if (covered.pending.size) parts.push(`<span class="pu-daily-pickup is-pending" title="${title}">◷ ${esc(_puDailyText('طلب الاستلام قيد التأكيد', 'Pickup awaiting confirmation'))} ${counts(covered.pending.size)}</span>`);
  if (covered.rejected.size) parts.push(`<span class="pu-daily-pickup is-rejected">${esc(_puDailyText('رُفض طلب الاستلام', 'Pickup request rejected'))} ${counts(covered.rejected.size)}</span>`);
  const missing = orders.length - covered.created.size - covered.pending.size - covered.rejected.size;
  if (missing) parts.push(`<span class="pu-daily-pickup is-missing">${esc(_puDailyText('لم يُسجَّل طلب استلام', 'No pickup request recorded'))} ${counts(missing)}</span>`);
  if (requestDays.size && !compact) parts.push(`<span class="pu-daily-pickup is-schedule">${esc(_puDailyText('موعد الاستلام', 'Scheduled pickup'))}: <bdi>${title}</bdi></span>`);
  return parts.join('');
}
function _puDailySummaryHtml(group) {
  const counts = new Map();
  group.orders.forEach(order => { const { label, tone } = _puDailyOrderStatus(order); const entry = counts.get(label) || { count: 0, tone }; entry.count++; counts.set(label, entry); });
  return `<div class="pu-daily-states">${[...counts].map(([label, entry]) => `<span class="pu-daily-state is-${entry.tone}">${esc(label)} <bdi>${entry.count}</bdi></span>`).join('')}</div>`;
}
function _puDailyDateLabel(group) {
  return group.pickupDate ? _puDailyDayLabel(group.pickupDate) : _puDailyText('تاريخ الإرسال غير مسجل', 'Dispatch date not recorded');
}
function _puDailyDayLabel(day) {
  return new Intl.DateTimeFormat(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(day + 'T12:00:00Z'));
}
function _puDailyCountHtml(count) {
  return `<span class="pu-daily-count"><bdi>${count}</bdi> <span>${esc(_puDailyText('أوردر', 'orders'))}</span></span>`;
}
function _puGroupCountContent(count) {
  return `<bdi>${esc(String(fmtN(count)))}</bdi><span>${esc(_puDailyText('أوردر', count === 1 ? 'order' : 'orders'))}</span>`;
}
function _puDailyTableDateHtml(day) {
  if (!day) return `<span class="pu-daily-date">${esc(_puDailyText('تاريخ غير مسجل', 'Date not recorded'))}</span>`;
  const date = new Date(day + 'T12:00:00Z');
  const locale = currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn';
  const weekday = new Intl.DateTimeFormat(locale, { timeZone: 'Africa/Cairo', weekday: 'long' }).format(date);
  const numeric = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  return `<div class="pu-daily-date"><bdi class="pu-table-day">${esc(day.slice(-2))}</bdi><span class="pu-table-date-copy"><strong>${esc(weekday)}</strong><time datetime="${esc(day)}"><bdi>${esc(numeric)}</bdi></time></span></div>`;
}
function _puGroupDayLabel(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return '';
  return new Intl.DateTimeFormat(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    timeZone: 'Africa/Cairo', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(day + 'T12:00:00Z'));
}
function _puGroupDatePreview(value, kind = 'shipped') {
  const day = _puDailyDay(value);
  if (!day) return '';
  const date = new Date(day + 'T12:00:00Z');
  const locale = currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn';
  const part = options => new Intl.DateTimeFormat(locale, { timeZone: 'Africa/Cairo', ...options }).format(date);
  const labels = { created: ['تاريخ التحضير', 'Prepared on'], ready: ['موعد الاستلام', 'Pickup date'], shipped: ['تاريخ الشحن', 'Dispatched on'], order: ['تاريخ الطلب', 'Order date'] };
  const label = labels[kind] || labels.shipped;
  return `<time class="pu-date-preview pu-date-simple" datetime="${esc(day)}" title="${esc(_puDailyDayLabel(day))}"><span class="pu-date-caption">${esc(_puDailyText(...label))}</span><bdi class="pu-date-value">${esc(part({ day: 'numeric', month: 'short', year: 'numeric' }))}</bdi></time>`;
}
function _puDailyGroupCard(group) {
  const card = document.createElement('button');
  const delivered = group.orders.filter(order => _puDailyOrderStatus(order).tone === 'delivered').length;
  const deliveryPercent = group.orders.length ? Math.round(delivered / group.orders.length * 100) : 0;
  card.type = 'button'; card.className = 'pu-daily-group pu-stage-card pu-stage-shipped'; card.dataset.dailyGroup = group.key;
  card.innerHTML = `<div class="pu-group-accent"></div><div class="pu-group-header"><div class="pu-prep-content">
    <div class="pu-prep-heading"><span class="pu-shipped-heading">${_puGroupDatePreview(group.pickupDate) || `<span class="pu-ref-hero">${esc(group.pickupRef)}</span>`}<span class="pu-shipped-carrier">${esc(group.shipCo)}</span></span>${_puDailyCountHtml(group.orders.length)}</div>
    <div class="pu-prep-amount"><span>${esc(_puDailyText('إجمالي المجموعة', 'Group total'))}</span><strong class="pu-group-total"><bdi>${esc(fmtJT(group.orders.reduce((sum, o) => sum + Number(o.total || 0), 0)))}</bdi></strong></div>
    <div class="pu-shipped-progress" role="progressbar" aria-label="${esc(_puDailyText('نسبة التسليم', 'Delivery progress'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${deliveryPercent}" title="${delivered}/${group.orders.length}"><span style="width:${deliveryPercent}%"></span></div>
    <div class="pu-stage-detail pu-daily-pickups">${_puDailyPickupHtml(group.orders)}</div>${_puDailySummaryHtml(group)}
    </div></div><div class="pu-group-footer"><span class="pu-card-btn pu-prep-open">${esc(_puDailyText('عرض الطلبات وحالاتها', 'View orders and statuses'))} ‹</span></div>`;
  card.addEventListener('click', () => openPuDailyShippingGroup(group.key, group.stage || 'all'));
  return card;
}
function _puDailyOrdersHtml(group) {
  return `<div class="pu-daily-orders">${group.orders.map(order => `<article class="pu-daily-order" data-daily-order="${esc(String(order._id))}">
    <header><strong><bdi>#${esc(order.ref || '—')}</bdi></strong>${_puDailyStatusHtml(order)}</header>
    <b class="pu-daily-client" dir="auto">${esc(order.client || '—')}</b>
    ${order.phone || order.clientPhone ? `<bdi class="pu-daily-phone">${esc(order.phone || order.clientPhone)}</bdi>` : ''}
    <div class="pu-daily-order-amount"><span>${esc(_puDailyText('قيمة الأوردر', 'Order total'))}</span><bdi>${esc(fmtJT(order.total || 0))}</bdi></div>
    ${order.bostaTrackingNumber ? `<div class="pu-daily-tracking">${esc(_puDailyText('رقم التتبع', 'Tracking'))}: <bdi>${esc(order.bostaTrackingNumber)}</bdi></div>` : ''}
    <div class="pu-daily-pickups">${_puDailyPickupHtml([order], true)}</div>
    <div class="pu-daily-order-footer"><details><summary>${esc(_puDailyText('المنتجات', 'Products'))} (${(order.items || []).length})</summary><ul>${(order.items || []).map(item => `<li><span dir="auto">${esc(item.name || item.code || '—')}</span><bdi>× ${esc(String(item.qty || 0))}</bdi></li>`).join('')}</ul></details>
    <div class="pu-daily-order-actions"><button type="button" class="btn btn-outline btn-sm pu-daily-invoice" data-daily-invoice="${esc(String(order._id))}">${esc(_puDailyText('عرض الفاتورة', 'View invoice'))}</button>
    ${order.bostaOrderId ? `<button type="button" class="btn btn-outline btn-sm" data-daily-awb="${esc(String(order._id))}">${esc(_puDailyText('معاينة البوليصة', 'Preview label'))}</button>` : ''}
    ${order.bostaTrackingNumber ? `<a class="btn btn-outline btn-sm pu-daily-bosta" href="${esc(_bostaBizUrl(order))}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Open in Bosta ↗</a>` : ''}</div>
    </div></article>`).join('')}</div>`;
}
// Reconcile these read-only shipping views in place. Socket/status syncs often
// return identical data; replacing innerHTML resets details, focus and selection.
function _puDailySyncContent(host, html) {
  const next = document.createElement(host.tagName);
  next.innerHTML = html;
  const focus = document.activeElement;
  const positions = [];
  for (let el = host; el; el = el.parentElement) positions.push([el, el.scrollTop, el.scrollLeft]);
  const key = node => {
    if (node.nodeType !== 1) return '';
    for (const name of ['data-daily-order', 'data-run-detail', 'data-run-ref']) {
      if (node.hasAttribute(name)) return name + ':' + node.getAttribute(name);
    }
    return node.id ? 'id:' + node.id : '';
  };
  const compatible = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName &&
    (key(a) || key(b) ? key(a) === key(b) : a.classList?.[0] === b.classList?.[0]);
  function sync(parent, source) {
    const unused = new Set(parent.childNodes);
    let cursor = parent.firstChild;
    for (const fresh of [...source.childNodes]) {
      const existing = [...unused].find(node => compatible(node, fresh));
      if (!existing) { parent.insertBefore(fresh, cursor); continue; }
      unused.delete(existing);
      if (existing !== cursor) parent.insertBefore(existing, cursor);
      if (existing.nodeType === 1) {
        for (const attr of [...existing.attributes]) {
          if (existing.tagName === 'DETAILS' && attr.name === 'open') continue;
          if (!fresh.hasAttribute(attr.name)) existing.removeAttribute(attr.name);
        }
        for (const attr of fresh.attributes) {
          if (attr.name === 'style' && existing.style.cssText === fresh.style.cssText) continue;
          if (existing.getAttribute(attr.name) !== attr.value) existing.setAttribute(attr.name, attr.value);
        }
        sync(existing, fresh);
      } else if (existing.nodeValue !== fresh.nodeValue) existing.nodeValue = fresh.nodeValue;
      cursor = existing.nextSibling;
    }
    unused.forEach(node => node.remove());
  }
  sync(host, next);
  if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
  positions.forEach(([el, top, left]) => { el.scrollTop = top; el.scrollLeft = left; });
}
function _puDailyBindInvoices(host) {
  host.querySelectorAll('[data-daily-awb]').forEach(button => {
    button.onclick = event => { event.stopPropagation(); previewBostaAwb(button.dataset.dailyAwb); };
  });
  host.querySelectorAll('[data-daily-invoice]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      const groupModal = button.closest('[data-daily-dialog]');
      if (groupModal) pucoShowInvoice(button.dataset.dailyInvoice);
      else showInvoiceDetail(button.dataset.dailyInvoice);
    };
  });
}
let _puDailyOpenGroup = null;
let _puDailyOpenStage = 'all';
function _puDailyDialogHtml(group) {
  return `<div class="pu-daily-dialog-head"><div><h3>${esc(_puDailyDateLabel(group))}</h3><p><span>${esc(group.shipCo)}</span>${_puDailyCountHtml(group.orders.length)}</p></div><button type="button" class="btn btn-outline btn-sm" onclick="closeModal()" aria-label="${esc(_puDailyText('إغلاق', 'Close'))}">×</button></div>
    <div class="pu-daily-pickups">${_puDailyPickupHtml(group.orders)}</div>${_puDailySummaryHtml(group)}${_puDailyOrdersHtml(group)}`;
}
function openPuDailyShippingGroup(key, stage = 'all') {
  if (typeof _requirePageAccess === 'function' && !_requirePageAccess('pickup-orders')) return;
  const group = _puDailyShippingGroups(_pickupOrders, stage).find(g => g.key === key);
  if (!group) return;
  _puDailyOpenGroup = key;
  _puDailyOpenStage = stage;
  openModal(`<div class="pu-daily-dialog" data-daily-dialog="${esc(key)}">${_puDailyDialogHtml(group)}</div>`, 'width:min(1050px,96vw);max-width:1050px');
  _puDailyBindInvoices(qs('#modal-content'));
}
function _puDailyRefreshOpenGroup() {
  const host = qs('#modal-content [data-daily-dialog]');
  if (host && qs('#modal-overlay')?.classList.contains('active') && _puDailyOpenGroup === host.dataset.dailyDialog) {
    const group = _puDailyShippingGroups(_pickupOrders, _puDailyOpenStage).find(g => g.key === _puDailyOpenGroup);
    if (!group) { closeModal(); return; }
    _puDailySyncContent(host, _puDailyDialogHtml(group));
    _puDailyBindInvoices(host);
  }
}
function _puDailyRunRowHtml(group, index, open) {
  const rowKey = `run-${index}`;
  const shortRef = group.isDailyShipping && group.pickupDate ? `SH-${group.pickupDate}` : group.pickupRef;
  const actions = group.isReadyRun ? `<div class="pu-daily-order-actions">
    <button type="button" class="btn btn-outline btn-sm" data-run-ref="${esc(group.pickupRef)}" onclick="event.stopPropagation();openPuEditModal(this.dataset.runRef)">Edit run</button>
    <button type="button" class="btn btn-outline btn-sm" ${_puReturnGroupBusy ? 'disabled aria-busy="true"' : ''} data-run-ref="${esc(group.pickupRef)}" onclick="event.stopPropagation();puGroupUndoReadyToPrep(this.dataset.runRef)">Return group</button>
  </div>` : '';
  return `<tr class="pu-run-row pu-daily-run ${group.isReadyRun ? 'pu-run-ready' : 'pu-run-shipped'}${open ? ' pu-run-open' : ''}" id="run-header-${rowKey}" data-run-ref="${esc(group.key)}" onclick="toggleRunExpand('${rowKey}')">
    <td><button type="button" class="pu-chevron" aria-expanded="${open}" aria-controls="${rowKey}" aria-label="${esc(_puDailyText('عرض أوردرات اليوم', 'View daily orders'))}">›</button></td>
    <td><span class="pu-ref-chip" dir="ltr" title="${esc(group.pickupRef)}">${esc(shortRef)}</span></td><td>${_puDailyTableDateHtml(group.pickupDate)}</td><td><span class="pu-daily-carrier">${esc(group.shipCo)}</span></td>
    <td><div class="pu-daily-pickups">${_puDailyPickupHtml(group.orders)}</div>${_puDailySummaryHtml(group)}</td><td>${_puDailyCountHtml(group.orders.length)}</td>
    <td><bdi>${esc(fmtJT(group.orders.reduce((sum, o) => sum + Number(o.total || 0), 0)))}</bdi></td><td></td></tr>
    <tr class="pu-detail-row" data-run-detail="${esc(group.key)}" id="${rowKey}" style="display:${open ? 'table-row' : 'none'}"><td colspan="8"><div class="pu-detail-panel">${actions}${_puDailyOrdersHtml(group)}</div></td></tr>`;
}
