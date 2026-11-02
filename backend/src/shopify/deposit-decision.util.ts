import { BadRequestException } from '@nestjs/common';

export const DEPOSIT_REASONS = [
  { code: 'no-payment-method', ar: 'لا تتوفر للعميل وسيلة دفع أو تحويل', en: 'No payment or transfer method available' },
  { code: 'first-order-trust', ar: 'أول تعامل ويحتاج الاطمئنان قبل الدفع', en: 'First order; needs reassurance before paying' },
  { code: 'prefers-cod', ar: 'يفضل الدفع عند الاستلام', en: 'Prefers cash on delivery' },
  { code: 'transfer-problem', ar: 'مشكلة مؤقتة في التحويل أو حد التحويل', en: 'Temporary transfer problem or transfer limit' },
  { code: 'not-requested', ar: 'لم يُطلب مقدم من العميل — استثناء من المتجر', en: 'Store exception; no deposit requested' },
  { code: 'other', ar: 'سبب آخر', en: 'Other reason' },
] as const;
export const DEPOSIT_EXCEPTIONS = [
  { code: 'returning-customer', ar: 'عميل سابق ملتزم بالاستلام', en: 'Reliable returning customer' },
  { code: 'manager-exception', ar: 'استثناء بتوجيه الإدارة', en: 'Exception directed by management' },
  { code: 'staff-discretion', ar: 'استثناء ضمن صلاحياتي', en: 'Exception within my authority' },
  { code: 'other', ar: 'مبرر آخر', en: 'Other justification' },
] as const;

export function validateDepositDecision(input: any, exceptionRequired: boolean) {
  if (!input || !DEPOSIT_REASONS.some(r => r.code === input.reasonCode)) throw new BadRequestException('اختر سبب عدم دفع المقدم');
  const text = (value: unknown) => {
    if (value !== undefined && typeof value !== 'string') throw new BadRequestException('الملاحظة يجب أن تكون نصًا');
    if (String(value || '').length > 500) throw new BadRequestException('الملاحظة لا تتجاوز 500 حرف');
    return String(value || '').trim();
  };
  const note = text(input.note), exceptionNote = text(input.exceptionNote);
  if (input.reasonCode === 'other' && note.length < 5) throw new BadRequestException('وضح السبب الآخر في 5 أحرف على الأقل');
  if (exceptionRequired && !DEPOSIT_EXCEPTIONS.some(r => r.code === input.exceptionCode)) throw new BadRequestException('اختر مبرر السماح بالشحن بدون عربون');
  return { reasonCode: input.reasonCode as string, note, ...(exceptionRequired ? { exceptionCode: input.exceptionCode as string, exceptionNote } : {}) };
}

/** Current outcomes for a creation-month cohort; historical decisions never imply a shipment. */
export function depositDecisionReport(orders: any[], transactions: any[], month: string) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month || '')) throw new BadRequestException('اختر شهرًا صحيحًا');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit' });
  const sales = transactions.filter(t => t.type === 'مبيعات');
  const byId = new Map(sales.filter(t => t.shopifyOrderId).map(t => [String(t.shopifyOrderId), t]));
  const byRef = new Map(sales.map(t => [String(t.ref || '').replace(/^#/, ''), t]));
  const rows = orders.filter(o => {
    const date = new Date(o.shopifyCreatedAt);
    return Number.isFinite(+date) && formatter.format(date) === month;
  }).map(o => {
    const tx = byId.get(String(o.shopifyId)) || byRef.get(String(o.ref).replace(/^#/, ''));
    const decision = tx?.depositDecision || o.depositDecision;
    const history: any[] = o.depositDecisionHistory || [];
    const activation = history.find(e => e.action === 'enabled');
    const legacyWithoutDeposit = !!tx && !(tx.initialDeposit > 0) && !(o.depositAmount > 0)
      && !(tx.deposits || []).some((r: any) => r.amount > 0) && !(o.depositReceipts || []).some((r: any) => ['معتمد','مُسترد'].includes(r.status) && r.amount > 0);
    const everEnabled = !!activation || !!o.shipWithoutDeposit || !!tx?.shipWithoutDeposit;
    const cancelMap: Record<string,string> = {'customer-no-payment-method':'no-payment-method','customer-first-order-trust':'first-order-trust','customer-prefers-cod':'prefers-cod','customer-transfer-problem':'transfer-problem','customer-refused-deposit':'refused-unspecified'};
    const cancelCode = tx?.cancelled ? tx.cancelReasonCode : o.cancelled ? o.cancelReasonCode : '';
    const reasonCode = cancelMap[cancelCode] || decision?.reasonCode || (everEnabled || legacyWithoutDeposit ? 'unrecorded' : 'no-objection-recorded');
    const paid = (o.depositReceipts || []).some((r: any) => ['معتمد','مُسترد'].includes(r.status) && r.amount > 0)
      || o.depositAmount > 0 || tx?.initialDeposit > 0 || (tx?.deposits || []).some((r: any) => r.amount > 0);
    const cancelled = !!(o.cancelled || tx?.cancelled);
    const delivered = !!tx && (tx.bostaStatus === 'DELIVERED' || tx.pickupStatus === 'Delivered');
    const returned = !!tx && tx.bostaStatus === 'RETURNED';
    const shipped = !!tx && (delivered || returned || tx.pickupStatus === 'Shipped' || ['PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','FAILED_ATTEMPT','CUSTOMER_POSTPONED'].includes(tx.bostaStatus));
    const firstReasonAt = history.find(e => e.after?.reasonCode)?.at || decision?.at || '';
    const paymentTimes = [
      ...(o.depositReceipts || []).filter((r: any) => ['معتمد','مُسترد'].includes(r.status) && r.amount > 0).map((r: any) => r.reviewedAt),
      ...(tx?.deposits || []).filter((r: any) => r.amount > 0).map((r: any) => r.date),
    ].filter(Boolean);
    const paidLater = !!firstReasonAt && paymentTimes.some(at => +new Date(at) > +new Date(firstReasonAt));
    return { ref: o.ref, reasonCode, reason: DEPOSIT_REASONS.find(r => r.code === reasonCode)?.ar || (reasonCode === 'refused-unspecified' ? 'رفض العربون — دون تفصيل إضافي' : reasonCode === 'unrecorded' ? 'السبب غير مسجل' : 'لا يوجد اعتراض مسجل'),
      note: decision?.note || '', exception: DEPOSIT_EXCEPTIONS.find(r => r.code === decision?.exceptionCode)?.ar || '', exceptionNote: decision?.exceptionNote || '',
      everEnabled, currentlyEnabled: !!o.shipWithoutDeposit, confirmedWithoutDeposit: !!tx && (tx.shipWithoutDeposit === true || legacyWithoutDeposit),
      paid, paidLater, cancelled, delivered, returned, shipped, inProgress: shipped && !delivered && !returned && !cancelled,
      pending: !tx && !cancelled, at: decision?.at || '', by: decision?.by || '',
      cancelReason: (tx?.cancelled ? tx.cancelReason : o.cancelReason) || '',
      historyCount: history.length };
  });
  const groups = [...DEPOSIT_REASONS.map(r => ({code:r.code as string,label:r.ar as string})),{code:'refused-unspecified',label:'رفض العربون — دون تفصيل إضافي'},{code:'unrecorded',label:'السبب غير مسجل'}].map(g => {
    const list = rows.filter(r => r.reasonCode === g.code);
    const count = (key: string) => list.filter(r => (r as any)[key]).length;
    const shipped = count('shipped'), delivered = count('delivered');
    return {...g,orders:list.length,enabled:count('everEnabled'),confirmedWithoutDeposit:count('confirmedWithoutDeposit'),shipped,delivered,returned:count('returned'),cancelled:count('cancelled'),inProgress:count('inProgress'),pending:count('pending'),paidLater:count('paidLater'),deliveryRate:shipped ? Math.round(delivered/shipped*10000)/100:null};
  });
  return {month,timezone:'Africa/Cairo',asOf:new Date().toISOString(),totalOrders:rows.length,recordedReasons:rows.filter(r=>!['unrecorded','no-objection-recorded'].includes(r.reasonCode)).length,
    noObjectionRecorded:rows.filter(r=>r.reasonCode==='no-objection-recorded').length,groups,rows};
}
