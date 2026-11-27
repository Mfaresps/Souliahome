/**
 * The email copy of a manager approval code (Nov 27, 2026).
 *
 * Every code an employee asks for («كود المدير») is shown to the admins inside SOULIA; a copy is
 * also emailed to each admin's verified security email. This builds that email from the stored
 * code document only, in formal Arabic. `null` = the kind carries no code to relay
 * (`edit-tx` is approved with a button in the app, never by reading a code).
 */

import { MAIL_SUBJECT } from '../auth/security-mailer.service';

export interface OtpMailContent { subject: string; title: string; lines: string[]; code: string }

const KIND_LABEL: Record<string, string> = {
  discount: 'خصم يتجاوز الحد المسموح',
  purchase: 'تسجيل فاتورة مشتريات',
  'import-products': 'استيراد أصناف',
  'delete-product': 'حذف صنف',
  'delete-supplier': 'حذف مورد',
  'supplier-pay': 'سداد مبلغ لمورد',
  'deposit-no-image': 'إضافة عربون بدون صورة تحويل',
  'record-edit': 'تعديل بيانات',
  'vault-access': 'الدخول إلى الخزنة',
  'add-product': 'إضافة صنف جديد',
  'export-excel': 'تصدير بيانات',
};

const RECORD_LABEL: Record<string, string> = { product: 'الصنف', category: 'التصنيف', collection: 'المجموعة' };

export function otpKindLabel(kind: string): string {
  return KIND_LABEL[kind || 'discount'] || 'إجراء يحتاج موافقة';
}

function money(v: unknown): string {
  const n = Number(v) || 0;
  return 'EGP ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Cairo wall-clock time with Latin digits, e.g. «27/11/2026 · 10:21 م». */
export function otpMailTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Built from parts: the formatted string carries RLM marks that show as junk in plain-text mail.
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(d)) p[x.type] = x.value;
  const pm = String(p.dayPeriod || '').toLowerCase().startsWith('p');
  return `${p.day}/${p.month}/${p.year} · ${p.hour}:${p.minute} ${pm ? 'م' : 'ص'}`;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function otpMailContent(doc: any): OtpMailContent | null {
  const kind = String(doc?.kind || 'discount');
  if (kind === 'edit-tx') return null;
  const code = String(doc?.otp || '').trim();
  if (!code) return null;

  const label = otpKindLabel(kind);
  const lines: string[] = [];
  const add = (name: string, value: unknown) => { const v = clip(value, 160); if (v) lines.push(`${name}: ${v}`); };

  add('نوع الطلب', label);
  add('مقدّم الطلب', doc.requestedByName || doc.requestedByUsername || 'موظف');

  switch (kind) {
    case 'discount':
      add('العميل', doc.client);
      add('رقم الفاتورة', doc.txRef ? '#' + doc.txRef : '');
      add('قيمة الخصم', money(doc.discountAmount));
      if (Number(doc.thresholdAtRequest) > 0) add('الحد المسموح', money(doc.thresholdAtRequest));
      break;
    case 'purchase':
      add('المورد', doc.client);
      add('رقم الفاتورة', doc.txRef ? '#' + doc.txRef : '');
      add('إجمالي الفاتورة', money(doc.itemsTotal));
      if (Array.isArray(doc.purchaseItems) && doc.purchaseItems.length) add('عدد الأصناف', String(doc.purchaseItems.length));
      break;
    case 'import-products':
      add('البيان', doc.client);
      break;
    case 'delete-product':
      add('البيان', doc.client);
      if (Array.isArray(doc.deleteProductNames) && doc.deleteProductNames.length > 1) {
        add('الأصناف', doc.deleteProductNames.slice(0, 5).join('، ') + (doc.deleteProductNames.length > 5 ? ` و${doc.deleteProductNames.length - 5} أصناف أخرى` : ''));
      }
      break;
    case 'delete-supplier':
      add('المورد', doc.client);
      break;
    case 'supplier-pay':
      add('المورد', doc.client);
      add('رقم الفاتورة', doc.txRef ? '#' + doc.txRef : '');
      add('المبلغ المطلوب سداده', money(doc.itemsTotal));
      break;
    case 'deposit-no-image':
      add('رقم الطلب', doc.txRef ? '#' + doc.txRef : '');
      add('العميل', doc.client);
      add('المبلغ', money(doc.itemsTotal));
      add('الخزنة', doc.txType);
      add('السبب', doc.requestReason);
      break;
    case 'record-edit': {
      const entity = String(doc.editTxId || '').split(':')[0];
      add(RECORD_LABEL[entity] || 'السجل', doc.txRef);
      add('التعديلات', doc.requestReason);
      break;
    }
    case 'add-product':
      add('البيان', doc.client);
      break;
    case 'export-excel':
      add('البيانات المطلوب تصديرها', doc.client);
      break;
    default:
      add('البيان', doc.client);
  }

  add('صالح حتى', otpMailTime(doc.expiresAt));
  lines.push('لا تُسلِّم الرمز إلا لمقدّم الطلب بعد التأكد من صحته.');

  // Fixed subject (Gmail): the kind of request is in the body, never in the subject.
  return { subject: MAIL_SUBJECT.approvalCode, title: MAIL_SUBJECT.approvalCode, lines, code };
}
