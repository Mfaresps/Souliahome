import { createHash } from 'crypto';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const cents = (value: unknown): number => Math.round(Number(value || 0) * 100);
export interface SyncAction { kind: 'fulfill' | 'event' | 'tracking' | 'payment' | 'metadata'; label: string; input: any }
export interface SyncPlan { actions: SyncAction[]; issues: string[]; warnings: string[]; sourceHash: string; remoteHash: string }
export class SyncReview extends Error {}

function stamp(...values: any[]): string | null {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null;
    const date = new Date(number === null ? value : number < 1e11 ? number * 1000 : number);
    if (Number.isFinite(date.getTime()) && date.getTime() > 946684800000) return date.toISOString();
  }
  return null;
}

/** Stable business snapshot: excludes arrival timestamps, customer PII and webhook echoes. */
export function syncSource(tx: any, order: any, unitMappings: any[] = []): any {
  const raw = tx.bostaRawResponse?.data || tx.bostaRawResponse || {};
  const code = Number(raw.state?.code ?? raw.currentStatus?.code ?? raw.state);
  const state = String(tx.bostaStatus || '');
  const original = (order?.rawData?.line_items || []).map((l: any) => ({
    id: String(l.id), name: String(l.title || l.name || '').trim(),
    sku: String(l.sku || ''), qty: Number(l.current_quantity ?? l.quantity),
  })).filter((l: any) => l.qty > 0).sort((a: any, b: any) => a.id.localeCompare(b.id));
  // Explicit, order-bound reconciliations only: never infer a pack size from a SKU or price ratio.
  for (const line of original) {
    const mapping = unitMappings.filter(m => m.lineId === line.id && m.sku === line.sku);
    if (mapping.length !== 1) continue;
    const m = mapping[0];
    const local = (tx.items || []).filter((i: any) => i.code === line.sku);
    const rawLine = order.rawData.line_items.find((l: any) => String(l.id) === line.id);
    if (local.length === 1 && Number.isInteger(m.localQty) && m.localQty > 0 && Number.isInteger(m.remoteQty) && m.remoteQty > 0
      && m.remoteQty === line.qty && local[0].qty === m.localQty && cents(local[0].price) === m.localUnitPrice
      && cents(rawLine.price) === m.remoteUnitPrice && m.localUnitPrice > 0 && m.remoteUnitPrice > 0
      && m.localUnitPrice * m.localQty === m.remoteUnitPrice * m.remoteQty) line.localQty = m.localQty;
  }
  const cs = tx.carrierSettlement || {};
  const confirmation = [...(tx.deliveryAuditLog || [])].reverse().find((e: any) =>
    ['MANUAL_DELIVERY_CONFIRMATION', 'MANUAL_DELIVERY_UNDO'].includes(e.action));
  const manualDelivery = tx.type === 'مبيعات' && tx.deliverySource === 'MANUAL' && state === 'DELIVERED'
    && confirmation?.action === 'MANUAL_DELIVERY_CONFIRMATION' && confirmation.newStatus === 'DELIVERED'
    && !!confirmation.by && !!stamp(tx.deliveredAt) && stamp(confirmation.at) === stamp(tx.deliveredAt);
  const shipmentType = String(typeof raw.type === 'string' ? raw.type : raw.type?.value || (raw.type?.code === 10 ? 'SEND' : 'UNKNOWN')).toUpperCase().replace(/\s+/g, '_');
  return {
    transactionId: String(tx._id), orderId: String(tx.shopifyOrderId || ''), ref: String(tx.ref || '').replace(/^#+/, ''),
    cancelled: !!tx.cancelled, total: cents(tx.total), deposit: cents(tx.deposit), remaining: cents(tx.remaining),
    reversed: !!tx.codReversedAt || !!tx.cancellationDepositRefunds?.length || cs.status === 'reversed',
    codStatus: tx.codCollectionStatus || '', codCollected: cents(tx.codCollectedAmount), originalCod: cents(tx.bostaOriginalCod),
    wallet: { phase: cs.phase || '', status: cs.status || '', depositedAt: cs.walletDepositedAt || '',
      carrierCod: cents(cs.carrierCod), remaining: cents(cs.remaining), tracking: String(cs.trackingNumber || ''), shortfall: cents(cs.shortfall) },
    state, rawCode: Number.isFinite(code) ? code : null,
    exception: Number(raw.exceptionCode ?? raw.state?.exceptionCode ?? raw.currentStatus?.exceptionCode) || null,
    manualDelivery: !!manualDelivery,
    shipmentType: manualDelivery && shipmentType === 'UNKNOWN' && !tx.bostaOrderId && !tx.bostaTrackingNumber ? 'MANUAL_SEND' : shipmentType,
    tracking: String(tx.bostaTrackingNumber || '').trim(),
    eventAt: state === 'DELIVERED' ? stamp(tx.deliveredAt, raw.timeStamp, raw.currentStatus?.timestamp)
      : stamp(raw.timeStamp, raw.timestamp, raw.currentStatus?.timestamp, raw.state?.timestamp, raw.updatedAt),
    items: (tx.items || []).map((i: any) => ({ name: String(i.shopifyName || i.name || '').trim(), sku: String(i.code || ''), qty: Number(i.qty) })),
    original,
  };
}

export function shippingEvent(source: any): string | null {
  if (!['SEND', 'FXF_SEND', 'MANUAL_SEND'].includes(source.shipmentType) || source.cancelled) return null;
  if (source.shipmentType === 'MANUAL_SEND' && !source.manualDelivery) return null;
  if (source.state === 'DELIVERED') return 'DELIVERED';
  if (['RETURNED', 'CANCELLED', 'DELETED', 'CREATED'].includes(source.state)) return null;
  if (source.state === 'CUSTOMER_POSTPONED' || source.rawCode === 105 || source.rawCode === 102 || source.exception === 3) return 'DELAYED';
  if ([100, 101].includes(source.rawCode)) return 'FAILURE';
  const map: Record<string, string> = { PICKED_UP: 'CARRIER_PICKED_UP', IN_TRANSIT: 'IN_TRANSIT',
    OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY', DELIVERED: 'DELIVERED', FAILED_ATTEMPT: 'ATTEMPTED_DELIVERY' };
  // "Awaiting action" concerns return legs and cannot prove an attempted customer delivery.
  if (source.rawCode === 103) return null;
  return map[source.state] || null;
}

export function fullPaymentEvidence(s: any): boolean {
  if (s.cancelled || s.reversed || s.total <= 0 || ['RETURNED', 'CANCELLED', 'DELETED'].includes(s.state)) return false;
  if (!['SEND', 'FXF_SEND', 'MANUAL_SEND', 'UNKNOWN'].includes(s.shipmentType)) return false;
  if (s.remaining === 0 && s.deposit === s.total) return true;
  if (s.codStatus === 'Collected' && s.codCollected > 0 && s.deposit + s.codCollected === s.total) return true;
  const w = s.wallet;
  return s.state === 'DELIVERED' && !!s.tracking && w.tracking === s.tracking && !!w.depositedAt
    && ['wallet', 'bank'].includes(w.phase) && ['pending', 'settled'].includes(w.status)
    && w.shortfall === 0 && w.carrierCod > 0 && w.carrierCod === s.originalCod
    && w.carrierCod === s.remaining && s.deposit + w.carrierCod === s.total;
}

/** Financial and shipping state are independent. No cancellation/refund is inferred. */
export function planSync(s: any, remote: any, includePayments: boolean, known: any = {}): SyncPlan {
  known = known || {};
  const plan: SyncPlan = { actions: [], issues: [], warnings: [], sourceHash: digest(s), remoteHash: digest(remote) };
  const stop = (message: string) => { plan.issues.push(message); };
  if (!remote || remote.id !== `gid://shopify/Order/${s.orderId}` || remote.name.replace(/^#+/, '') !== s.ref) {
    stop('تعذر مطابقة الطلب في Shopify. تحقق من المعرّف وصلاحية الطلبات الأقدم من 60 يومًا.'); return plan;
  }
  if (remote.cancelledAt || cents(remote.totalRefundedSet?.shopMoney?.amount) > 0) {
    stop('الطلب ملغي أو به استرداد في Shopify؛ يلزم مراجعة قبل المزامنة.'); return plan;
  }
  if (remote.currentTotalPriceSet.shopMoney.currencyCode !== 'EGP') {
    stop(`عملة Shopify هي ${remote.currentTotalPriceSet.shopMoney.currencyCode} بينما النظام بالجنيه المصري؛ يلزم مراجعة العملة.`); return plan;
  }
  const event = shippingEvent(s);
  // Confirmed delivery describes the linked shipment, even when staff edited the local sale.
  // Keep Shopify's own lines for fulfillment; these differences never authorize a payment.
  const delivered = event === 'DELIVERED';
  const totalMatches = cents(remote.currentTotalPriceSet.shopMoney.amount) === s.total;
  if (!totalMatches) {
    const difference = `إجمالي النظام ${(s.total / 100).toFixed(2)} جنيه، وShopify ${Number(remote.currentTotalPriceSet.shopMoney.amount).toFixed(2)} جنيه.`;
    if (!delivered) { stop(`${difference} طابق تعديلات الأصناف والأسعار أولًا ثم أعد معاينة الشحن.`); return plan; }
    plan.warnings.push(`${difference} ستتم مزامنة التسليم فقط مع البيانات التشغيلية؛ لن يتم تعديل إجمالي Shopify أو تسجيل السداد حتى تسوية الفرق.`);
  }
  const lines = remote.lineItems.nodes.filter((l: any) => l.currentQuantity > 0);
  if (remote.lineItems.pageInfo.hasNextPage || remote.fulfillmentOrders.pageInfo.hasNextPage || !s.original.length) {
    stop('بيانات الأصناف الأصلية غير مكتملة؛ يلزم مطابقة الطلب.'); return plan;
  }
  const used = new Set<string>();
  let itemsMatch = true;
  for (const item of s.items) {
    const matches = s.original.filter((o: any) => (o.sku && o.sku === item.sku) || (!o.sku && o.name === item.name));
    if (matches.length !== 1 || used.has(matches[0].id) || (matches[0].localQty ?? matches[0].qty) !== item.qty) { itemsMatch = false; break; }
    used.add(matches[0].id);
    if (matches[0].localQty !== undefined && matches[0].localQty !== matches[0].qty)
      plan.warnings.push(`مطابقة وحدة البيع المعتمدة للصنف ${item.sku}: ${item.qty} قطعة في النظام = ${matches[0].qty} وحدة بيع في Shopify.`);
  }
  itemsMatch = itemsMatch && used.size === s.original.length;
  if (!itemsMatch) {
    if (delivered) plan.warnings.push('الأصناف أو الكميات المحلية مختلفة عن Shopify. ستتم مزامنة التسليم باستخدام سطور Shopify الحالية؛ لن يتم نقل تعديلات الأصناف أو الكميات أو تسجيل السداد قبل المطابقة.');
    else stop('الأصناف المحلية أو وحدات بيعها لا تطابق سطور Shopify الأصلية بشكل مؤكد.');
  }
  if (lines.length !== s.original.length || s.original.some((o: any) =>
    !lines.some((l: any) => l.id === `gid://shopify/LineItem/${o.id}` && l.currentQuantity === o.qty))) stop('كميات أو أصناف Shopify تغيرت؛ أعد المطابقة قبل الشحن.');
  if (plan.issues.length) return plan;

  if (!event && ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'CUSTOMER_POSTPONED'].includes(s.state)
    && s.shipmentType === 'UNKNOWN') {
    stop('حالة الشحن لم تُزامَن: بيانات الشحنة ناقصة، ولا يوجد تأكيد تسليم يدوي موثّق. راجع بيانات الشحن ثم أعد المعاينة.');
    return plan;
  }
  const active = remote.fulfillments.filter((f: any) => f.status !== 'CANCELLED');
  let fulfillment: any;
  if (event) {
    const withoutTracking = s.shipmentType === 'MANUAL_SEND' && s.manualDelivery && !s.tracking;
    if (!s.tracking && !withoutTracking) stop('لا يوجد رقم تتبع مؤكد للشحنة.');
    if (!s.eventAt || !Number.isFinite(Date.parse(s.eventAt)) || Date.parse(s.eventAt) > Date.now() + 300000 || Date.parse(s.eventAt) < Date.parse(remote.createdAt)) stop('وقت حدث الشحن غير متاح أو غير صالح؛ لا يمكن اختلاق تاريخ للشحنة.');
    if (active.length > 1) stop('الطلب يحتوي عدة شحنات؛ يلزم تحديد الشحنة والكميات يدويًا.');
    fulfillment = active[0];
    if (fulfillment) {
      if (fulfillment.status !== 'SUCCESS') stop('الشحنة الحالية ليست في حالة تسمح بتحديث آمن.');
      if (fulfillment.fulfillmentLineItems.pageInfo.hasNextPage || lines.some((l: any) =>
        !fulfillment.fulfillmentLineItems.nodes.some((fl: any) => fl.lineItem.id === l.id && fl.quantity === l.currentQuantity))) stop('الشحنة الحالية جزئية أو لا تطابق كميات الطلب.');
      if (!(withoutTracking && fulfillment.trackingInfo.length === 0) && !fulfillment.trackingInfo.some((t: any) => t.number === s.tracking)) {
        if (known.fulfillmentId === fulfillment.id && fulfillment.trackingInfo.length === 1 && fulfillment.trackingInfo[0].number === known.tracking) {
          plan.actions.push({ kind: 'tracking', label: 'تحديث رقم التتبع', input: { fulfillmentId: fulfillment.id, tracking: s.tracking } });
        } else stop('رقم تتبع Shopify مختلف؛ لن يتم استبداله تلقائيًا.');
      }
      if (fulfillment.events.pageInfo.hasNextPage) stop('سجل الشحنة طويل؛ يلزم مراجعة الأحداث قبل التحديث.');
      const events = fulfillment.events.nodes;
      const latest = [...events].sort((a: any, b: any) => Date.parse(b.happenedAt) - Date.parse(a.happenedAt))[0];
      if (latest?.status !== event && latest && Date.parse(latest.happenedAt) >= Date.parse(s.eventAt || '')) stop('Shopify يحتوي حدثًا أحدث أو متعارضًا؛ لن نرجع حالة الشحنة للخلف.');
      if (latest?.status === 'DELIVERED' && event !== 'DELIVERED') stop('الشحنة مسجلة تم التسليم؛ أي تصحيح أو مرتجع يحتاج مراجعة.');
      if (latest?.status !== event) plan.actions.push({ kind: 'event', label: `تحديث التوصيل: ${event}`, input: { fulfillmentId: fulfillment.id, status: event, happenedAt: s.eventAt } });
    } else {
      const fos = remote.fulfillmentOrders.nodes;
      if (fos.length !== 1 || !['OPEN', 'IN_PROGRESS'].includes(fos[0]?.status) || !fos[0]?.supportedActions.some((a: any) => a.action === 'CREATE_FULFILLMENT')) stop('تنفيذ الشحن يحتاج مراجعة موقع المخزون أو حالة طلب التنفيذ.');
      else {
        const fo = fos[0];
        // Shopify retains removed order-edit lines with zero remaining quantity.
        const available = fo.lineItems.nodes.filter((fl: any) => fl.remainingQuantity > 0);
        if (fo.lineItems.pageInfo.hasNextPage || available.length !== lines.length || lines.some((l: any) =>
          !available.some((fl: any) => fl.lineItem.id === l.id && fl.remainingQuantity === l.currentQuantity))) stop('الكميات المتاحة للتنفيذ لا تطابق كامل الطلب.');
        else plan.actions.push({ kind: 'fulfill', label: withoutTracking ? 'تسجيل تنفيذ الطلب المسلّم يدويًا بدون رقم تتبع' : 'تسجيل الشحن ورقم التتبع (بدون إشعار إنشاء الشحنة)', input: {
          notifyCustomer: false, ...(!withoutTracking ? { trackingInfo: { company: 'Bosta', number: s.tracking, url: `https://bosta.co/tracking/${encodeURIComponent(s.tracking)}` } } : {}),
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: available.map((l: any) => ({ id: l.id, quantity: l.remainingQuantity })) }],
        } });
      }
      plan.actions.push({ kind: 'event', label: `تحديث التوصيل: ${event}`, input: { status: event, happenedAt: s.eventAt } });
    }
  } else if (s.state) plan.warnings.push(s.shipmentType === 'UNKNOWN'
    ? 'نوع الشحنة غير مؤكد؛ سيتم تحديث البيانات التشغيلية فقط لحين مراجعة بيانات شركة الشحن.'
    : 'هذه الحالة تُحفظ في بيانات الطلب التشغيلية؛ لا تنشئ إلغاءً أو استردادًا ماليًا.');

  if (includePayments && (!totalMatches || !itemsMatch) && remote.displayFinancialStatus !== 'PAID') {
    plan.warnings.push('لم تتم مزامنة السداد: يلزم مطابقة إجمالي وأصناف الطلب مع Shopify أولًا، حتى لو كان التحصيل المحلي مكتملًا.');
  } else if (includePayments && fullPaymentEvidence(s) && remote.displayFinancialStatus !== 'PAID') {
    const outstanding = cents(remote.totalOutstandingSet.shopMoney.amount);
    if (!remote.canMarkAsPaid || outstanding !== s.total || remote.transactions.length >= 100 || remote.transactions.some((t: any) =>
      (t.kind === 'AUTHORIZATION' && !['FAILURE', 'ERROR'].includes(t.status)) || (t.status === 'SUCCESS' && ['CAPTURE', 'SALE'].includes(t.kind)))) {
      stop('يوجد دفع جزئي أو تفويض أو اختلاف مالي في Shopify؛ يلزم تسوية يدوية.');
    } else plan.actions.push({ kind: 'payment', label: `تسجيل سداد كامل: ${(s.total / 100).toFixed(2)} EGP`, input: { id: remote.id, expectedOutstanding: outstanding } });
  } else if (includePayments && remote.displayFinancialStatus !== 'PAID') plan.warnings.push('التحصيل الكامل غير مؤكد؛ ستظل حالة الدفع المالية في Shopify كما هي.');

  // This namespace is ERP-owned. Includes partial deposits as information, never as financial transactions.
  const metadata = JSON.stringify({ version: 1, shipping: s.cancelled ? 'ORDER_CANCELLED_LOCALLY' : s.state || 'PREPARING',
    tracking: s.tracking, depositEGP: s.deposit / 100, remainingERP: s.remaining / 100, customerPaidInFull: fullPaymentEvidence(s),
    carrierSettlement: s.wallet.phase || s.wallet.status || null });
  if (remote.erpStatus?.value !== metadata) plan.actions.push({ kind: 'metadata', label: 'تحديث الحالة التشغيلية والعربون في بيانات الطلب', input: {
    ownerId: remote.id, namespace: 'soulia', key: 'erp_sync', type: 'json', value: metadata, compareDigest: remote.erpStatus?.compareDigest || null,
  } });
  if (plan.issues.length) plan.actions = [];
  return plan;
}
