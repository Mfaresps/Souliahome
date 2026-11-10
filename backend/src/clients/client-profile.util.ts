/** Customer analytics are derived from orders, never from payment status or name alone. */
import { cancelReasonDef } from '../shared/cancellation.constants';
import { createHash } from 'crypto';
export const clientCode = (key: string) => 'CL-' + createHash('sha256').update(key).digest('hex').slice(0, 20).toUpperCase();
export function clientIdentity(key: string, name: string) {
  const code = clientCode(key);
  const slug = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'client';
  return { code, slug, profilePath: '#clients/profile/' + encodeURIComponent(slug) + '~' + code };
}
export type ClientRow = Record<string, any>;
const text = (v: unknown) => String(v ?? '').trim();
const amount = (v: unknown) => Math.round(Math.max(0, Number(v) || 0) * 100);
export function clientPhone(value: unknown): string {
  let n = text(value).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (/^01[0125]\d{8}$/.test(n)) n = '2' + n;
  if (/^1[0125]\d{8}$/.test(n)) n = '20' + n;
  return n.length >= 8 && n.length <= 15 ? n : '';
}
export function clientEmail(value: unknown): string {
  const email = text(value).toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
export function shopifyContact(data: any) {
  return {
    customerEmail: [data?.customer?.email, data?.contact_email, data?.email].map(clientEmail).find(Boolean) || '',
    shopifyCustomerId: text(data?.customer?.id),
  };
}
const dateOf = (r: ClientRow) => {
  const value = r.shopifyCreatedAt || r.transactionDate || r.date || r.createdAt;
  return value instanceof Date ? value.toISOString() : text(value);
};
const cancelled = (r: ClientRow) => !!r.cancelled || ['ملغي', 'ملغى', 'cancelled', 'canceled'].includes(text(r.payStatus).toLowerCase());
const delivered = (r: ClientRow) => !!r.deliveredAt || ['delivered', 'تم التسليم', 'تم تسليم الطلب'].includes(text(r.pickupStatus).toLowerCase())
  || text(r.bostaShippingStatus).toLowerCase() === 'delivered' || text(r.bostaStatus).toUpperCase() === 'DELIVERED';
const failed = (r: ClientRow) => !['reshipped'].includes(r.shipIssueState)
  && (!!r.failedDelivery || ['RETURNED', 'RTO', 'DELIVERY_FAILED'].includes(text(r.bostaStatus).toUpperCase())
    || text(r.bostaShippingStatus).toLowerCase() === 'returned');
const active = (r: ClientRow) => r._source === 'shopify' ? r.status === 'pending'
  : r.shipIssueState === 'reshipped' || ['pending', 'preparing', 'ready', 'shipped'].includes(text(r.pickupStatus).toLowerCase())
    || ['created', 'pickedup', 'intransit', 'outfordelivery'].includes(text(r.bostaShippingStatus).toLowerCase());
const excludedOrders = new Set(['duplicate-order', 'test-order', 'data-entry-error']);

export function buildClientProfiles(transactions: ClientRow[], shopify: ClientRow[], returns: ClientRow[] = [], followups: ClientRow[] = []) {
  const txs = transactions.filter(r => r.type === 'مبيعات');
  const orders = new Map(shopify.map(r => [text(r.shopifyId), r]));
  const orderIds = new Map(shopify.map(r => [text(r._id), r]));
  const linked = new Set<string>();
  const all: ClientRow[] = txs.map(tx => {
    const linkedId = text(tx.shopifyOrderId);
    const order = linkedId ? orders.get(linkedId) || orderIds.get(linkedId) : undefined;
    if (order) linked.add(text(order._id));
    return { ...(order || {}), ...tx, _source: 'transaction', _orderId: order ? text(order._id) : '',
      customerEmail: tx.customerEmail || order?.customerEmail || '',
      shopifyCustomerId: tx.shopifyCustomerId || order?.shopifyCustomerId || '' };
  });
  shopify.filter(r => !linked.has(text(r._id))).forEach(r => all.push({ ...r, _source: 'shopify', _orderId: text(r._id) }));

  // Legacy contacts attach to a Shopify identity only when the contact has one owner.
  // A shared family number must never collapse two different Shopify customers.
  const owners = new Map<string, Set<string>>();
  for (const row of all) {
    const id = text(row.shopifyCustomerId);
    if (!id) continue;
    for (const contact of [clientPhone(row.phone), clientEmail(row.customerEmail)].filter(Boolean)) {
      if (!owners.has(contact)) owners.set(contact, new Set());
      owners.get(contact)!.add(id);
    }
  }
  const groups = new Map<string, ClientRow[]>();
  for (const row of all) {
    const phone = clientPhone(row.phone), email = clientEmail(row.customerEmail);
    const phoneOwners = owners.get(phone), emailOwners = owners.get(email);
    const phoneOwner = phoneOwners?.size === 1 ? [...phoneOwners][0] : '';
    const emailOwner = emailOwners?.size === 1 ? [...emailOwners][0] : '';
    const uniqueOwner = phoneOwners && phoneOwners.size > 1 || phoneOwner && emailOwner && phoneOwner !== emailOwner
      ? '' : phoneOwner || emailOwner;
    const id = text(row.shopifyCustomerId) || uniqueOwner;
    const key = id ? 's:' + id : phone ? 'p:' + phone : email ? 'e:' + email : row._source + ':' + text(row._id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const returnsByTx = new Map<string, ClientRow[]>();
  for (const row of returns) {
    const id = text(row.originalTransactionId);
    if (!returnsByTx.has(id)) returnsByTx.set(id, []);
    returnsByTx.get(id)!.push(row);
  }
  const followupsByLink = new Map<string, ClientRow[]>();
  for (const f of followups) {
    if (f.cancelled || f.orderOutcome || f.reason !== 'عملية تأكيد الطلب' || f.status !== 'العميل ألغى الطلب' || f.autoSource === 'shipping-issue') continue;
    for (const link of [f.transactionId ? 't:' + text(f.transactionId) : '', f.shopifyOrderId ? 's:' + text(f.shopifyOrderId) : ''].filter(Boolean)) {
      if (!followupsByLink.has(link)) followupsByLink.set(link, []);
      followupsByLink.get(link)!.push(f);
    }
  }
  return [...groups].map(([key, rows]) => {
    rows.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    const txIds = new Set(rows.filter(r => r._source === 'transaction').map(r => text(r._id)));
    const shopifyIds = new Set(rows.flatMap(r => [text(r.shopifyOrderId), text(r.shopifyId), text(r._orderId)]).filter(Boolean));
    const cancellationFollowups = [...new Set([...txIds].flatMap(id => followupsByLink.get('t:' + id) || [])
      .concat([...shopifyIds].flatMap(id => followupsByLink.get('s:' + id) || [])))];
    const byTx = new Map(cancellationFollowups.filter(f => f.transactionId).map(f => [text(f.transactionId), f]));
    const byShopify = new Map(cancellationFollowups.filter(f => f.shopifyOrderId).map(f => [text(f.shopifyOrderId), f]));
    const history = rows.map(r => {
      const fu = byTx.get(text(r._id)) || byShopify.get(text(r._orderId)) || byShopify.get(text(r.shopifyId));
      const wasDelivered = delivered(r);
      const isCancelled = cancelled(r) || !!fu;
      const isFailed = !wasDelivered && failed(r);
      const outcome = wasDelivered ? 'delivered' : isFailed ? 'failed' : isCancelled
        ? (r._source === 'shopify' ? 'cancelledBefore' : 'cancelledAfter') : active(r) ? 'active' : 'unknown';
      const excluded = excludedOrders.has(r.cancelReasonCode);
      const customerCaused = isFailed ? ['refused', 'unreachable', 'bad-address'].includes(r.failedDelivery?.outcome)
        : isCancelled && cancelReasonDef(r.cancelReasonCode)?.group === 'customer';
      return { id: text(r._id), orderId: text(r._orderId), shopifyId: text(r.shopifyOrderId || r.shopifyId), source: r._source, ref: text(r.ref), date: dateOf(r),
        total: amount(r.total) / 100, paid: !isCancelled && r._source === 'transaction' ? amount(r.deposit) / 100 : 0,
        remaining: !isCancelled && r._source === 'transaction' ? amount(r.remaining) / 100 : 0,
        outcome, excluded, customerCaused, fake: r.cancelReasonCode === 'fake-order',
        reason: text(r.cancelReason || r.failedDelivery?.note || (r.failedDelivery?.outcome ? r.failedDelivery.outcome : '') || fu?.resolution),
        reasonCode: text(r.cancelReasonCode), failureCode: text(r.failedDelivery?.outcome),
        payStatus: text(r.payStatus), confirmedDelivery: wasDelivered,
      };
    });
    const actual = history.filter(r => !r.excluded);
    const recent = actual.filter(r => !['active', 'unknown'].includes(r.outcome)).slice(0, 10);
    const count = (outcome: string) => actual.filter(r => r.outcome === outcome).length;
    const stats = { orders: actual.length, invoices: actual.filter(r => r.source === 'transaction').length,
      unregisteredOrders: actual.filter(r => r.source === 'shopify').length,
      delivered: count('delivered'), failed: count('failed'),
      cancelledBefore: count('cancelledBefore'), cancelledAfter: count('cancelledAfter'), active: count('active'), unknown: count('unknown'),
      customerIssues: actual.filter(r => r.customerCaused).length, fake: actual.filter(r => r.fake).length,
      recentCustomerIssues: recent.filter(r => r.customerCaused).length, recentOrders: recent.length,
      deliveryRate: null as number | null, returns: 0 };
    const resolved = stats.delivered + stats.failed;
    if (resolved) stats.deliveryRate = Math.round(stats.delivered / resolved * 100);
    const approvedReturns = [...txIds].flatMap(id => returnsByTx.get(id) || []).filter(r => r.status === 'معتمد' && !r.reversedAt);
    stats.returns = new Set(approvedReturns.map(r => text(r.originalTransactionId))).size;
    const moneyRows = rows.filter(r => r._source === 'transaction' && !cancelled(r));
    const money = { total: moneyRows.reduce((n, r) => n + amount(r.total), 0) / 100,
      paid: moneyRows.reduce((n, r) => n + amount(r.deposit), 0) / 100,
      remaining: moneyRows.reduce((n, r) => n + amount(r.remaining), 0) / 100,
      returns: approvedReturns.reduce((n, r) => n + amount(r.total), 0) / 100 };
    // Evidence thresholds are explicit and intentionally conservative; no opaque risk score.
    const assessment = stats.fake ? 'documentedFake'
      : stats.recentCustomerIssues >= 2 && stats.recentCustomerIssues / stats.recentOrders >= 0.4 ? 'depositRecommended'
      : stats.recentCustomerIssues ? 'confirmFirst' : stats.delivered >= 5 && resolved >= 5 && stats.deliveryRate! >= 90 ? 'valued'
      : stats.delivered >= 3 && stats.deliveryRate! >= 80 ? 'reliable' : 'insufficient';
    const addresses = new Map<string, any>();
    for (const r of rows) {
      const address = text(r.shippingAddress), city = text(r.shippingCity), gov = text(r.shippingGov);
      if (!address && !city && !gov) continue;
      const fingerprint = [address, city, gov].join('|').replace(/\s+/g, ' ').toLowerCase();
      if (!addresses.has(fingerprint)) addresses.set(fingerprint, { address, city, gov, date: dateOf(r), id: text(r._id), source: r._source });
    }
    const phones = [...new Map<string, string>(rows.filter(r => clientPhone(r.phone)).map(r => [clientPhone(r.phone), text(r.phone)] as [string, string]).reverse()).values()];
    const emails = [...new Set(rows.map(r => clientEmail(r.customerEmail)).filter(Boolean))];
    const name = text(rows.find(r => text(r.client))?.client) || phones[0] || emails[0] || '—';
    return { key, name, ...clientIdentity(key, name),
      phone: phones[0] || '', phones, email: emails[0] || '', emails, firstOrder: dateOf(rows[rows.length - 1]),
      lastOrder: dateOf(rows[0]), stats, money, assessment, addresses: [...addresses.values()], history,
      returns: approvedReturns.map(r => ({ id: text(r.returnTxId), ref: text(r.returnTxRef || r.originalRef),
        date: text(r.approvedAt || r.createdAt), total: amount(r.total) / 100, reason: text(r.reasonDetails || r.reason),
        kind: text(r.requestKind) })) };
  });
}
