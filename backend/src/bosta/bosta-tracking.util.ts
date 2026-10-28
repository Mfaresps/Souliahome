import { createHash } from 'crypto';

export interface CarrierTrackingUpdate {
  key: string;
  signature: string;
  shipmentId: string;
  status: string;
  statusLabel: string;
  stateCode: string;
  reasonCode: number | null;
  reason: string;
  reasonAr: string;
  reasonVerified: boolean;
  reasonScope: 'current' | 'last-exception' | 'unspecified';
  exceptionAt: string;
  scheduledAt: string;
  attempts: number | null;
  at: string;
  source: string;
}

// Bosta's published NDR codes; keep the original carrier wording alongside the label.
const REASONS: Record<number, string> = {
  1: 'العميل غير موجود في العنوان', 2: 'العميل غيّر العنوان',
  3: 'العميل طلب تأجيل الاستلام', 4: 'العميل يريد فتح الشحنة',
  5: 'العنوان أو رقم الهاتف غير واضح أو غير صحيح', 6: 'إلغاء بطلب المرسل',
  7: 'العميل لا يرد', 8: 'العميل رفض الاستلام', 12: 'العنوان خارج تغطية بوسطة',
  13: 'العنوان غير واضح', 14: 'رقم الهاتف غير صحيح',
  20: 'المتجر غيّر عنوان استلام المرتجع', 21: 'المتجر أجّل استلام المرتجع',
  22: 'بيانات استلام المرتجع غير واضحة أو غير صحيحة', 23: 'المتجر لا يرد',
  24: 'المتجر رفض استلام المرتجع', 25: 'المتجر غير موجود في عنوان الاستلام',
  26: 'الشحنة تالفة', 27: 'الشحنة فارغة', 28: 'الشحنة غير مكتملة',
  29: 'الشحنة لا تخص المتجر', 30: 'تم فتح الشحنة دون السماح بذلك',
  100: 'سوء الأحوال الجوية', 101: 'اشتباه لدى شركة الشحن في المستلم',
};
const STATES: Record<string, string> = {
  '100': 'فقدان الشحنة', '101': 'تلف الشحنة', '102': 'الشحنة قيد التحقيق لدى بوسطة',
  '103': 'بوسطة تنتظر إجراءً من المتجر',
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Movement after postponement must not create another notification for the same agreement. */
export const postponementNotificationKey = (event: CarrierTrackingUpdate) =>
  hash([event.shipmentId, event.exceptionAt || event.attempts, event.scheduledAt]);
const iso = (value: any) => {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};

export function carrierTrackingUpdate(d: any, status: string, statusLabel: string, shipmentId: string,
  exception: any, source: string, now: string, previous?: CarrierTrackingUpdate): CarrierTrackingUpdate {
  const stateCode = String(d?.state?.code ?? d?.currentStatus?.code ?? d?.state?.value ?? d?.state ?? d?.status ?? status);
  const isException = ['47', 'exception', 'failed_attempt', 'failedattempt'].includes(stateCode.toLowerCase());
  const failure = status === 'FAILED_ATTEMPT' || status === 'RETURNED';
  // Old NDR metadata is retained for movement, but never describes a new loss/damage state.
  const detail = status === 'FAILED_ATTEMPT' && !isException ? null : exception;
  const reasonCode = detail?.code ?? null;
  const reason = detail?.reason || '';
  const reasonAr = STATES[stateCode] || REASONS[reasonCode] || reason || (failure ? 'لم ترسل بوسطة سببًا تفصيليًا بعد؛ يلزم التحقق' : '');
  const reasonScope = STATES[stateCode] || isException ? 'current' : detail ? 'last-exception' : 'unspecified';
  const rawAttempts = d?.numberOfAttempts ?? d?.deliveryAttemptsLength ?? d?.attemptsCount;
  const attempts = rawAttempts !== undefined && Number.isFinite(Number(rawAttempts)) ? Number(rawAttempts) : null;
  const exceptionAt = iso(detail?.at) || (isException ? iso(d?.timeStamp ?? d?.timestamp) : '');
  const scheduledAt = detail?.scheduledAt || (status === 'CUSTOMER_POSTPONED' ? d?.deliveryPromiseDate || '' : '');
  const signature = hash([shipmentId, status, stateCode, reasonCode, reason, reasonAr, exceptionAt, scheduledAt, attempts]);
  if (previous?.signature === signature && previous.shipmentId === shipmentId) return { ...previous, reasonScope };
  return { key: hash([signature, previous?.key || '']), signature, shipmentId, status, statusLabel, stateCode,
    reasonCode, reason, reasonAr, reasonScope, reasonVerified: !!(STATES[stateCode] || reason || REASONS[reasonCode]),
    exceptionAt, scheduledAt, attempts, at: iso(d?.timeStamp ?? d?.timestamp ?? d?.updatedAt) || exceptionAt || now, source };
}

export function carrierUpdateText(event: CarrierTrackingUpdate): string {
  return [`تحديث بوسطة: ${event.statusLabel}`, event.reasonAr ? `${event.reasonScope === 'last-exception' ? 'آخر سبب مسجل لدى بوسطة' : 'السبب المبلّغ'}: ${event.reasonAr}` : '',
    event.reason && event.reason !== event.reasonAr ? `نص شركة الشحن: ${event.reason}` : '',
    event.reasonCode !== null ? `كود السبب: ${event.reasonCode}` : '',
    event.exceptionAt ? `وقت الاستثناء لدى بوسطة: ${event.exceptionAt}` : '',
    event.scheduledAt ? `موعد إعادة المحاولة حسب بوسطة: ${event.scheduledAt}` : '',
    event.attempts !== null ? `عدد محاولات بوسطة: ${event.attempts}` : '',
    `وقت التحديث: ${event.at}`, `البوليصة: ${event.shipmentId}`].filter(Boolean).join('\n');
}

/** Backfill reasons for attempts made between polling runs, not just the latest one. */
export function carrierExceptionHistory(d: any, shipmentId: string): CarrierTrackingUpdate[] {
  const rows = [
    ...(Array.isArray(d?.state?.exception) ? d.state.exception : []),
    ...(Array.isArray(d?.attempts) ? d.attempts.map((a: any) => a?.exception).filter(Boolean) : []),
  ];
  const events = new Map<string, CarrierTrackingUpdate>();
  for (const row of rows) {
    const at = iso(row?.time);
    if (!at) continue; // never invent a historical attempt date
    const code = row.code === undefined || row.code === null ? null : Number(row.code);
    const status = code === 3 ? 'CUSTOMER_POSTPONED' : 'FAILED_ATTEMPT';
    const event = carrierTrackingUpdate({ state: 47, timeStamp: Date.parse(at) }, status,
      code === 3 ? 'العميل أجّل الاستلام' : 'محاولة تسليم فاشلة', shipmentId,
      { code: Number.isFinite(code) ? code : null, reason: typeof row.reason === 'string' ? row.reason : '',
        at, scheduledAt: row.scheduledAt || '' }, 'carrier-history', at);
    events.set(event.key, event);
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}
