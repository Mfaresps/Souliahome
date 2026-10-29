(function (root) {
  'use strict';
  const states = {
    awaiting_confirmation: ['بانتظار تأكيد العميل', 'Awaiting Confirmation', 'waiting'],
    confirmed: ['مؤكّد · بانتظار التجهيز', 'Confirmed · Awaiting Prep', 'confirmed'],
    Pending: ['مسجّل · بانتظار التجهيز', 'Registered · Awaiting Prep', 'waiting'],
    Preparing: ['قيد التجهيز', 'Preparing', 'preparing'],
    Ready: ['جاهز للشحن', 'Ready to Ship', 'ready'],
    Shipped: ['تم الشحن', 'Shipped', 'shipping'],
    DELIVERED: ['تم التسليم', 'Delivered', 'delivered'],
    PICKED_UP: ['تم الاستلام بواسطة شركة الشحن', 'Picked Up', 'shipping'],
    IN_TRANSIT: ['في الطريق', 'In Transit', 'shipping'],
    OUT_FOR_DELIVERY: ['خارج للتسليم', 'Out for Delivery', 'shipping'],
    CUSTOMER_POSTPONED: ['العميل أجّل الاستلام', 'Postponed by Customer', 'waiting'],
    FAILED_ATTEMPT: ['محاولة تسليم فاشلة', 'Failed Attempt', 'issue'],
    DELIVERY_FAILED: ['فشل التسليم', 'Delivery Failed', 'issue'],
    RETURNED: ['مرتجع', 'Returned', 'issue'],
    CANCELLED: ['ملغي', 'Cancelled', 'cancelled'],
    customer_cancelled: ['العميل ألغى الطلب', 'Cancelled by customer', 'cancelled'],
    rejected: ['مرفوض', 'Rejected', 'issue'],
  };
  const previews = {
    awaiting_confirmation: ['waiting', 'بانتظار تأكيد العميل للبدء في تجهيز الطلب.', 'Waiting for customer confirmation before preparation.'],
    confirmed: ['confirmed', 'تم تأكيد الطلب، وبانتظار بدء التجهيز.', 'Order confirmed and waiting for preparation.'],
    Pending: ['waiting', 'تم تسجيل الطلب، وبانتظار بدء التجهيز.', 'Order registered and waiting for preparation.'],
    awaiting_shipment: ['waiting', 'بانتظار إنشاء شحنة جديدة لهذا الطلب.', 'Waiting for a new shipment to be created for this order.'],
    Preparing: ['Preparing', 'جاري مسح باركود الشحنة وتغليفها في كيس SOULIA.', 'The parcel is being scanned and packed in a SOULIA mailer.'],
    Ready: ['Ready', 'تم تجهيز الشحنة، وبانتظار استلام شركة الشحن.', 'Packed and ready for collection by the shipping company.'],
    Shipped: ['transit', 'تم تسجيل شحن الطلب.', 'The order has been marked as shipped.'],
    PICKED_UP: ['pickup', 'استلمت شركة الشحن الطرد لبدء رحلة التوصيل.', 'The shipping company has collected the parcel.'],
    IN_TRANSIT: ['transit', 'الشحنة في الطريق عبر شبكة شركة الشحن.', 'The parcel is moving through the shipping network.'],
    OUT_FOR_DELIVERY: ['delivery', 'الشحنة مع المندوب في جولة التسليم.', 'The parcel is with the courier for delivery.'],
    DELIVERED: ['delivered', 'تم تسليم الشحنة بنجاح.', 'The parcel has been successfully delivered.'],
    CUSTOMER_POSTPONED: ['postponed', 'طلب العميل تأجيل الاستلام إلى وقت لاحق.', 'The customer requested delivery at a later time.'],
    FAILED_ATTEMPT: ['attempt', 'تعذّر تسليم الشحنة في المحاولة الأخيرة.', 'The latest delivery attempt was unsuccessful.'],
    DELIVERY_FAILED: ['failed', 'تم تسجيل فشل التسليم لدى شركة الشحن.', 'The shipping company reported delivery failure.'],
    RETURNED: ['returned', 'تم تسجيل الشحنة كمرتجع لدى شركة الشحن.', 'The shipping company has marked the parcel as returned.'],
    CANCELLED: ['cancelled', 'تم إلغاء الطلب أو الشحنة.', 'The order or shipment has been cancelled.'],
    customer_cancelled: ['cancelled', 'ألغى العميل الطلب.', 'The customer cancelled the order.'],
    rejected: ['cancelled', 'تم رفض الطلب.', 'The order was rejected.'],
  };
  function text(key, lang) {
    const state = states[key];
    return state ? state[lang === 'en' ? 1 : 0] : String(key || '');
  }
  function resolve(order, kind, lang) {
    const o = order || {}, en = lang === 'en';
    const code = String(o.bostaStatus || '').trim().toUpperCase();
    const shipment = !!(o.bostaOrderId || o.hasShipment || o.afterSales?.shipments?.[o.afterSales?.caseId]?.deliveryId);
    const activeShipment = shipment && !['DELETED', 'VALIDATION_ERROR'].includes(code);
    const shopify = kind === 'shopify' && o.status !== 'approved';
    let key;
    if (o.cancelled || o.shopifyCancelled || ['ملغي', 'محذوف'].includes(o.payStatus)) key = 'CANCELLED';
    else if (kind === 'shopify' && o.followUpOutcome === 'cancelled') key = 'customer_cancelled';
    else if (shopify) {
      if (o.status === 'rejected') key = 'rejected';
      else {
        const confirmed = o.confirmationApproved === true || o.shipWithoutDeposit === true
          || (Array.isArray(o.depositReceipts) && o.depositReceipts.some(r => ['معتمد', 'معلق'].includes(r.status) && Number(r.amount) > 0));
        key = confirmed ? 'confirmed' : 'awaiting_confirmation';
      }
    } else if (code === 'DELIVERED') key = code;
    else if (o.deliverySource === 'MANUAL') key = 'Shipped';
    else if (activeShipment) key = !code || code === 'CREATED' ? 'Ready' : code;
    else {
      key = o.pickupStatus || 'Pending';
      if (key === 'Picked-Up') key = 'Ready';
      if (key === 'Delivered') key = 'DELIVERED';
    }
    let label = text(key, lang), tone = states[key]?.[2] || 'shipping', previewKey = key;
    const attempts = Array.isArray(o.shipmentAttempts) ? o.shipmentAttempts.length : Number(o.shipmentAttempts) || 0;
    if (!shopify && !activeShipment && o.deliverySource !== 'MANUAL' && attempts > 0 && key !== 'DELIVERED' && key !== 'CANCELLED') {
      label = en ? `Awaiting Shipment ${attempts + 1}` : `بانتظار الشحنة ${attempts + 1}`;
      tone = 'waiting';
      previewKey = 'awaiting_shipment';
    }
    let carrier = !shopify && ['Ready', 'Shipped', 'DELIVERED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'CUSTOMER_POSTPONED', 'FAILED_ATTEMPT', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED'].includes(key)
      ? String(o.shipCo || o.carrierName || (shipment ? 'Bosta' : o.carrierCode || '')).trim() : '';
    if (/^(bosta|بوسطة)$/i.test(carrier)) carrier = en ? 'Bosta' : 'بوسطة';
    const postponed = o.bostaDeliveryException?.code === 3 && ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'CUSTOMER_POSTPONED'].includes(code);
    if (postponed && ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'CUSTOMER_POSTPONED'].includes(key)) previewKey = 'CUSTOMER_POSTPONED';
    if (postponed && key === 'IN_TRANSIT') label = en ? 'In Transit · Customer Postponed' : 'في الطريق · العميل أجّل الاستلام';
    const carrierReason = o.bostaLastTrackingUpdate?.status === code
      ? (en ? o.bostaLastTrackingUpdate.reason || o.bostaLastTrackingUpdate.reasonAr : o.bostaLastTrackingUpdate.reasonAr || o.bostaLastTrackingUpdate.reason) : '';
    const note = key === 'DELIVERED' ? ''
      : code === 'DELETED' ? (en ? 'AWB Deleted at Bosta' : 'البوليصة محذوفة من بوسطة')
      : code === 'VALIDATION_ERROR' ? (en ? 'AWB Validation Error' : 'خطأ في بيانات البوليصة')
      : carrierReason || (postponed ? (en ? 'Last exception: postponed by customer' : 'آخر سبب للتأجيل: طلب العميل') : '');
    const shortLabels = {
      awaiting_confirmation: ['بانتظار التأكيد', 'Unconfirmed'],
      confirmed: ['مؤكّد', 'Confirmed'],
      Pending: ['بانتظار التجهيز', 'Awaiting Prep'],
      PICKED_UP: ['استلمها الناقل', 'Picked Up'],
      OUT_FOR_DELIVERY: ['خارج للتسليم', 'Out for Delivery'],
      FAILED_ATTEMPT: ['تعذّر التسليم', 'Failed Attempt'],
    };
    const shortLabel = shortLabels[key]?.[en ? 1 : 0] || label;
    return { key, label, shortLabel, tone, carrier, note, previewKey };
  }
  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function preview(meta) {
    const key = meta.previewKey || meta.key;
    if (!Object.prototype.hasOwnProperty.call(previews, key)) return null;
    const entry = previews[key];
    return { scene: entry[0], description: entry[/[\u0600-\u06ff]/.test(meta.label) ? 1 : 2] };
  }
  function badge(meta, options = {}) {
    const title = [meta.label, meta.note].filter(Boolean).join(' · ');
    const label = options.compact && meta.key === 'Ready' ? (/[\u0600-\u06ff]/.test(meta.label) ? 'جاهز للشحن' : 'Ready') : meta.shortLabel || meta.label;
    const preview = options.preview && previews[meta.previewKey || meta.key];
    const detail = preview ? `data-state-preview role="button" tabindex="0" aria-expanded="false" data-preview-scene="${preview[0]}" data-preview-description="${escape(preview[/[\u0600-\u06ff]/.test(meta.label) ? 1 : 2])}" data-preview-label="${escape(meta.label)}" data-preview-note="${escape(meta.note || '')}"` : `title="${escape(title)}"`;
    return `<span class="order-state${options.compact ? ' is-compact' : ''}" data-order-state="${escape(meta.key)}" data-tone="${escape(meta.tone)}" ${detail} aria-label="${escape(title)}"><span class="order-state-dot" aria-hidden="true"></span><span class="order-state-label">${escape(label)}</span></span>`;
  }
  function postponements(tx) {
    const raw = tx.bostaRawResponse?.data || tx.bostaRawResponse || {};
    const events = new Map();
    const add = (event, shipmentId = tx.bostaOrderId || '') => {
      if (!event || !(Number(event.reasonCode ?? event.code) === 3 || event.status === 'CUSTOMER_POSTPONED')) return;
      const at = event.exceptionAt || event.time || event.at || '';
      const scheduledAt = event.scheduledAt || '';
      const key = JSON.stringify([shipmentId, at, scheduledAt]);
      events.set(key, { at, scheduledAt, shipmentId, reason: event.reason || '', reasonAr: event.reasonAr || 'طلب العميل تأجيل الاستلام' });
    };
    (tx.bostaTrackingEvents || []).forEach(event => add(event, event.shipmentId || tx.bostaOrderId || ''));
    (Array.isArray(raw.state?.exception) ? raw.state.exception : []).forEach(event => add(event));
    (raw.attempts || []).forEach(attempt => add(attempt.exception));
    add(tx.bostaDeliveryException);
    if (!events.size && tx.bostaStatus === 'CUSTOMER_POSTPONED') add({ status: tx.bostaStatus });
    return [...events.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  }
  const api = { resolve, badge, text, postponements, preview };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SouliaOrderStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
