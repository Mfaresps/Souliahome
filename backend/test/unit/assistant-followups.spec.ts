import { understand } from '../../src/assistant/assistant-intent.util';
import { compareUrgency, followUpUrgency, moreUrgent } from '../../src/assistant/followup-priority.util';

const TODAY = '2026-11-23';
const u = (q: string) => understand(q, TODAY);

describe('assistant — customers needing follow-up', () => {
  const WORDINGS = [
    'العملا الشهر الحالي اللي محتاجين متابعه',
    'العملاء الذين يحتاجون متابعة هذا الشهر',
    'مين العملاء اللي محتاجين متابعة',
    'العملاء المحتاجين متابعة',
    'متابعات الشهر ده',
    'المتابعات المفتوحة',
    'مين محتاج نتابع معاه',
    'لازم نتابع مع مين',
    'عايز اتابع مع العملاء',
    'العملاء اللي لسه هنتابعهم',
    'مين العملاء اللي لازم نكلمهم',
    'نكلم مين النهارده',
    'نتصل بمين من العملاء',
    'العملاء اللي مردوش',
    'العملاء اللي مش بيردوا',
    'مين مابيردوش علينا',
    'العملاء اللي لم يردوا',
    'العملاء بانتظار العميل',
    'الطلبات في انتظار رد العميل',
    'عملاء منتظرين رد',
    'العملاء المعلقين',
    'نرجع للعملاء مين',
    'التواصل مع العملاء هذا الشهر',
    'اوردرات محتاجة متابعة',
    'الأوردرات اللي عليها متابعة',
    'المتابعات المتأخرة',
    'المتابعات الأقل أهمية',
    'customers needing follow-up this month',
    'follow ups this month',
    'who should we call back',
    'customers awaiting customer reply',
  ];
  it(`understands ${WORDINGS.length} wordings`, () => {
    expect(WORDINGS.length).toBeGreaterThan(20);
    for (const q of WORDINGS) expect([q, u(q).intent]).toEqual([q, 'followups']);
  });

  it('this month by default; other periods follow the question', () => {
    expect(u('المتابعات المفتوحة').period).toMatchObject({ from: '2026-11-01', to: '2026-11-23' });
    expect(u('متابعات الشهر الماضي').period!.key).toBe('lastMonth');
    expect(u('متابعات هذا الأسبوع').period!.key).toBe('week');
  });

  it('least urgent first only when asked', () => {
    expect(u('المتابعات الأقل أهمية').reverse).toBe(true);
    expect(u('المتابعات الاقل تأخيرا').reverse).toBe(true);
    expect(u('المتابعات المتأخرة').reverse).toBe(false);
  });

  it('does not take other questions', () => {
    expect(u('متابعة اوردر 3201').intent).toBe('order');
    expect(u('نكلم المورد امتى').intent).not.toBe('followups');
    expect(u('آخر فاتورة شراء').intent).toBe('purchases');
    expect(u('purchase plan').intent).toBe('smartplan');
    expect(u('أسباب إلغاء الأوردرات هذا الشهر').intent).toBe('cancel');
  });
});

describe('follow-up priority by delay', () => {
  const NOW = Date.UTC(2026, 10, 23, 12);
  const H = 3600_000;
  const ago = (h: number) => new Date(NOW - h * H);

  it('levels: 48h urgent, 24h late, 12h due, else new', () => {
    expect(followUpUrgency({ createdAt: ago(50) }, NOW).level).toBe('urgent');
    expect(followUpUrgency({ createdAt: ago(30) }, NOW).level).toBe('late');
    expect(followUpUrgency({ createdAt: ago(13) }, NOW).level).toBe('due');
    expect(followUpUrgency({ createdAt: ago(2) }, NOW).level).toBe('new');
  });

  it('waits from the last status change, not from creation', () => {
    expect(followUpUrgency({ createdAt: ago(100), escalationBaseline: ago(5) }, NOW)).toMatchObject({ level: 'new', hours: 5 });
  });

  it('a future deferral is lowest; a passed one waits from the deferral time', () => {
    expect(followUpUrgency({ createdAt: ago(100), deferredUntil: new Date(NOW + 5 * H) }, NOW).level).toBe('deferred');
    expect(followUpUrgency({ createdAt: ago(100), deferredUntil: ago(26) }, NOW)).toMatchObject({ level: 'late', hours: 26 });
  });

  it('a customer takes their most urgent follow-up; sorting puts urgent first, longest wait first', () => {
    const a = moreUrgent(followUpUrgency({ createdAt: ago(3) }, NOW), followUpUrgency({ createdAt: ago(60) }, NOW));
    expect(a.level).toBe('urgent');
    const rows = [
      { id: 'new', u: followUpUrgency({ createdAt: ago(1) }, NOW), orders: 5 },
      { id: 'def', u: followUpUrgency({ deferredUntil: new Date(NOW + H) }, NOW), orders: 9 },
      { id: 'urg60', u: followUpUrgency({ createdAt: ago(60) }, NOW), orders: 1 },
      { id: 'late', u: followUpUrgency({ createdAt: ago(25) }, NOW), orders: 1 },
      { id: 'urg90', u: followUpUrgency({ createdAt: ago(90) }, NOW), orders: 1 },
    ];
    expect(rows.sort(compareUrgency).map((r) => r.id)).toEqual(['urg90', 'urg60', 'late', 'new', 'def']);
  });
});
