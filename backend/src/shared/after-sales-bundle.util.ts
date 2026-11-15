/**
 * A new sale shipped inside an exchange shipment («ضم طلب جديد لشحنة الاستبدال»).
 *
 * The new sale (B) stays an ordinary sale — its own deposit, discount, offers and profit.
 * Only its delivery rides the exchange waybill, so the waybill's COD is
 * exchange difference + B's remaining, and the exchange's carrier settlement closes both.
 */
const money = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

export const MAX_BUNDLED_SALES = 5;

/** Last 10 digits of a phone, Arabic-Indic digits converted. '' when too short to compare. */
export function phoneKey(value: unknown): string {
  const digits = String(value ?? '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776))
    .replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const nameKey = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Same customer: same phone, else the exact same name when either phone is missing. */
export function sameCustomer(a: { phone?: any; client?: any }, b: { phone?: any; client?: any }): boolean {
  const pa = phoneKey(a.phone), pb = phoneKey(b.phone);
  if (pa && pb) return pa === pb;
  return !!nameKey(a.client) && nameKey(a.client) === nameKey(b.client);
}

/** Why this exchange case cannot take a new sale now, or ''. */
export function caseBundleBlock(row: any): string {
  const w = row?.workflow || {};
  if (row?.requestKind !== 'exchange') return 'ضم طلب جديد متاح لطلبات الاستبدال فقط';
  if (w.fulfillmentChannel === 'direct') return 'الاستبدال بالتسليم المباشر لا يُنشئ شحنة؛ سلّم الطلب الجديد كفاتورة عادية';
  if (['closed', 'cancelled'].includes(w.stage)) return 'طلب الاستبدال مغلق';
  if (w.shipment) return 'أُنشئت شحنة الاستبدال بالفعل؛ لا يمكن تعديل محتواها';
  if ((w.bundledSales || []).length >= MAX_BUNDLED_SALES) return `الحد الأقصى ${MAX_BUNDLED_SALES} طلبات مع شحنة واحدة`;
  return '';
}

/** Why sale `tx` cannot join exchange case `row`, or ''. */
export function saleBundleBlock(tx: any, row: any): string {
  if (!tx) return 'الطلب غير موجود';
  if (tx.type !== 'مبيعات') return 'يمكن ضم فواتير المبيعات فقط';
  if (tx.cancelled || tx.archived) return 'الطلب ملغي أو مؤرشف';
  const id = String(tx._id);
  if (id === String(row.originalTransactionId)) return 'هذه هي الفاتورة الأصلية للاستبدال';
  if (id === String(row.workflow?.replacementTxId || '')) return 'هذه فاتورة البديل نفسها';
  if (tx.afterSales?.caseId) return 'الطلب مرتبط بخدمة ما بعد البيع';
  if (tx.afterSalesBundle?.caseId) {
    return String(tx.afterSalesBundle.caseId) === String(row._id)
      ? 'الطلب مضموم لهذه الشحنة بالفعل'
      : `الطلب مضموم لشحنة استبدال أخرى (${tx.afterSalesBundle.caseRef || ''})`;
  }
  if (tx.bostaOrderId || tx.bostaTrackingNumber) return 'الطلب أُرسل لبوسطة بالفعل';
  if (tx.shippedAt || tx.deliveredAt || ['Shipped', 'Delivered', 'Picked-Up'].includes(String(tx.pickupStatus || ''))) return 'الطلب خرج للشحن أو سُلِّم';
  if (tx.carrierSettlement?.status || tx.carrierSettlement?.payoutId) return 'الطلب في تسوية شركة الشحن';
  if (String(tx.warehouseCode || 'MAIN') !== String(row.workflow?.warehouseCode || 'MAIN')) return 'الطلب من مخزن مختلف عن مخزن الاستبدال';
  if (!sameCustomer(tx, row)) return 'الطلب لعميل آخر؛ الضم متاح لطلبات نفس العميل فقط';
  return '';
}

/** Deposits still waiting for a manager: the remaining is not final until they are decided. */
export function pendingDepositRequests(tx: any): number {
  return (tx?.depositRequests || []).filter((r: any) => ['معلق', 'قيد التسجيل'].includes(String(r?.status || ''))).length;
}

/** What Bosta collects for a bundled sale: its remaining, never negative. */
export function bundledSaleCod(tx: any): number {
  return money(Math.max(0, Number(tx?.remaining || 0)));
}

/** Shipping the customer paid on a bundled sale (shipping charged minus a shipping discount). */
export function bundledSaleShipCharged(tx: any): number {
  return money(Math.max(0, Number(tx?.shipCost || 0) - Number(tx?.shippingDiscount || 0)));
}

/** The exchange waybill's COD: the exchange difference + every bundled sale's remaining. */
export function bundledShipmentCod(collectDue: number, bundled: Array<{ cod?: number }> = []): number {
  return money(Number(collectDue || 0) + bundled.reduce((n, b) => n + Number(b.cod || 0), 0));
}

/** Transactions whose shipment state follows the exchange waybill (replacement + bundled sales). */
export function bundledTransactionIds(row: any): string[] {
  const w = row?.workflow || {};
  const fromShipment = (w.shipment?.bundled || []).map((b: any) => String(b.transactionId));
  const fromCase = (w.bundledSales || []).map((b: any) => String(b.transactionId));
  return [...new Set([...fromShipment, ...fromCase].filter(Boolean))];
}

/** Deposits paid on the replacement sale («عربون على فرق الاستبدال»): approved cash, not the return credit. */
export function advancePaid(replacement: any): number {
  return money(((replacement?.deposits || []) as any[])
    .filter(d => d?.source === 'deposit-receipt' && !d.reversed)
    .reduce((n, d) => n + Number(d.amount || 0), 0));
}

/** What is left of the exchange difference after the deposits paid on it. */
export function advanceRemaining(collectDue: number, replacement: any): number {
  return money(Math.max(0, Number(collectDue || 0) - advancePaid(replacement)));
}

/** The case's view of deposits on the difference: paid, left, and how many wait for a manager. */
export function advanceView(collectDue: number, replacement: any) {
  if (!replacement || !(Number(collectDue) > 0)) return null;
  const paid = advancePaid(replacement);
  return { due: money(collectDue), paid, left: advanceRemaining(collectDue, replacement), pending: pendingDepositRequests(replacement),
    requests: ((replacement.depositRequests || []) as any[]).filter(r => ['معلق', 'قيد التسجيل', 'مرفوض'].includes(String(r?.status || '')))
      .map(r => ({ id: r.id, amount: Number(r.amount || 0), method: r.method || '', status: r.status, submittedBy: r.submittedBy || '', submittedAt: r.submittedAt || '', noImage: !!r.noImage, rejectReason: r.rejectReason || '' })),
    deposits: ((replacement.deposits || []) as any[]).filter(d => d?.source === 'deposit-receipt' && !d.reversed)
      .map(d => ({ id: d.id, amount: Number(d.amount || 0), method: d.method || '', date: d.date || '', by: d.by || '', vaultTxNo: d.vaultTxNo || '' })) };
}
