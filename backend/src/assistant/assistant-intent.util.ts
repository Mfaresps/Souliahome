/**
 * «مساعد SOULIA» — understanding a typed question. Pure: no database, no clock except `today`.
 *
 * The assistant does NOT compute figures. This file only decides WHAT was asked (topic) and FOR WHEN
 * (period); assistant.service.ts then reads the same report functions the pages use, so a figure in
 * the chat always equals the figure on the page.
 *
 * ⚠ Order of the checks in `understand` matters — see the comments there. «أفضل شهر بعنا فيه» was
 *   once answered with the top PRODUCTS because «أفضل» matched first; a superlative now needs a
 *   product word to mean products, a month/day word to mean a period ranking, and otherwise asks.
 */

export type Intent =
  | 'sales' | 'profit' | 'top' | 'best' | 'stock' | 'product' | 'order' | 'supplier'
  | 'cancel' | 'returns' | 'vault' | 'shopify' | 'help' | 'clarify' | 'unknown'
  | 'alerts' | 'daily' | 'reorder' | 'velocity' | 'compare' | 'purchases' | 'smartplan' | 'engine' | 'explain';

export interface Period {
  from: string; // YYYY-MM-DD, Cairo calendar day
  to: string;
  key: 'today' | 'yesterday' | 'last7' | 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'namedMonth';
  /** Month index 0-11 for namedMonth / lastMonth. */
  month?: number;
  year?: number;
  /** True when the question named no period and "this month" was assumed. */
  assumed?: boolean;
}

export interface Understood {
  intent: Intent;
  period?: Period;
  ref?: string;
  /** Normalised question text (also the review-log grouping key). */
  text: string;
  unit?: 'month' | 'day';
  worst?: boolean;
  metric?: 'sales' | 'profit';
  stockMode?: 'low' | 'out';
  /** Remaining words that may name a product or a supplier (resolved by the service). */
  subject?: string;
  /** compare: the second period (the first is `period`). */
  period2?: Period;
  /** The question clearly asked about stock ("متاح كام من …"), so a missing product is «not found», not «not understood». */
  explicit?: boolean;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeQuestion(s: string): string {
  return ' ' + String(s || '')
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[؟?!.,،:;"'()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ' ';
}

const has = (t: string, ...words: string[]) => words.some((w) => t.includes(w));

// ── Calendar helpers (UTC arithmetic on Cairo calendar days) ───────────────────────────────────
export function cairoToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const parse = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const monthStart = (y: number, m: number) => iso(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y: number, m: number) => iso(new Date(Date.UTC(y, m + 1, 0)));
const minDay = (a: string, b: string) => (a < b ? a : b);

const MONTH_KEYS = ['يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'];
const MONTH_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parsePeriod(t: string, today: string): Period {
  // «هذا الأسبوع مقارنة بالأسبوع الماضي»: the period is what comes BEFORE the comparison word; the
  // previous period is always derived (previousPeriod), so the part after it is not a period to read.
  const cut = t.search(/ (مقارنه|مقارن|مقابل|بالنسبه ل|vs|compared|versus) /);
  if (cut > 0) t = t.slice(0, cut + 1);
  const td = parse(today);
  const y = td.getUTCFullYear(), m = td.getUTCMonth();
  if (has(t, 'النهارده', 'انهارده', 'النهارد', 'اليوم ', ' today')) return { from: today, to: today, key: 'today' };
  if (has(t, 'امبارح', 'مبارح', ' امس', 'yesterday')) { const d = addDays(today, -1); return { from: d, to: d, key: 'yesterday' }; }
  if (has(t, 'اخر 7', 'اخر سبع', 'اخر اسبوع', 'last 7')) return { from: addDays(today, -6), to: today, key: 'last7' };
  // Egyptian week starts Saturday.
  const sinceSat = (td.getUTCDay() + 1) % 7;
  if (has(t, 'الاسبوع اللي فات', 'الاسبوع الماضي', 'الاسبوع السابق', 'last week')) {
    const s = addDays(today, -sinceSat - 7); return { from: s, to: addDays(s, 6), key: 'lastWeek' };
  }
  if (has(t, 'الاسبوع', 'اسبوع', 'this week', ' week')) return { from: addDays(today, -sinceSat), to: today, key: 'week' };
  if (has(t, 'الشهر اللي فات', 'الشهر الماضي', 'الشهر السابق', 'الشهر اللي قبله', 'last month')) {
    const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
    return { from: monthStart(py, pm), to: monthEnd(py, pm), key: 'lastMonth', month: pm, year: py };
  }
  for (let i = 0; i < 12; i++) {
    if (t.includes(MONTH_KEYS[i]) || t.includes(MONTH_EN[i])) {
      const yy = i > m ? y - 1 : y;
      return { from: monthStart(yy, i), to: minDay(monthEnd(yy, i), today), key: 'namedMonth', month: i, year: yy };
    }
  }
  const named = has(t, 'الشهر', 'شهر', 'month');
  return { from: monthStart(y, m), to: today, key: 'month', month: m, year: y, assumed: !named };
}

/** The same-length window right before `p` — for "compared with the previous period". */
export function previousPeriod(p: Period): { from: string; to: string } {
  if (p.key === 'month' || p.key === 'namedMonth' || p.key === 'lastMonth') {
    const s = parse(p.from); const py = s.getUTCMonth() === 0 ? s.getUTCFullYear() - 1 : s.getUTCFullYear();
    const pm = s.getUTCMonth() === 0 ? 11 : s.getUTCMonth() - 1;
    // A running month is compared with the same days of the previous month.
    const days = Math.round((parse(p.to).getTime() - parse(p.from).getTime()) / 864e5);
    return { from: monthStart(py, pm), to: minDay(addDays(monthStart(py, pm), days), monthEnd(py, pm)) };
  }
  // A running week is compared with the same days of last week, not with the days right before it.
  if (p.key === 'week') return { from: addDays(p.from, -7), to: addDays(p.to, -7) };
  const len = Math.round((parse(p.to).getTime() - parse(p.from).getTime()) / 864e5) + 1;
  return { from: addDays(p.from, -len), to: addDays(p.from, -1) };
}

const STOP = ['متاح', 'كام', 'عندنا', 'رصيد', 'باقي', 'فاضل', 'من', 'في', 'ال', 'منتج', 'المنتج', 'صنف', 'الصنف', 'حساب', 'مورد', 'المورد', 'علينا', 'لل', 'قد', 'ايه', 'هو', 'هي', 'كم', 'عن',
  'موجود', 'موجوده', 'فيه', 'دا', 'ده', 'دي', 'هذا', 'هذه', 'اتباع', 'اتبع', 'بيع', 'بعنا', 'منه', 'مره', 'مرات', 'قطعه', 'قطع', 'لسه', 'بقي', 'هيخلص', 'امتي', 'ينفد', 'تنفد',
  'how', 'many', 'stock', 'of', 'the', 'sold', 'is', 'left'];

/** What is left of the question once the topic words are gone — a product or supplier name candidate. */
function subjectOf(t: string): string {
  return t.split(' ').filter((w) => w.length > 1 && !STOP.includes(w)).join(' ').trim();
}

export { subjectOf };

export function understand(question: string, today: string): Understood {
  const t = normalizeQuestion(question);
  const base = { text: t.trim() };

  // 1. An order number is unambiguous — check it first.
  // The number may come anywhere in the sentence («الاوردر دا حالته ايه 3201»), as long as the
  // sentence is about an order (or is the number alone).
  const ref = (t.match(/(?:اوردر|اوردار|طلب|فاتوره|رقم|order|#)\s*#?\s*(\d{3,7})/) || t.match(/^\s*#?(\d{3,7})\s*$/)
    || (has(t, 'اوردر', 'اوردار', 'الطلب', 'فاتوره', 'حالته', 'حاله', 'order', 'status') && !has(t, 'شراء', 'مشتريات') ? t.match(/(?:^|\s)#?(\d{3,7})(?=\s|$)/) : null) || [])[1];
  if (ref) return { ...base, intent: 'order', ref };

  // Two named months to compare («قارن اكتوبر بشهر نوفمبر»). One period + a comparison word is a
  // sales question — sales always compare with the previous period.
  const comparing = has(t, 'قارن', 'مقارنه', 'مقابل', 'compare', ' vs ', 'versus');
  if (comparing) {
    const found: { i: number; m: number }[] = [];
    for (let m = 0; m < 12; m++) { const i = t.indexOf(MONTH_KEYS[m]); const j = t.indexOf(MONTH_EN[m]); const k = i >= 0 ? i : j; if (k >= 0) found.push({ i: k, m }); }
    if (found.length >= 2) {
      found.sort((a, b) => a.i - b.i);
      const p1 = parsePeriod(' ' + MONTH_KEYS[found[0].m] + ' ', today), p2 = parsePeriod(' ' + MONTH_KEYS[found[1].m] + ' ', today);
      return { ...base, intent: 'compare', period: p1, period2: p2, metric: has(t, 'ربح', 'ارباح', 'profit') ? 'profit' : 'sales' };
    }
  }

  // Purchase invoices — before reorder, whose words they share («اشترينا» contains «اشتري»).
  if (has(t, 'فاتوره شراء', 'فواتير شراء', 'فواتير الشراء', 'فاتوره مشتريات', 'اخر مشتريات', 'المشتريات', 'اشترينا', 'purchase invoice', 'last purchase')) return { ...base, intent: 'purchases' };

  // Purchasing engine — before the reorder words they contain («خطة الشراء»).
  if (has(t, 'تقرير المحرك', 'تقرير محرك', 'مقارنه المحرك', 'دقه التنبؤ', 'اختبار المحرك', 'اداء المحرك', 'backtest', 'engine report', 'forecast accuracy')) return { ...base, intent: 'engine' };
  if (has(t, 'خطه الشراء', 'خطه شراء', 'الشراء الذكي', 'محرك الشراء', 'smart plan', 'purchase plan', 'purchasing plan')) return { ...base, intent: 'smartplan' };
  // «ليه مقترح شراء X» / «ليه مش مقترح X» — explain one product's decision.
  if (has(t, 'ليه', 'لماذا', 'لما ', 'اشرح', 'why', 'explain') && has(t, 'مقترح', 'يقترح', 'اقترح', 'شراء', 'نشتري', 'اشتري', 'استبعد', 'suggest', 'buy')) {
    const WHY = ['ليه', 'لماذا', 'لما', 'اشرح', 'مش', 'لا', 'غير', 'مقترح', 'يقترح', 'اقترح', 'شراء', 'نشتري', 'اشتري', 'استبعد', 'المحرك', 'why', 'explain', 'not', 'suggested', 'buy', 'is'];
    const subject = subjectOf(t).split(' ').filter((w) => !WHY.includes(w)).join(' ');
    if (subject) return { ...base, intent: 'explain', subject };
  }

  // Analysis topics — before suppliers/stock, whose words they share («طلب شراء», «هيخلص امتى»).
  if (has(t, 'ملخص', 'التقرير اليومي', 'تقرير اليوم', 'تقرير يومي', 'daily report', 'summary', 'briefing')) return { ...base, intent: 'daily' };
  if (has(t, 'مشاكل', 'مشكله', 'تنبيه', 'تحذير', 'مخاطر', 'في حاجه غلط', 'ايه الغلط', 'alert', 'problem', 'issues', 'risk')) return { ...base, intent: 'alerts' };
  if (has(t, 'اشتري', 'نشتري', 'اعيد شراء', 'اعاده الشراء', 'اعاده شراء', 'اطلب ايه', 'نطلب', 'طلب شراء', 'امر شراء', 'كميات الشراء', 'كميه الشراء', 'اقترح', 'توصي', 'reorder', 'restock', 'what to buy')) return { ...base, intent: 'reorder' };
  if (has(t, 'اتباع كام', 'اتباع منه', 'اتبع منه', 'بعنا منه', 'بيع منه', 'كام مره', 'كام قطعه اتباعت', 'بسرعه', 'اسرع', 'سرعه البيع', 'سرعه بيع', 'معدل البيع', 'معدل بيع', 'معدل النفاد', 'هيخلص امتي', 'هتخلص امتي', 'تنفد امتي', 'ينفد امتي', 'متي ينفد', 'velocity', 'fast moving', 'selling fast')) return { ...base, intent: 'velocity' };

  if (has(t, 'مورد', 'موردين', 'supplier', 'علينا كام', 'علينا قد')) return { ...base, intent: 'supplier', subject: subjectOf(t) };
  if (has(t, 'الغاء', 'ملغي', 'ملغيه', 'اتلغ', 'بتتلغي', 'بيتلغي', 'cancel')) return { ...base, intent: 'cancel', period: parsePeriod(t, today) };
  if (has(t, 'مرتجع', 'رجعوا', 'استرجاع', 'return')) return { ...base, intent: 'returns', period: parsePeriod(t, today) };
  if (has(t, 'خزنه', 'الخزنه', 'vault', 'cash in')) return { ...base, intent: 'vault' };
  if (has(t, 'شوبيفاي', 'شوبفاي', 'shopify', 'معلقه', 'مستني تاكيد', 'مستنيه تاكيد', 'pending')) return { ...base, intent: 'shopify' };

  // 2. Superlatives: a product word → top products; a month/day word → period ranking; neither → ask.
  const superl = has(t, 'افضل', 'احسن', 'اكتر', 'اكثر', 'اعلي', 'اسوا', 'اوحش', 'اقل', 'اضعف', 'best', 'top', 'worst', 'most');
  const unit = has(t, ' شهر', 'الشهور', 'شهور', 'month') ? 'month' : has(t, ' يوم', 'الايام', ' ايام', ' day') ? 'day' : undefined;
  const prodWord = has(t, 'منتج', 'صنف', 'اصناف', 'حاجه', 'حاجات', 'بتتباع', 'اتباع', 'بيتباع', 'قطع', 'product', 'item');
  const isProfit = has(t, 'ربح', 'مكسب', 'ارباح', 'كسبنا', 'profit');
  if (superl && unit && !prodWord) {
    return { ...base, intent: 'best', unit, worst: has(t, 'اسوا', 'اوحش', 'اقل', 'اضعف', 'worst'), metric: isProfit ? 'profit' : 'sales' };
  }
  if (superl && prodWord) return { ...base, intent: 'top', period: parsePeriod(t, today) };
  if (superl) return { ...base, intent: 'clarify' };

  if (isProfit) return { ...base, intent: 'profit', period: parsePeriod(t, today) };

  // 3. Stock: "about to run out" before "ran out" — «قربت تخلص» contains «خلص».
  // Standard Arabic too: «قاربت على النفاد» / «منخفضة المخزون» (the suggestion chips are MSA).
  if (has(t, 'قرب', 'قارب', 'وشك', 'منخفض', 'هيخلص', 'ناقص', 'نواقص', 'نقص', 'قليل', 'low stock', 'running low')) return { ...base, intent: 'stock', stockMode: 'low' };
  if (has(t, 'خلص', 'نفد', 'نفذ', 'نفاد', 'out of stock', 'مش موجود')) return { ...base, intent: 'stock', stockMode: 'out' };

  const sales = has(t, 'مبيعات', 'بعنا', 'بيعنا', ' بيع', 'ايراد', 'دخل', 'تحليل', 'اداء', 'sales', 'sold', 'revenue', 'performance', 'analysis', 'اوردرات', 'طلبات', 'كام اوردر') || comparing;
  if (sales) return { ...base, intent: 'sales', period: parsePeriod(t, today) };

  if (has(t, 'متاح', 'رصيد', 'عندنا', 'فاضل', 'باقي', 'موجود', 'مخزون', 'المخزن', 'stock', 'available')) {
    const subject = subjectOf(t.replace(/مخزون|المخزن/g, ' '));
    if (subject) return { ...base, intent: 'product', subject, explicit: true };
    return { ...base, intent: 'stock', stockMode: 'low' };
  }
  if (has(t, 'مساعده', 'تقدر', 'بتعمل ايه', 'help', 'what can')) return { ...base, intent: 'help' };

  // 4. Last resort: the whole question may be a product name ("طقم سلال Terra Red").
  const subject = subjectOf(t);
  if (subject && subject.length >= 3) return { ...base, intent: 'product', subject };
  return { ...base, intent: 'unknown' };
}
