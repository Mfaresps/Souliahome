/* Adapted from Hirael Timeline (MIT): https://hirael.com/r/timeline.json */
(function (root) {
  'use strict';

  const labels = {
    preparing: 'بدأ تجهيز الطلب', ready: 'جاهز للشحن', delivered: 'تم تسليم الطلب',
    sent: 'تم إنشاء الشحنة', resent: 'أُعيد إرسال الشحنة', deleted: 'حُذفت بوليصة الشحن',
    cancelled: 'أُلغيت الشحنة',
    PICKED_UP: 'استلمت شركة الشحن الطلب', IN_TRANSIT: 'الشحنة في الطريق',
    OUT_FOR_DELIVERY: 'خرجت الشحنة للتسليم', DELIVERED: 'تم تسليم الطلب',
    CUSTOMER_POSTPONED: 'أجّل العميل الاستلام', FAILED_ATTEMPT: 'تعذّر التسليم',
    DELIVERY_FAILED: 'فشل التسليم', RETURNED: 'الطلب مرتجع', CANCELLED: 'أُلغيت الشحنة',
  };
  const negative = new Set(['deleted', 'cancelled', 'CUSTOMER_POSTPONED', 'FAILED_ATTEMPT', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED']);
  const fatal = new Set(['deleted', 'cancelled', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED']);
  const icon = {
    order: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    box: '<path d="m3 7 9-4 9 4-9 4-9-4ZM3 7v10l9 4 9-4V7M12 11v10"/>',
    truck: '<path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    warning: '<path d="M12 3 2 21h20L12 3ZM12 9v5M12 18h.01"/>',
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const timestamp = value => {
    if (!value) return null;
    const source = String(value).trim();
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(source) ? source + 'T12:00:00' : source);
    return Number.isFinite(date.getTime()) ? { source, date } : null;
  };
  const formatTime = value => {
    const parsed = timestamp(value);
    if (!parsed) return '';
    const options = /^\d{4}-\d{2}-\d{2}$/.test(parsed.source)
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return new Intl.DateTimeFormat('ar-EG-u-nu-latn', options).format(parsed.date);
  };

  function eventsFor(tx, status) {
    const events = [];
    const add = (key, title, at, tone, symbol) => {
      const parsed = timestamp(at);
      if (parsed) events.push({ key, title, at: parsed.source, time: parsed.date.getTime(), tone, symbol, sequence: events.length });
    };
    add('order', 'تم تسجيل الطلب', tx.shopifyCreatedAt || tx.createdAt || tx.date, 'success', 'order');
    add('confirmation', 'تم تأكيد الطلب', tx.confirmedAt, 'success', 'check');
    for (const entry of (Array.isArray(tx.pickupHistory) ? tx.pickupHistory : [])) {
      if (entry && labels[entry.action] && ['preparing', 'ready', 'delivered'].includes(entry.action))
        add('pickup-' + entry.action, labels[entry.action], entry.date, 'success', entry.action === 'delivered' ? 'check' : 'box');
    }
    const shipmentEvents = Array.isArray(tx.shipmentEvents) ? tx.shipmentEvents : [];
    for (const entry of shipmentEvents) {
      if (entry && labels[entry.type]) add('shipment-' + entry.type, labels[entry.type], entry.at,
        negative.has(entry.type) ? 'destructive' : 'info', negative.has(entry.type) ? 'warning' : 'truck');
    }
    if (!shipmentEvents.some(entry => ['sent', 'resent'].includes(entry?.type)))
      add('shipment-sent', labels.sent, tx.shippedAt, 'info', 'truck');
    const tracking = Array.isArray(tx.bostaTrackingEvents) ? tx.bostaTrackingEvents : [];
    for (const entry of tracking) {
      const code = String(entry?.status || '').toUpperCase();
      if (labels[code]) add('carrier-' + code, labels[code], entry.at,
        negative.has(code) ? (fatal.has(code) ? 'destructive' : 'warning') : code === 'DELIVERED' ? 'success' : 'info',
        negative.has(code) ? 'warning' : code === 'DELIVERED' ? 'check' : 'truck');
    }
    if (!tracking.some(entry => entry?.status === 'DELIVERED') && !(Array.isArray(tx.pickupHistory) && tx.pickupHistory.some(entry => entry?.action === 'delivered')))
      add('delivered', labels.delivered, tx.deliveredAt, 'success', 'check');
    if (tx.cancelled) add('order-cancelled', 'تم إلغاء الطلب', tx.cancelledAt, 'destructive', 'warning');
    events.sort((a, b) => a.time - b.time || a.sequence - b.sequence);
    // The live state is shown without a fabricated date when no dated event represents it.
    const stateKey = status?.key;
    const last = events.at(-1);
    const covered = stateKey === 'DELIVERED' ? ['delivered', 'carrier-DELIVERED', 'pickup-delivered'].includes(last?.key)
      : stateKey === 'CANCELLED' ? ['order-cancelled', 'shipment-cancelled', 'carrier-CANCELLED'].includes(last?.key)
      : stateKey === 'Preparing' ? last?.key === 'pickup-preparing'
      : stateKey === 'Ready' ? last?.key === 'pickup-ready'
      : stateKey === 'Shipped' ? last?.key === 'shipment-sent'
      : last?.key === 'carrier-' + stateKey;
    if (status?.label && !covered) {
      const waitingForCarrier = stateKey === 'Ready' && events.some(event => event.key === 'pickup-ready') && events.some(event => event.key === 'shipment-sent');
      events.push({ key: 'current', title: waitingForCarrier ? 'بانتظار استلام شركة الشحن' : status.label,
        at: '', tone: fatal.has(stateKey) ? 'destructive' : negative.has(stateKey) ? 'warning' : 'info',
        symbol: negative.has(stateKey) || fatal.has(stateKey) ? 'warning' : 'box', current: true });
    }
    if (!events.length) return '';
    return `<section class="invoice-timeline" aria-labelledby="invoice-timeline-title">
      <div class="invoice-timeline-heading"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/></svg><h2 id="invoice-timeline-title">مسار الطلب</h2></div>
      <ol class="invoice-timeline-list" data-slot="timeline">${events.map(event => `<li class="invoice-timeline-item" data-slot="timeline-item" data-tone="${event.tone}">
        <span class="invoice-timeline-dot" data-slot="timeline-dot" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icon[event.symbol]}</svg></span>
        <div class="invoice-timeline-content" data-slot="timeline-content"><p class="invoice-timeline-title" data-slot="timeline-title">${escape(event.title)}${event.current ? '<span class="invoice-timeline-current">الحالة الحالية</span>' : ''}</p>${event.at ? `<time class="invoice-timeline-time" data-slot="timeline-time" datetime="${escape(event.at)}">${escape(formatTime(event.at))}</time>` : ''}</div>
      </li>`).join('')}</ol>
    </section>`;
  }

  root.SouliaInvoiceTimeline = { eventsFor };
  if (typeof module === 'object' && module.exports) module.exports = { eventsFor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
