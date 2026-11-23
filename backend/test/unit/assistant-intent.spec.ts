import { understand, parsePeriod, previousPeriod, normalizeQuestion } from '../../src/assistant/assistant-intent.util';

const TODAY = '2026-11-22'; // Sunday
const u = (q: string) => understand(q, TODAY);

describe('assistant — understanding a question', () => {
  it('«أفضل شهر بعنا فيه» ranks months, never top products (the reported mistake)', () => {
    const r = u('افضل شهر بعنا فيه');
    expect(r.intent).toBe('best');
    expect(r.unit).toBe('month');
    expect(r.worst).toBe(false);
  });

  it('a superlative with a product word means top products', () => {
    expect(u('أكتر منتجات بتتباع الأسبوع ده').intent).toBe('top');
  });

  it('a bare superlative asks instead of guessing', () => {
    expect(u('الأفضل').intent).toBe('clarify');
  });

  it('worst day for sales', () => {
    const r = u('أوحش يوم في المبيعات');
    expect(r).toMatchObject({ intent: 'best', unit: 'day', worst: true, metric: 'sales' });
  });

  it('the suggestion chips (Modern Standard Arabic) are understood', () => {
    expect(u('مبيعات اليوم')).toMatchObject({ intent: 'sales', period: { key: 'today' } });
    expect(u('أفضل شهر في المبيعات')).toMatchObject({ intent: 'best' });
    expect(u('أرباح هذا الشهر')).toMatchObject({ intent: 'profit', period: { key: 'month' } });
    expect(u('المنتجات التي قاربت على النفاد')).toMatchObject({ intent: 'stock', stockMode: 'low' });
    expect(u('المنتجات منخفضة المخزون')).toMatchObject({ intent: 'stock', stockMode: 'low' });
    expect(u('المستحق للموردين')).toMatchObject({ intent: 'supplier' });
  });

  it('«قربت تخلص» is low stock, not out of stock', () => {
    expect(u('إيه المنتجات اللي قربت تخلص؟')).toMatchObject({ intent: 'stock', stockMode: 'low' });
    expect(u('إيه اللي خلص من المخزن')).toMatchObject({ intent: 'stock', stockMode: 'out' });
  });

  it('order numbers, with Arabic-Indic digits too', () => {
    expect(u('أوردر ٣٣١٢')).toMatchObject({ intent: 'order', ref: '3312' });
    expect(u('#2254')).toMatchObject({ intent: 'order', ref: '2254' });
  });

  it('profit, cancellations, suppliers, vault, shopify', () => {
    expect(u('الربح في أكتوبر').intent).toBe('profit');
    expect(u('ليه الأوردرات بتتلغي الشهر ده').intent).toBe('cancel');
    expect(u('علينا كام للموردين').intent).toBe('supplier');
    expect(u('رصيد الخزنة').intent).toBe('vault');
    expect(u('أوردرات شوبيفاي المعلقة').intent).toBe('shopify');
  });

  it('a product name becomes a product lookup', () => {
    expect(u('متاح كام من طقم سلال Terra Red')).toMatchObject({ intent: 'product' });
  });
});

describe('assistant — analysis topics', () => {
  it('alerts, daily report, reorder and velocity', () => {
    expect(u('فيه مشاكل النهارده؟').intent).toBe('alerts');
    expect(u('التقرير اليومي').intent).toBe('daily');
    expect(u('ملخص اليوم').intent).toBe('daily');
    expect(u('اقترح كميات الشراء').intent).toBe('reorder');
    expect(u('نشتري إيه الأسبوع ده؟').intent).toBe('reorder');
    expect(u('أسرع المنتجات بيعًا').intent).toBe('velocity');
    expect(u('طقم السلال هيخلص امتى').intent).toBe('velocity');
  });
  it('«طلب شراء» is a reorder question, not an order number', () => {
    expect(u('محتاجين طلب شراء لإيه').intent).toBe('reorder');
  });
});

describe('assistant — wordings from the review log (Nov 22)', () => {
  it('«تحليل اخر اسبوع» = sales of the last 7 days', () => {
    expect(u('تحليل اخر اسبوع')).toMatchObject({ intent: 'sales', period: { key: 'last7' } });
  });
  it('«المنتج دا oriva اتباع كام مره» = how much a product sold', () => {
    expect(u('المنتج دا oriva اتباع كام مره').intent).toBe('velocity');
  });
  it('«قارن اكتوبر بشهر نوفمبر» compares two months', () => {
    expect(u('قارن اكتوبر بشهر نوفمبر')).toMatchObject({ intent: 'compare', period: { month: 9 }, period2: { month: 10 } });
  });
  it('«اخر فاتوره شراء» = latest purchase invoices', () => {
    expect(u('اخر فاتوره شراء').intent).toBe('purchases');
  });
  it('«كام موجود oriva» = stock of a product', () => {
    expect(u('كام موجود oriva')).toMatchObject({ intent: 'product', subject: 'oriva' });
  });
  it('an order number at the end of the sentence', () => {
    expect(u('الاوردر دا حالته ايه 3201')).toMatchObject({ intent: 'order', ref: '3201' });
  });
});

describe('assistant — purchasing engine questions', () => {
  it('plan, report and one product explained', () => {
    expect(u('خطة الشراء الذكية').intent).toBe('smartplan');
    expect(u('تقرير محرك الشراء').intent).toBe('engine');
    expect(u('دقة التنبؤ').intent).toBe('engine');
    expect(u('ليه مش مقترح شراء oriva runner')).toMatchObject({ intent: 'explain', subject: 'oriva runner' });
  });
  it('«ليه الأوردرات بتتلغي» is still a cancellations question', () => {
    expect(u('ليه الأوردرات بتتلغي الشهر ده').intent).toBe('cancel');
  });
});

describe('assistant — periods (Cairo calendar)', () => {
  const p = (q: string) => parsePeriod(normalizeQuestion(q), TODAY);
  it('today / yesterday', () => {
    expect(p('مبيعات النهارده')).toMatchObject({ from: TODAY, to: TODAY, key: 'today' });
    expect(p('امبارح')).toMatchObject({ from: '2026-11-21', to: '2026-11-21' });
  });
  it('this week starts Saturday', () => {
    expect(p('الاسبوع ده')).toMatchObject({ from: '2026-11-21', to: TODAY });
  });
  it('last month and named months (a later month means last year)', () => {
    expect(p('الشهر اللي فات')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(p('أكتوبر')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(p('ديسمبر')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });
  it('«this week compared with last week» reads THIS week', () => {
    expect(p('مبيعات هذا الأسبوع مقارنة بالأسبوع الماضي')).toMatchObject({ key: 'week', from: '2026-11-21' });
  });
  it('no period → this month, marked assumed', () => {
    expect(p('مبيعات')).toMatchObject({ from: '2026-11-01', to: TODAY, assumed: true });
  });
  it('a running month compares with the same days of the month before', () => {
    expect(previousPeriod(p('الشهر ده'))).toEqual({ from: '2026-10-01', to: '2026-10-22' });
    expect(previousPeriod(p('النهارده'))).toEqual({ from: '2026-11-21', to: '2026-11-21' });
    expect(previousPeriod(p('الاسبوع ده'))).toEqual({ from: '2026-11-14', to: '2026-11-15' });
  });
  it('customers needing follow-up: this month by default, before cancel/orders words', () => {
    for (const q of ['العملاء الذين يحتاجون متابعة هذا الشهر', 'العملا الشهر الحالي اللي محتاجين متابعه', 'مين محتاج متابعة', 'اوردرات المتابعة الشهر ده', 'customers needing follow-up this month']) {
      const r = u(q);
      expect([q, r.intent]).toEqual([q, 'followups']);
      expect(r.period!.from).toBe('2026-11-01');
    }
    expect(u('متابعات الشهر الماضي').period!.key).toBe('lastMonth');
    expect(u('متابعة اوردر 3201').intent).toBe('order');
  });
});
