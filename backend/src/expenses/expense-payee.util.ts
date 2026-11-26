/**
 * Saved expense parties («الجهات»): the ad agency, the employee on payroll, the subscribed
 * service. Picked again every month instead of being typed, so every expense of one party is
 * tied to it by id and covers an explicit period.
 *
 * ⚠ Frontend mirror: `XP_KIND_BY_CAT`, `XP_PLATFORMS`, `XP_CYCLES` in expense-payees.js.
 * `code` values are stored — never rename one.
 */
export type PayeeKind = 'ads' | 'salary' | 'subscription';

export const PAYEE_KINDS: PayeeKind[] = ['ads', 'salary', 'subscription'];

/** The stored (Arabic) expense category each kind belongs to. */
export const PAYEE_KIND_BY_CATEGORY: Record<string, PayeeKind> = {
  'اعلانات': 'ads',
  'مرتبات': 'salary',
  'اشتراكات': 'subscription',
};

export const AD_PLATFORMS = ['meta', 'tiktok', 'google', 'snapchat', 'influencer', 'other'];
export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'];

export function payeeKindForCategory(category?: string): PayeeKind | null {
  return PAYEE_KIND_BY_CATEGORY[String(category || '').trim()] || null;
}

/** Case/space/diacritic-insensitive key, so «Meta Ads » and «meta ads» are one agency. */
export function payeeNameKey(name: string): string {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A period is both days or neither. Returns the cleaned pair, or an Arabic error.
 * '' on both sides = no period (an expense outside the three categories, or an old row).
 */
export function checkPeriod(from?: string, to?: string): { from: string; to: string } | { error: string } {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!f && !t) return { from: '', to: '' };
  if (!isIsoDay(f) || !isIsoDay(t)) return { error: 'حدد بداية الفترة ونهايتها بتاريخ صحيح' };
  if (f > t) return { error: 'بداية الفترة بعد نهايتها' };
  const days = (Date.parse(t) - Date.parse(f)) / 86400000 + 1;
  if (days > 366) return { error: 'الفترة لا تتجاوز سنة واحدة' };
  return { from: f, to: t };
}

/** Do two inclusive day ranges share at least one day? */
export function periodsOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return !!(aFrom && aTo && bFrom && bTo) && aFrom <= bTo && bFrom <= aTo;
}

/**
 * Mongo clause: an expense belongs to a window when its PERIOD overlaps it, or — for a row
 * with no period (older rows, other categories) — when its date falls inside it.
 * `date` may hold a full ISO timestamp, so the upper bound is the next day (see date-window.util).
 */
export function expenseWindowClause(fromDate: string, toDate: string) {
  const next = new Date(toDate + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    $or: [
      { periodFrom: { $gt: '', $lte: toDate }, periodTo: { $gte: fromDate } },
      { periodFrom: { $in: [null, ''] }, date: { $gte: fromDate, $lt: next.toISOString().slice(0, 10) } },
    ],
  };
}

/**
 * Salary breakdown on a «مرتبات» expense:
 *   net = base + points × pointValue + overtime − deductions
 * The SERVER computes `pointsBonus` and `net` and the expense amount becomes `net`; what the
 * browser sent for them is ignored. Negative points earn no bonus (they are not a deduction —
 * a deduction is written as one, with its reason).
 */
export interface SalaryBreakdown {
  base: number;
  points: number;
  pointValue: number;
  pointsBonus: number;
  pointsMonth: string;
  overtime: number;
  overtimeNote: string;
  deductions: number;
  deductionsNote: string;
  net: number;
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const money = (v: unknown, label: string) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} لا يكون سالبًا`);
  if (n > 10_000_000) throw new Error(`${label} أكبر من المسموح`);
  return r2(n);
};

export function cleanSalaryBreakdown(raw: any): SalaryBreakdown | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'تفاصيل المرتب غير صحيحة' };
  try {
    const base = money(raw.base, 'المرتب الأساسي');
    const pointsNum = Number(raw.points ?? 0);
    if (!Number.isFinite(pointsNum) || Math.abs(pointsNum) > 1_000_000) throw new Error('عدد النقاط غير صحيح');
    const points = Math.round(pointsNum * 100) / 100;
    const pointValue = money(raw.pointValue, 'قيمة النقطة');
    const overtime = money(raw.overtime, 'الأوفر تايم');
    const deductions = money(raw.deductions, 'الخصومات');
    const pointsMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(raw.pointsMonth || '')) ? String(raw.pointsMonth) : '';
    const pointsBonus = r2(Math.max(0, points) * pointValue);
    const net = r2(base + pointsBonus + overtime - deductions);
    if (net <= 0) throw new Error('صافي المرتب يجب أن يكون أكبر من صفر');
    const note = (v: unknown) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
      base, points, pointValue, pointsBonus, pointsMonth,
      overtime, overtimeNote: note(raw.overtimeNote),
      deductions, deductionsNote: note(raw.deductionsNote),
      net,
    };
  } catch (e: any) {
    return { error: e?.message || 'تفاصيل المرتب غير صحيحة' };
  }
}

/** JS twin of expenseWindowClause, for rows already loaded. */
export function expenseInWindow(row: { date?: string; periodFrom?: string; periodTo?: string }, fromDate: string, toDate: string): boolean {
  if (row.periodFrom && row.periodTo) return periodsOverlap(row.periodFrom, row.periodTo, fromDate, toDate);
  const day = String(row.date || '').slice(0, 10);
  return !!day && day >= fromDate && day <= toDate;
}
