/**
 * Shopify order metafields that mirror the ERP deposit — pure helpers, no I/O.
 *
 *   custom.deposit_amount    money             Σ deposits the ERP holds for the order
 *   custom.remaining_amount  money             Shopify order total − deposit (never below 0)
 *   custom.deposit_method    single_line_text  the methods used, in the order they were paid
 *   custom.deposit_date      date_time         when the latest counted deposit was booked
 *
 * ⚠ The ERP is the source of truth. Every value is recomputed from the database at send time,
 *   never carried from the event that queued the job — so a delayed retry always sends the
 *   newest figure and can never put an older, smaller deposit back.
 * ⚠ The definitions already exist in Shopify. Nothing here creates one; `checkDefinitions`
 *   refuses to write when a key is missing or has another type.
 */
import { cents } from './sync-plan';

export const DEPOSIT_METAFIELD_NAMESPACE = 'custom';

export const DEPOSIT_METAFIELD_DEFS = [
  { key: 'deposit_amount', type: 'money' },
  { key: 'remaining_amount', type: 'money' },
  { key: 'deposit_method', type: 'single_line_text_field' },
  { key: 'deposit_date', type: 'date_time' },
] as const;

export type DepositMetafieldKey = typeof DEPOSIT_METAFIELD_DEFS[number]['key'];

/** Vault segment (stored in Arabic) → the label written to Shopify. Unknown values pass through. */
export const DEPOSIT_METHOD_LABELS: Record<string, string> = {
  'كاش': 'Cash',
  'فودافون كاش': 'Vodafone Cash',
  'Instapay': 'InstaPay',
  'تحويل بنكي': 'Bank Transfer',
};

export const STORE_CURRENCY = 'EGP';

export interface ErpDepositLine { amount: number; method: string; at: string }

export interface ErpDepositState {
  /** Σ counted deposits, in piastres. */
  depositCents: number;
  /** Distinct English method labels, first-paid first. */
  methods: string[];
  /** ISO time of the latest counted deposit, or null when there is none. */
  lastAt: string | null;
  source: 'order' | 'transaction';
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const t = Date.parse(String(value));
  if (!Number.isFinite(t) || t < 946684800000) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function summarise(lines: ErpDepositLine[], cap: number | null, source: ErpDepositState['source']): ErpDepositState {
  const counted = lines.filter((l) => Number(l.amount) > 0);
  let depositCents = counted.reduce((s, l) => s + cents(l.amount), 0);
  if (cap !== null) depositCents = Math.min(depositCents, Math.max(0, cap));
  depositCents = Math.max(0, depositCents);
  if (depositCents === 0) return { depositCents: 0, methods: [], lastAt: null, source };
  const ordered = counted
    .map((l, i) => ({ ...l, t: Date.parse(iso(l.at) || '') || 0, i }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const methods: string[] = [];
  for (const l of ordered) {
    const label = DEPOSIT_METHOD_LABELS[String(l.method || '').trim()] || String(l.method || '').trim();
    if (label && !methods.includes(label)) methods.push(label);
  }
  const latest = ordered.filter((l) => l.t > 0).pop();
  return { depositCents, methods, lastAt: latest ? iso(latest.at) : null, source };
}

/**
 * Before confirmation the deposit lives on the ShopifyOrder as receipts. Only an APPROVED receipt
 * whose vault entry exists counts: «معتمد» without `vaultEntryId` is a booking still in flight
 * (or one that crashed and will be recovered), i.e. money not yet recorded in the ERP.
 */
export function depositStateFromOrder(order: any): ErpDepositState {
  const lines = (Array.isArray(order?.depositReceipts) ? order.depositReceipts : [])
    .filter((r: any) => r?.status === 'معتمد' && !!r.vaultEntryId)
    .map((r: any) => ({ amount: Number(r.amount) || 0, method: r.method, at: r.reviewedAt || r.submittedAt }));
  return summarise(lines, null, 'order');
}

/**
 * A vault booking still in flight (or crashed mid-way and awaiting recovery): approved without its
 * vault entry, or refunded without its refund entry. Neither value is known yet, so nothing is sent
 * until the ERP finishes — sending the order as unpaid, or as refunded, would be a guess.
 */
export function depositBookingInFlight(order: any): boolean {
  return (Array.isArray(order?.depositReceipts) ? order.depositReceipts : []).some((r: any) =>
    (r?.status === 'معتمد' && !r.vaultEntryId) || (r?.status === 'مُسترد' && !r.refundVaultEntryId));
}

/**
 * After confirmation the transaction owns the money. Its `deposit` FIELD also grows with COD
 * collection, so it is not "the deposit"; the `deposits` log is. A cancelled sale has had its
 * deposit paid back by performCancellation, so it holds none. A deferred (receipt-by-receipt)
 * cancellation refund is subtracted, and the log is capped at `deposit` so an edit that lowered
 * the deposit is honoured.
 */
export function depositStateFromTransaction(tx: any): ErpDepositState {
  if (tx?.cancelled) return { depositCents: 0, methods: [], lastAt: null, source: 'transaction' };
  const snapshots = new Map<string, any>(
    (Array.isArray(tx?.depositReceipts) ? tx.depositReceipts : []).map((r: any) => [String(r.id), r]),
  );
  const lines: ErpDepositLine[] = (Array.isArray(tx?.deposits) ? tx.deposits : [])
    .filter((d: any) => d && !d.reversed)
    .map((d: any) => {
      const snap = d.receiptId ? snapshots.get(String(d.receiptId)) : null;
      return { amount: Number(d.amount) || 0, method: d.method, at: snap?.reviewedAt || d.date };
    });
  const refunded = (Array.isArray(tx?.cancellationDepositRefunds) ? tx.cancellationDepositRefunds : [])
    .reduce((s: number, r: any) => s + cents(r?.amount), 0);
  const logged = lines.filter((l) => l.amount > 0).reduce((s, l) => s + cents(l.amount), 0);
  const cap = Math.min(logged - refunded, cents(tx?.deposit));
  return summarise(lines, cap, 'transaction');
}

/** Shopify `money` metafield value. */
export function moneyValue(amountCents: number, currency = STORE_CURRENCY): string {
  return JSON.stringify({ amount: (amountCents / 100).toFixed(2), currency_code: currency });
}

export interface DesiredDepositMetafields {
  set: Array<{ key: DepositMetafieldKey; type: string; value: string }>;
  remove: DepositMetafieldKey[];
  summary: { deposit: number; remaining: number; total: number; method: string; date: string | null };
}

export class DepositMetafieldReview extends Error {}

/**
 * Turns the ERP state + Shopify's own order total into the four values. A non-EGP order is
 * refused rather than converted: the ERP books piastres, and mixing currencies would be a guess.
 */
export function desiredDepositMetafields(state: ErpDepositState, remoteOrder: any): DesiredDepositMetafields {
  const money = remoteOrder?.currentTotalPriceSet?.shopMoney;
  if (!money) throw new DepositMetafieldReview('تعذر قراءة إجمالي الطلب من Shopify.');
  if (money.currencyCode !== STORE_CURRENCY) {
    throw new DepositMetafieldReview(`عملة الطلب في Shopify ${money.currencyCode} وليست ${STORE_CURRENCY}؛ لم يُرسل العربون.`);
  }
  const total = cents(money.amount);
  const remaining = Math.max(0, total - state.depositCents);
  const method = state.methods.join(' + ');
  const set: DesiredDepositMetafields['set'] = [
    { key: 'deposit_amount', type: 'money', value: moneyValue(state.depositCents) },
    { key: 'remaining_amount', type: 'money', value: moneyValue(remaining) },
  ];
  const remove: DepositMetafieldKey[] = [];
  if (method) set.push({ key: 'deposit_method', type: 'single_line_text_field', value: method.slice(0, 255) });
  else remove.push('deposit_method');
  if (state.lastAt) set.push({ key: 'deposit_date', type: 'date_time', value: state.lastAt });
  else remove.push('deposit_date');
  return { set, remove, summary: { deposit: state.depositCents / 100, remaining: remaining / 100, total: total / 100, method, date: state.lastAt } };
}

function sameValue(type: string, current: string | null | undefined, wanted: string): boolean {
  if (current === null || current === undefined) return false;
  if (type === 'money') {
    try {
      const a = JSON.parse(current), b = JSON.parse(wanted);
      return cents(a.amount) === cents(b.amount) && String(a.currency_code) === String(b.currency_code);
    } catch { return false; }
  }
  if (type === 'date_time') return Date.parse(current) === Date.parse(wanted);
  return current === wanted;
}

/** Only what differs from Shopify is written; an order already in step costs no mutation. */
export function depositMetafieldChanges(desired: DesiredDepositMetafields, remote: Record<string, { value: string } | null | undefined>) {
  return {
    set: desired.set.filter((m) => !sameValue(m.type, remote?.[m.key]?.value, m.value)),
    remove: desired.remove.filter((k) => !!remote?.[k]),
  };
}

/** Every key must exist on ORDER under `custom` with exactly the documented type. */
export function checkDefinitions(nodes: Array<{ key: string; type?: { name?: string } }>): string[] {
  const problems: string[] = [];
  for (const def of DEPOSIT_METAFIELD_DEFS) {
    const found = (nodes || []).find((n) => n.key === def.key);
    if (!found) problems.push(`custom.${def.key} غير معرّف في Shopify`);
    else if (found.type?.name !== def.type) problems.push(`custom.${def.key} نوعه ${found.type?.name} وليس ${def.type}`);
  }
  return problems;
}
