// The Movements page reads a bounded page. These predicates mirror its former
// browser-side rules, including the intentionally permissive undated rows.
export type MovementsState = {
  page?: number; limit?: number; search?: string; type?: string; status?: string;
  sort?: string; dateFrom?: string; dateTo?: string; dateField?: string;
  amountMin?: string; amountMax?: string; discountOnly?: boolean;
  discountCode?: string; tag?: string; showExcluded?: boolean;
  excludedIds?: string[]; operation?: string[]; employee?: string[];
  method?: string[]; drawerStatus?: string[]; bosta?: string[];
  pickup?: string[]; recentUpdates?: Record<string, number>;
};

const SALES = 'مبيعات', PURCHASE = 'مشتريات', RETURN = 'مرتجع';
const PURCHASE_RETURN = 'مرتجع مشتريات', SALES_RETURN = 'مرتجع مبيعات';
const PENDING = 'معلق', COMPLETED = 'مكتمل', CANCELLED = 'ملغي';
const norm = (value: unknown) => String(value || '').normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670\u0610-\u061A]/g, '')
  .replace(/[\u0622\u0623\u0625]/g, '\u0627').replace(/\u0649/g, '\u064A')
  .replace(/\u0640/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const n = (value: unknown) => Number(value) || 0;
const dateText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value || '');
const day = (value: unknown) => dateText(value).slice(0, 10);
const refNumber = (value: unknown) => Number(String(value || '').replace(/\D/g, '')) || 0;
const baseRef = (value: unknown) => String(value || '').trim().replace(/-RET$/i, '').replace(/-EXC$/i, '');
const pending = (value: unknown) => value === PENDING;
const completed = (value: unknown) => value === COMPLETED || value === 'مكتملة';
const cancelled = (value: unknown) => ['ملغي', 'تم رفض المعاملة من الخزنة', 'تم رفض الحركة من الخزنة'].includes(String(value));

function exchangeReturn(tx: any): boolean {
  return tx.type === RETURN && (tx.afterSales?.kind === 'exchange' ||
    tx.afterSales?.shipments?.[tx.afterSales?.caseId]?.kind === 'exchange' ||
    tx.afterSales?.role === 'return' && (tx.afterSalesEvents || []).some((e: any) => e.kind === 'exchange' || !!e.replacementRef) ||
    (tx.notes || '').startsWith('استبدال —'));
}
function exchangeSale(tx: any): boolean {
  return tx.type === SALES && (tx.afterSales?.role === 'replacement' ||
    (tx.ref || '').endsWith('-EXC') || (tx.notes || '').includes('بيع استبدال'));
}
function afterSalesKind(tx: any, kind: string): boolean {
  if (kind === 'return' && [RETURN, SALES_RETURN].includes(tx.type) && !exchangeReturn(tx) ||
      kind === 'exchange' && (exchangeReturn(tx) || exchangeSale(tx))) return true;
  if (tx.type !== SALES || tx.afterSales?.role === 'replacement') return false;
  if (Object.values(tx.afterSales?.shipments || {}).some((sh: any) => sh.kind === kind)) return true;
  return (tx.afterSalesEvents || []).some((e: any) => e.kind === kind || !e.kind && kind === 'exchange' && !!e.replacementRef);
}
function compactRef(tx: any): string {
  const raw = String(tx.ref || '').trim();
  const match = /^(#?RT-\d{4}-)(\d+)$/i.exec(raw);
  if (match) return match[1] + match[2].replace(/^0+(?=\d)/, '');
  const ex = /^(#?)(\d{4})8(\d{6,})$/.exec(raw);
  return ex && exchangeSale(tx) ? `${ex[1]}EX-${ex[2]}-${ex[3].replace(/^0+(?=\d)/, '')}` : raw;
}
function orderStateKey(tx: any): string {
  const code = String(tx.bostaStatus || '').trim().toUpperCase();
  const shipment = !!(tx.bostaOrderId || tx.afterSales?.shipments?.[tx.afterSales?.caseId]?.deliveryId);
  if (tx.cancelled || ['ملغي', 'محذوف'].includes(tx.payStatus)) return 'CANCELLED';
  if (code === 'DELIVERED') return 'DELIVERED';
  if (tx.deliverySource === 'MANUAL') return 'Shipped';
  if (shipment && !['DELETED', 'VALIDATION_ERROR'].includes(code)) return !code || code === 'CREATED' ? 'Ready' : code;
  const key = tx.pickupStatus || 'Pending';
  return key === 'Picked-Up' ? 'Ready' : key === 'Delivered' ? 'DELIVERED' : key;
}
function unshippedStage(tx: any): string {
  const code = String(tx.bostaStatus || '').trim().toUpperCase();
  if (code === 'DELIVERED') return 'Delivered';
  const tracked = !!(tx.bostaOrderId || tx.afterSales?.shipments?.[tx.afterSales?.caseId]?.deliveryId)
    && !['VALIDATION_ERROR', 'DELETED'].includes(code);
  if (tx.deliverySource === 'MANUAL') return 'Shipped';
  if (tracked) return !code || code === 'CREATED' ? 'Ready' : 'Shipped';
  return tx.pickupStatus || 'Pending';
}
function priorityScore(tx: any, recent: Record<string, number>): number {
  const ts = recent[String(tx._id)];
  if (ts && Date.now() - ts <= 5 * 60_000) return 1e12 + ts;
  if (tx.cancelled || cancelled(tx.payStatus)) return 0;
  const b = tx.bostaStatus || '', p = tx.pickupStatus || 'Pending';
  const active = ['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'CUSTOMER_POSTPONED'].includes(b)
    || ['Ready', 'Pending', 'Preparing', 'Shipped'].includes(p);
  if (completed(tx.payStatus) && !active) return 0;
  let base = b === 'CREATED' || ['Ready', 'Pending'].includes(p) ? 100
    : b === 'IN_TRANSIT' ? 90 : b === 'OUT_FOR_DELIVERY' ? 80
    : b === 'PICKED_UP' || ['Preparing', 'Shipped'].includes(p) ? 60
    : b === 'DELIVERED' || p === 'Delivered' ? 0 : pending(tx.payStatus) ? 40 : 20;
  if (pending(tx.payStatus) || tx.cancelRequest?.status === PENDING ||
      (exchangeSale(tx) && /-EXC$/i.test(String(tx.ref || '')) && n(tx.remaining) > 0 && pending(tx.payStatus)) ||
      b === 'DELIVERED' && n(tx.remaining) > 0 && tx.codCollectionStatus !== 'Collected') base += 30;
  return base;
}
function sortTransactions(rows: any[], sort: string, recent: Record<string, number>): any[] {
  const copy = rows.slice();
  const dateCmp = (a: any, b: any) => dateText(a.createdAt || a.date).localeCompare(dateText(b.createdAt || b.date));
  const refCmp = (a: any, b: any) => refNumber(a.ref) - refNumber(b.ref);
  const numeric = (a: any, b: any) => n(a.total) - n(b.total);
  const client = (a: any, b: any) => String(a.client || '').localeCompare(String(b.client || ''), 'ar');
  copy.sort((a, b) => {
    switch (sort) {
      case 'priority-desc': return priorityScore(b, recent) - priorityScore(a, recent) || dateCmp(b, a) || refCmp(b, a);
      case 'date-asc': return dateCmp(a, b) || refCmp(a, b);
      case 'amount-desc': return numeric(b, a);
      case 'amount-asc': return numeric(a, b);
      case 'client-desc': return client(b, a);
      case 'client-asc': return client(a, b);
      case 'ref-desc': return refCmp(b, a);
      case 'ref-asc': return refCmp(a, b);
      default: return dateCmp(b, a) || refCmp(b, a);
    }
  });
  return copy;
}
function filterTransactions(rows: any[], state: MovementsState): any[] {
  const raw = String(state.search || '');
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const inlineTags = parts.filter(p => p.startsWith('#') && !/^#\d+$/.test(p)).map(p => p.slice(1).toLowerCase()).filter(Boolean);
  const textParts = parts.filter(p => !p.startsWith('#') || /^#\d+$/.test(p));
  const refLike = (p: string) => /^#?\d+$/.test(p) || /^[\w\d\-/]{3,}$/.test(p) && !/^[\u0600-\u06ff]/.test(p);
  const refMode = textParts.length === 1 && /^#?\d+$/.test(textParts[0]) || textParts.length >= 2 && textParts.every(refLike);
  const refTokens = refMode ? textParts.map(p => norm(p.replace(/^#/, ''))) : [];
  const tokens = refMode ? [] : norm(textParts.join(' ')).split(/\s+/).filter(Boolean);
  const set = (v?: string[]) => new Set(Array.isArray(v) ? v : []);
  const employees = set(state.employee), methods = set(state.method), statuses = set(state.drawerStatus);
  const operations = set(state.operation), pickups = set(state.pickup), bostas = set(state.bosta);
  const excluded = set(state.excludedIds), from = state.dateFrom || '', to = state.dateTo || '';
  return rows.filter(tx => {
    const d = day(state.dateField === 'createdAt' ? tx.createdAt || tx.date : tx.transactionDate || tx.date);
    if (from && d && d < from || to && d && d > to) return false;
    if (state.type === RETURN) { if (![RETURN, SALES_RETURN, PURCHASE_RETURN].includes(tx.type)) return false; }
    else if (state.type === 'استرجاع') { if (!afterSalesKind(tx, 'return')) return false; }
    else if (state.type === 'استبدال') { if (!afterSalesKind(tx, 'exchange')) return false; }
    else if (state.type && state.type !== 'all' && !state.status && tx.type !== state.type) return false;
    if (state.status && tx.payStatus !== state.status) return false;
    if (state.amountMin !== '' && state.amountMin != null && n(tx.total) < Number(state.amountMin)) return false;
    if (state.amountMax !== '' && state.amountMax != null && n(tx.total) > Number(state.amountMax)) return false;
    if (employees.size && !employees.has(String(tx.employee || '').trim())) return false;
    if (methods.size && ![tx.depMethod, tx.collectMethod, tx.payment].some(v => methods.has(String(v || '').trim()))) return false;
    if (statuses.size && !statuses.has(tx.cancelled ? CANCELLED : tx.payStatus || '')) return false;
    if (operations.size && ![...operations].some(kind => afterSalesKind(tx, kind))) return false;
    if (pickups.size && (tx.type !== SALES || !pickups.has(orderStateKey(tx) === 'DELIVERED' ? 'Delivered' : orderStateKey(tx)))) return false;
    if (bostas.size && ![tx.bostaStatus || '', ...Object.values(tx.afterSales?.shipments || {}).map((sh: any) => sh.status)].some(v => bostas.has(String(v || '').trim()))) return false;
    if (refTokens.length) {
      const ref = String(tx.ref || '');
      const blob = norm([ref, ref.replace(/^#/, ''), baseRef(ref), compactRef(tx)].join(' '));
      if (!refTokens.some(token => blob.includes(token))) return false;
    }
    if (tokens.length) {
      const blob = norm([tx.client, tx.ref, baseRef(tx.ref), compactRef(tx), tx.phone, tx.notes, tx.type,
        tx.employee, tx.bostaTrackingNumber, ...Object.values(tx.afterSales?.shipments || {}).flatMap((sh: any) => [sh.caseRef, sh.trackingNumber, sh.status, sh.label])].join(' '));
      if (!tokens.every(token => blob.includes(token))) return false;
    }
    if (inlineTags.length && !inlineTags.every(token => (tx.tags || []).some((tag: string) => tag.toLowerCase().includes(token)))) return false;
    if (state.discountOnly && !(n(tx.discount) > 0)) return false;
    if (state.discountCode && !String(tx.discountCode || '').toLowerCase().includes(state.discountCode.toLowerCase())) return false;
    if (!state.showExcluded && excluded.has(String(tx._id))) return false;
    return true;
  });
}

function filterReturns(rows: any[], state: MovementsState): any[] {
  const from = state.dateFrom || '', to = state.dateTo || '';
  const tokens = norm(state.search || '').split(/\s+/).filter(Boolean);
  const set = (v?: string[]) => new Set(Array.isArray(v) ? v : []);
  const ops = set(state.operation), emps = set(state.employee), bostas = set(state.bosta), statuses = set(state.drawerStatus);
  return rows.filter(r => {
    const d = day(r.createdAt);
    if (from && d && d < from || to && d && d > to) return false;
    if (state.pickup?.length) return false;
    if (ops.size && !ops.has(r.requestKind === 'exchange' ? 'exchange' : 'return')) return false;
    if (state.amountMin !== '' && state.amountMin != null && n(r.total) < Number(state.amountMin)) return false;
    if (state.amountMax !== '' && state.amountMax != null && n(r.total) > Number(state.amountMax)) return false;
    if (emps.size && !emps.has(String(r.requestedBy || '').trim())) return false;
    if (state.method?.length || state.discountOnly || state.discountCode) return false;
    if (bostas.size && !bostas.has(String(r.workflow?.shipment?.carrierStatus || '').trim())) return false;
    const st = r.status === 'معتمد' ? COMPLETED : r.status === 'مرفوض' ? CANCELLED : PENDING;
    if (statuses.size && !statuses.has(st)) return false;
    if ([SALES, PURCHASE, RETURN].includes(state.type || '')) return false;
    if (state.type === 'استرجاع' && r.requestKind === 'exchange' || state.type === 'استبدال' && r.requestKind !== 'exchange') return false;
    if (state.status === PENDING && r.status !== PENDING || state.status === COMPLETED && r.status !== 'معتمد' || state.status === CANCELLED && r.status !== 'مرفوض') return false;
    if (tokens.length && !tokens.every(t => norm([r.client, r.originalRef, r.requestedBy, r.phone, r.reason, r.reasonDetails].join(' ')).includes(t))) return false;
    return true;
  });
}

function series(lo: string, hi: string, rows: [string, number][]) {
  const t0 = Date.parse(lo + 'T00:00:00Z'), t1 = Date.parse(hi + 'T00:00:00Z');
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null;
  const span = Math.round((t1 - t0) / 86_400_000) + 1, width = Math.max(1, Math.ceil(span / 24));
  const count = Math.ceil(span / width);
  const pts = Array.from({ length: count }, (_, i) => ({
    from: new Date(t0 + i * width * 86_400_000).toISOString().slice(0, 10),
    to: new Date(t0 + Math.min(span - 1, (i + 1) * width - 1) * 86_400_000).toISOString().slice(0, 10),
    v: 0, n: 0,
  }));
  let total = 0, records = 0;
  for (const [date, value] of rows) {
    const amount = n(value), td = Date.parse(date + 'T00:00:00Z');
    if (!amount || !Number.isFinite(td)) continue;
    const i = Math.max(0, Math.min(count - 1, Math.floor(Math.round((td - t0) / 86_400_000) / width)));
    pts[i].v += amount; pts[i].n++; total += amount; records++;
  }
  return { pts, total, width, records };
}

export function buildMovementsPage(transactions: any[], returns: any[], supplierReturns: any[], state: MovementsState) {
  const allCount = transactions.length;
  const tabCounts = { all: allCount, sales: 0, purchase: 0, returns: 0 };
  const facets: Record<string, Record<string, number>> = { employee: {}, method: {}, status: {}, operation: {}, bosta: {}, pickup: {}, tags: {} };
  const inc = (key: string, value: unknown) => { const v = String(value || '').trim(); if (v) facets[key][v] = (facets[key][v] || 0) + 1; };
  for (const tx of transactions) {
    if (tx.type === SALES) tabCounts.sales++;
    if (tx.type === PURCHASE) tabCounts.purchase++;
    if ([RETURN, SALES_RETURN, PURCHASE_RETURN].includes(tx.type)) tabCounts.returns++;
    inc('employee', tx.employee);
    for (const m of [tx.depMethod, tx.collectMethod, tx.payment]) inc('method', m);
    inc('status', tx.cancelled ? CANCELLED : tx.payStatus);
    for (const kind of ['return', 'exchange']) if (afterSalesKind(tx, kind)) inc('operation', kind);
    inc('bosta', tx.bostaStatus);
    if (tx.type === SALES) inc('pickup', orderStateKey(tx) === 'DELIVERED' ? 'Delivered' : orderStateKey(tx));
    for (const tag of tx.tags || []) inc('tags', tag);
  }
  for (const r of returns) inc('operation', r.requestKind === 'exchange' ? 'exchange' : 'return');
  const data = sortTransactions(filterTransactions(transactions, state), state.sort || 'date-desc', state.recentUpdates || {});
  const retRows = filterReturns(returns, state);
  const active = data.filter(tx => !tx.cancelled);
  const sales = active.filter(tx => tx.type === SALES);
  const purchases = active.filter(tx => tx.type === PURCHASE);
  const salesReturns = active.filter(tx => [RETURN, SALES_RETURN].includes(tx.type));
  const settledReturns = supplierReturns.filter(r => r.status === COMPLETED && !r.reversal &&
    !(state.dateFrom && day(r.returnDate || r.createdAt) && day(r.returnDate || r.createdAt) < state.dateFrom) &&
    !(state.dateTo && day(r.returnDate || r.createdAt) && day(r.returnDate || r.createdAt) > state.dateTo));
  const shipBilled = sales.reduce((sum, tx) => sum + n(tx.shipCost), 0);
  const shipLoss = sales.reduce((sum, tx) => sum + Math.max(0, n(tx.actualShipCost) - n(tx.shipCost)), 0);
  const txDay = (tx: any) => day(state.dateField === 'createdAt'
    ? tx.createdAt || tx.date || tx.transactionDate : tx.transactionDate || tx.date || tx.createdAt);
  const dates = active.map(txDay).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  settledReturns.forEach(r => { const d = day(r.returnDate || r.createdAt); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d); });
  const lo = state.dateFrom || dates.reduce((a, b) => !a || b < a ? b : a, '');
  const hi = state.dateTo || dates.reduce((a, b) => !a || b > a ? b : a, '');
  const purchased = purchases.reduce((sum, tx) => sum + n(tx.total), 0);
  const returned = settledReturns.reduce((sum, r) => sum + n(r.total), 0);
  const kpi = {
    sales: sales.reduce((sum, tx) => sum + Math.max(0, n(tx.total) - n(tx.shipCost)), 0) - shipLoss + sales.reduce((sum, tx) => sum + n(tx.shipSaving), 0),
    shipping: shipBilled, shipLoss, purchases: Math.max(0, purchased - returned),
    returns: salesReturns.reduce((sum, tx) => sum + n(tx.total), 0),
    remainingCollection: sales.reduce((sum, tx) => sum + n(tx.remaining), 0),
    remainingSupplier: purchases.reduce((sum, tx) => sum + n(tx.remaining), 0),
    pending: active.filter(tx => pending(tx.payStatus)).length,
    completed: active.filter(tx => tx.payStatus === COMPLETED).length,
    cancelled: data.filter(tx => tx.cancelled || tx.payStatus === CANCELLED).length,
    delivered: active.filter(tx => tx.bostaStatus === 'DELIVERED').length,
    mini: { sales: sales.length, purchases: purchases.length,
      returns: active.filter(tx => [RETURN, SALES_RETURN, PURCHASE_RETURN].includes(tx.type)).length },
    series: {
      sales: series(lo, hi, sales.map(tx => [txDay(tx), Math.max(0, n(tx.total) - n(tx.shipCost)) - Math.max(0, n(tx.actualShipCost) - n(tx.shipCost))])),
      purchases: series(lo, hi, [...purchases.map(tx => [txDay(tx), n(tx.total)] as [string, number]),
        ...settledReturns.map(r => [day(r.returnDate || r.createdAt), -n(r.total)] as [string, number])]),
      remainingCollection: series(lo, hi, sales.map(tx => [txDay(tx), n(tx.remaining)])),
    },
  };
  let merged: { k: 'tx' | 'ret'; tx?: any; r?: any; sk?: string; ref?: number }[];
  if (!state.sort || state.sort === 'date-desc') {
    merged = [...data.map(tx => ({ k: 'tx' as const, tx, sk: dateText(tx.createdAt || tx.date), ref: refNumber(tx.ref) })),
      ...retRows.map(r => ({ k: 'ret' as const, r, sk: dateText(r.createdAt), ref: 0 }))]
      .sort((a, b) => b.sk.localeCompare(a.sk) || b.ref - a.ref);
  } else merged = [...data.map(tx => ({ k: 'tx' as const, tx })), ...retRows.map(r => ({ k: 'ret' as const, r }))];
  const orderIds = merged.filter(row => row.k === 'tx').map(row => String(row.tx._id));
  const siblingRows = transactions.filter(tx => tx.type === SALES && !tx.cancelled
    && ['Pending', 'Preparing', 'Ready'].includes(unshippedStage(tx)))
    .map(tx => ({ _id: tx._id, type: tx.type, phone: tx.phone, ref: tx.ref,
      client: tx.client, total: tx.total, unshippedStage: unshippedStage(tx) }));
  if (state.tag) merged = merged.filter(row => row.k === 'tx' && (row.tx.tags || []).includes(state.tag));
  const total = merged.length, pageSize = Math.min(100, Math.max(1, Number(state.limit) || 20));
  const page = Math.min(Math.max(1, Number(state.page) || 1), Math.max(1, Math.ceil(total / pageSize)));
  const pageRows = merged.slice((page - 1) * pageSize, page * pageSize).map(row => row.k === 'tx'
    ? { k: 'tx', tx: row.tx } : { k: 'ret', r: row.r });
  return { pageRows, total, page, pageSize, transactionCount: data.length,
    activeCount: transactions.filter(tx => !tx.cancelled).length, tabCounts, facets, kpi,
    orderIds, siblingRows };
}
