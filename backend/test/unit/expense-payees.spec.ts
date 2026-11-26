import { Types } from 'mongoose';
import { ExpensesService } from '../../src/expenses/expenses.service';
import {
  checkPeriod, expenseInWindow, expenseWindowClause, payeeKindForCategory, payeeNameKey, periodsOverlap,
} from '../../src/expenses/expense-payee.util';

export {};

/* ── tiny in-memory model, enough for ExpensesService's payee paths ── */
function fakeModel() {
  const rows: any[] = [];
  const doc = (r: any) => Object.assign(r, { save: async () => r, toObject: () => ({ ...r }) });
  const match = (r: any, f: any) => Object.entries(f || {}).every(([k, v]: any) => {
    if (k === '_id' && v && v.$ne) return String(r._id) !== String(v.$ne);
    if (v && typeof v === 'object' && '$ne' in v) return r[k] !== v.$ne;
    return String(r[k]) === String(v);
  });
  const q = (val: any) => ({ exec: async () => val, lean: () => ({ exec: async () => val }), sort: () => q(val) });
  return {
    rows,
    findById: (id: string) => q(rows.find(r => String(r._id) === String(id)) || null),
    findOne: (f: any) => q(rows.find(r => match(r, f)) || null),
    find: (f: any) => q(rows.filter(r => match(r, f))),
    create: async (data: any) => { const r = doc({ _id: new Types.ObjectId(), ...data }); rows.push(r); return r; },
    updateOne: (f: any, u: any) => ({ exec: async () => { const r = rows.find(x => String(x._id) === String(f._id)); if (r) Object.assign(r, u.$set); } }),
  };
}

function makeService() {
  const expenses = fakeModel();
  const payees = fakeModel();
  const service: any = new ExpensesService(expenses as any, payees as any, {} as any);
  service.notifications = { enqueue: jest.fn(async () => {}) };
  return { service, expenses, payees };
}

const admin = { name: 'Admin', isAdmin: true };
const staff = { name: 'Reem', isAdmin: false };
const base = { date: '2026-11-26', desc: 'x', amount: 5000, account: 'كاش' };

describe('expense payee rules', () => {
  it('maps the three categories to their kind and nothing else', () => {
    expect(payeeKindForCategory('اعلانات')).toBe('ads');
    expect(payeeKindForCategory('مرتبات')).toBe('salary');
    expect(payeeKindForCategory('اشتراكات')).toBe('subscription');
    expect(payeeKindForCategory('إيجارات')).toBeNull();
  });
  it('treats spelling variants of one name as the same key', () => {
    expect(payeeNameKey('  Meta   Ads ')).toBe(payeeNameKey('meta ads'));
    expect(payeeNameKey('شركة أحمد')).toBe(payeeNameKey('شركه احمد'));
  });
  it('validates a period', () => {
    expect(checkPeriod('', '')).toEqual({ from: '', to: '' });
    expect(checkPeriod('2026-11-01', '2026-11-30')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect('error' in checkPeriod('2026-11-30', '2026-11-01')).toBe(true);
    expect('error' in checkPeriod('2026-11-01', '')).toBe(true);
    expect('error' in checkPeriod('2026-02-30', '2026-03-01')).toBe(true);
    expect('error' in checkPeriod('2026-01-01', '2027-06-01')).toBe(true);
  });
  it('places an ad by the period it pays for, an old row by its date', () => {
    // November ads entered on Dec 3 belong to November, not December.
    const ad = { date: '2026-12-03', periodFrom: '2026-11-01', periodTo: '2026-11-30' };
    expect(expenseInWindow(ad, '2026-11-01', '2026-11-30')).toBe(true);
    expect(expenseInWindow(ad, '2026-12-01', '2026-12-31')).toBe(false);
    expect(expenseInWindow({ date: '2026-12-03T10:00:00.000Z' }, '2026-12-01', '2026-12-03')).toBe(true);
    expect(periodsOverlap('2026-11-01', '2026-11-30', '2026-11-30', '2026-12-05')).toBe(true);
    const clause: any = expenseWindowClause('2026-11-01', '2026-11-30');
    expect(clause.$or[1].date.$lt).toBe('2026-12-01');
  });
});

describe('ExpensesService — payees on expenses', () => {
  it('stores the payee name and period on the expense and marks the payee as used', async () => {
    const { service, payees } = makeService();
    const agency = await service.createPayee({ kind: 'ads', name: 'Nova Media', platform: 'meta', amount: 8000 }, staff);
    const exp = await service.create({ ...base, category: 'اعلانات', payeeId: agency._id, periodFrom: '2026-11-01', periodTo: '2026-11-30' }, staff);
    expect(exp.payeeName).toBe('Nova Media');
    expect(exp.payeeKind).toBe('ads');
    expect(exp.periodFrom).toBe('2026-11-01');
    expect(exp.updatePayeeAmount).toBeUndefined();
    expect(payees.rows[0].lastUsedAt).toBeTruthy();
    expect(payees.rows[0].amount).toBe(8000); // not asked to change
  });

  it('refuses a payee from another category, a missing one and a bad period', async () => {
    const { service } = makeService();
    const sub = await service.createPayee({ kind: 'subscription', name: 'Shopify', amount: 1500 }, staff);
    await expect(service.create({ ...base, category: 'اعلانات', payeeId: sub._id }, staff)).rejects.toThrow('لا تتبع');
    await expect(service.create({ ...base, category: 'اعلانات', payeeId: String(new Types.ObjectId()) }, staff)).rejects.toThrow('غير موجودة');
    await expect(service.create({ ...base, category: 'اشتراكات', payeeId: sub._id, periodFrom: '2026-11-30', periodTo: '2026-11-01' }, staff)).rejects.toThrow('بعد نهايتها');
  });

  it('drops the payee when the category has none', async () => {
    const { service } = makeService();
    const sub = await service.createPayee({ kind: 'subscription', name: 'Shopify' }, staff);
    const exp = await service.create({ ...base, category: 'إيجارات', payeeId: sub._id, periodFrom: '2026-11-01', periodTo: '2026-11-30' }, staff);
    expect(exp.payeeId).toBe('');
    expect(exp.periodFrom).toBe('2026-11-01');
  });

  it('keeps salaries private: only an admin adds an employee or reads/changes the amount', async () => {
    const { service, payees } = makeService();
    await expect(service.createPayee({ kind: 'salary', name: 'Ahmed', amount: 9000 }, staff)).rejects.toThrow('للمدير');
    const emp = await service.createPayee({ kind: 'salary', name: 'Ahmed', amount: 9000 }, admin);
    const seenByStaff = await service.listPayees('salary', false, false);
    expect(seenByStaff[0].amount).toBe(0);
    expect(seenByStaff[0].amountHidden).toBe(true);
    expect((await service.listPayees('salary', false, true))[0].amount).toBe(9000);
    await service.create({ ...base, amount: 1, category: 'مرتبات', payeeId: emp._id, updatePayeeAmount: true }, staff);
    expect(payees.rows[0].amount).toBe(9000);
    await service.create({ ...base, amount: 9500, category: 'مرتبات', payeeId: emp._id, updatePayeeAmount: true }, admin);
    expect(payees.rows[0].amount).toBe(9500);
  });

  it('refuses a duplicate name, and brings an archived one back instead', async () => {
    const { service } = makeService();
    const first = await service.createPayee({ kind: 'ads', name: 'Nova Media' }, staff);
    await expect(service.createPayee({ kind: 'ads', name: ' nova  media ' }, staff)).rejects.toThrow('مسجّل بالفعل');
    await service.updatePayee(first._id, { active: false }, admin);
    await expect(service.create({ ...base, category: 'اعلانات', payeeId: first._id }, staff)).rejects.toThrow('مؤرشفة');
    const back = await service.createPayee({ kind: 'ads', name: 'Nova Media', platform: 'tiktok' }, staff);
    expect(back._id).toBe(first._id);
    expect(back.active).toBe(true);
    expect(back.platform).toBe('tiktok');
  });

  it('lets an old pending expense keep an archived payee when edited', async () => {
    const { service, expenses } = makeService();
    const agency = await service.createPayee({ kind: 'ads', name: 'Nova Media' }, staff);
    const exp = await service.create({ ...base, category: 'اعلانات', payeeId: agency._id }, staff);
    await service.updatePayee(agency._id, { active: false }, admin);
    const saved = await service.update(String(exp._id), { notes: 'edited' }, staff);
    expect(saved.payeeId).toBe(agency._id);
    expect(expenses.rows[0].notes).toBe('edited');
  });

  it('computes the salary net on the server and posts it as the amount', async () => {
    const { service, payees } = makeService();
    const emp = await service.createPayee({ kind: 'salary', name: 'Ahmed', amount: 6000, pointValue: 2 }, admin);
    const exp = await service.create({
      ...base, amount: 1, category: 'مرتبات', payeeId: emp._id, periodFrom: '2026-11-01', periodTo: '2026-11-30',
      salary: { base: 6000, points: 200, pointValue: 2, pointsBonus: 99999, net: 1, overtime: 300, deductions: 150, deductionsNote: 'تأخير', pointsMonth: '2026-11' },
      updatePayeeAmount: true,
    }, admin);
    expect(exp.salary.pointsBonus).toBe(400);
    expect(exp.salary.net).toBe(6550);
    expect(exp.amount).toBe(6550);
    expect(payees.rows[0].amount).toBe(6000);
    expect(payees.rows[0].pointValue).toBe(2);
  });

  it('refuses a salary that nets to zero or a negative line, and gives no bonus for negative points', async () => {
    const { cleanSalaryBreakdown } = require('../../src/expenses/expense-payee.util');
    expect(cleanSalaryBreakdown({ base: 100, deductions: 100 }).error).toMatch('أكبر من صفر');
    expect(cleanSalaryBreakdown({ base: 100, overtime: -5 }).error).toMatch('سالب');
    const r = cleanSalaryBreakdown({ base: 1000, points: -30, pointValue: 2 });
    expect(r.pointsBonus).toBe(0);
    expect(r.net).toBe(1000);
  });

  it('keeps the stored breakdown on an unrelated edit and drops it outside «مرتبات»', async () => {
    const { service } = makeService();
    const emp = await service.createPayee({ kind: 'salary', name: 'Ahmed', amount: 5000 }, admin);
    const exp = await service.create({ ...base, category: 'مرتبات', payeeId: emp._id, salary: { base: 5000, points: 10, pointValue: 1 } }, admin);
    const kept = await service.update(String(exp._id), { notes: 'x' }, admin);
    expect(kept.salary.net).toBe(5010);
    expect(kept.amount).toBe(5010);
    const moved = await service.update(String(exp._id), { category: 'اخرى', amount: 70 }, admin);
    expect(moved.salary).toBeNull();
    expect(moved.amount).toBe(70);
  });

  it('only an admin edits a saved payee', async () => {
    const { service } = makeService();
    const agency = await service.createPayee({ kind: 'ads', name: 'Nova Media' }, staff);
    await expect(service.updatePayee(agency._id, { name: 'Nova' }, staff)).rejects.toThrow('للمدير');
  });
});
