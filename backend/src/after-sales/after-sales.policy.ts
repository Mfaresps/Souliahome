import { BadRequestException } from '@nestjs/common';

export const DEFAULT_AFTER_SALES_POLICY = {
  version: 1, normalDays: 14, defectDays: 30, exchangeFee: 0, returnFee: 0,
  customerFeesEnabled: false, feePolicyNote: '', businessLocationId: '',
};
export const money = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export function afterSalesQuote(kind: string, reason: string, credit: number, replacement: number, fee: number) {
  if (!['return', 'exchange'].includes(kind) || !['defect', 'wrong-item', 'customer-choice'].includes(reason)) throw new BadRequestException('نوع الطلب أو السبب غير صالح');
  if (![credit, replacement, fee].every(n => Number.isFinite(n) && n >= 0)) throw new BadRequestException('قيم التسوية غير صالحة');
  if (reason !== 'customer-choice' && fee !== 0) throw new BadRequestException('خطأ الشركة أو الديفوه بدون رسوم على العميل');
  if (kind === 'return' && fee > credit) throw new BadRequestException('رسوم الإرجاع أكبر من قيمة المستحق');
  const delta = money((kind === 'exchange' ? replacement : 0) - credit + fee);
  return { credit: money(credit), replacement: money(replacement), customerFee: money(fee),
    collectDue: Math.max(0, delta), refundDue: Math.max(0, -delta),
    creditApplied: kind === 'exchange' ? money(Math.min(credit, replacement + fee)) : 0 };
}

export function requireOperation(body: any) {
  if (!body || typeof body.operationKey !== 'string' || body.operationKey.length < 8 || body.operationKey.length > 150) throw new BadRequestException('يلزم مفتاح عملية صالح لإعادة المحاولة بأمان');
}
