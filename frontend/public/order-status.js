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
    FAILED_ATTEMPT: ['محاولة تسليم فاشلة', 'Failed Attempt', 'issue'],
    DELIVERY_FAILED: ['فشل التسليم', 'Delivery Failed', 'issue'],
    RETURNED: ['مرتجع', 'Returned', 'issue'],
    CANCELLED: ['ملغي', 'Cancelled', 'cancelled'],
    rejected: ['مرفوض', 'Rejected', 'issue'],
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
    else if (shopify) {
      if (o.status === 'rejected') key = 'rejected';
      else {
        const confirmed = o.confirmationApproved === true || o.shipWithoutDeposit === true
          || (Array.isArray(o.depositReceipts) && o.depositReceipts.some(r => r.status === 'معتمد' && Number(r.amount) > 0));
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
    let label = text(key, lang), tone = states[key]?.[2] || 'shipping';
    const attempts = Array.isArray(o.shipmentAttempts) ? o.shipmentAttempts.length : Number(o.shipmentAttempts) || 0;
    if (!shopify && !activeShipment && o.deliverySource !== 'MANUAL' && attempts > 0 && key !== 'DELIVERED' && key !== 'CANCELLED') {
      label = en ? `Awaiting Shipment ${attempts + 1}` : `بانتظار الشحنة ${attempts + 1}`;
      tone = 'waiting';
    }
    let carrier = !shopify && ['Ready', 'Shipped', 'DELIVERED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED'].includes(key)
      ? String(o.shipCo || o.carrierName || (shipment ? 'Bosta' : o.carrierCode || '')).trim() : '';
    if (/^(bosta|بوسطة)$/i.test(carrier)) carrier = en ? 'Bosta' : 'بوسطة';
    const note = code === 'DELETED' ? (en ? 'AWB Deleted at Bosta' : 'البوليصة محذوفة من بوسطة')
      : code === 'VALIDATION_ERROR' ? (en ? 'AWB Validation Error' : 'خطأ في بيانات البوليصة') : '';
    const shortLabels = {
      awaiting_confirmation: ['بانتظار التأكيد', 'Unconfirmed'],
      confirmed: ['مؤكّد', 'Confirmed'],
      Pending: ['بانتظار التجهيز', 'Awaiting Prep'],
      PICKED_UP: ['استلمها الناقل', 'Picked Up'],
      OUT_FOR_DELIVERY: ['خارج للتسليم', 'Out for Delivery'],
      FAILED_ATTEMPT: ['تعذّر التسليم', 'Failed Attempt'],
    };
    const shortLabel = shortLabels[key]?.[en ? 1 : 0] || label;
    return { key, label, shortLabel, tone, carrier, note };
  }
  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function badge(meta, options = {}) {
    const title = [meta.label, meta.note].filter(Boolean).join(' · ');
    const label = options.compact && meta.key === 'Ready' ? (/[\u0600-\u06ff]/.test(meta.label) ? 'جاهز للشحن' : 'Ready') : meta.shortLabel || meta.label;
    return `<span class="order-state${options.compact ? ' is-compact' : ''}" data-order-state="${escape(meta.key)}" data-tone="${escape(meta.tone)}" title="${escape(title)}" aria-label="${escape(title)}"><span class="order-state-dot" aria-hidden="true"></span><span class="order-state-label">${escape(label)}</span></span>`;
  }
  const api = { resolve, badge, text };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SouliaOrderStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
