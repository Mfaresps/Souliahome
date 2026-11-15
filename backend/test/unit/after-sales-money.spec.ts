import { afterSalesMoneyOf, effectivePayStatus } from '../../src/shared/after-sales-money.util';
import { buildMovementsPage } from '../../src/transactions/movements-page.util';

describe('after-sales money on the Movements page', () => {
  const quote = (extra: any = {}) => ({ credit: 1812, replacement: 1812, customerFee: 0, collectDue: 0, refundDue: 0, creditApplied: 1812, ...extra });
  const caseRow = (extra: any = {}, workflow: any = {}) => ({ _id: 'c1', requestKind: 'exchange', ...extra,
    workflow: { version: 2, ref: 'AS-2026-000005', replacementRef: '202680000005', fulfillmentChannel: 'bosta', quote: quote(), ...workflow } });
  const rt = (extra: any = {}) => ({ _id: 'rt', type: 'مرتجع', ref: 'RT-2026-000005', total: 1812, deposit: 0, remaining: 0, payStatus: 'مكتمل',
    afterSales: { caseId: 'c1', caseRef: 'AS-2026-000005', kind: 'exchange', role: 'return' }, ...extra });

  it('an exchange return document: the credit is settled by the replacement', () => {
    expect(afterSalesMoneyOf(rt(), caseRow())).toMatchObject({ paid: 1812, remaining: 0, state: 'settled', payStatus: 'مكتمل', creditApplied: 1812 });
  });
  it('a cheaper replacement leaves a refund owed to the customer until it is paid', () => {
    const row = caseRow({}, { quote: quote({ replacement: 1500, creditApplied: 1500, refundDue: 312 }) });
    expect(afterSalesMoneyOf(rt(), row)).toMatchObject({ paid: 1500, remaining: 312, direction: 'to-customer', state: 'refund-due', payStatus: 'معلق' });
    row.workflow.refund = { amount: 312 };
    expect(afterSalesMoneyOf(rt(), row)).toMatchObject({ paid: 1812, remaining: 0, state: 'refunded', payStatus: 'مكتمل' });
  });
  it('a plain return: paid = refund paid, the fee is not owed', () => {
    const row = caseRow({ requestKind: 'return' }, { quote: { credit: 1752, replacement: 0, customerFee: 50, collectDue: 0, refundDue: 1702, creditApplied: 0 } });
    const doc = rt({ afterSales: { caseId: 'c1', kind: 'return', role: 'return' } });
    expect(afterSalesMoneyOf(doc, row)).toMatchObject({ paid: 0, remaining: 1702, state: 'refund-due', fee: 50 });
    row.workflow.refund = { amount: 1702 };
    expect(afterSalesMoneyOf(doc, row)).toMatchObject({ paid: 1702, remaining: 0, state: 'refunded' });
  });
  it('the replacement sale: its own figures, and who collects the rest', () => {
    const repl = { _id: 'r', type: 'مبيعات', total: 650, deposit: 600, remaining: 50, payStatus: 'معلق', afterSales: { caseId: 'c1', role: 'replacement' } };
    const row = caseRow({}, { quote: quote({ credit: 500, replacement: 600, customerFee: 50, collectDue: 150, creditApplied: 500 }) });
    expect(afterSalesMoneyOf(repl, row)).toMatchObject({ paid: 600, remaining: 50, direction: 'from-customer', state: 'due' });
    row.workflow.shipment = { status: 'created' };
    expect(afterSalesMoneyOf(repl, row)).toMatchObject({ state: 'with-carrier' });
    expect(afterSalesMoneyOf({ ...repl, remaining: 0, deposit: 650 }, row)).toMatchObject({ state: 'settled', payStatus: 'مكتمل' });
  });
  it('never applies a case that is not this document\'s', () => {
    expect(afterSalesMoneyOf(rt({ afterSales: { caseId: 'other', role: 'return' } }), caseRow())).toBeNull();
    expect(effectivePayStatus({ payStatus: 'مكتمل' })).toBe('مكتمل');
  });

  it('splits «استبدال» from «مرتجعات» and filters by the case status', () => {
    const owed = caseRow({ _id: 'c2' }, { quote: quote({ replacement: 1500, creditApplied: 1500, refundDue: 312 }) });
    const plain = caseRow({ _id: 'c3', requestKind: 'return' }, { quote: { credit: 1752, replacement: 0, customerFee: 0, collectDue: 0, refundDue: 1752, creditApplied: 0 }, refund: { amount: 1752 } });
    const txs = [
      { _id: 's1', type: 'مبيعات', ref: '3163', payStatus: 'مكتمل', createdAt: '2026-11-14' },
      rt({ _id: 'rt2', afterSales: { caseId: 'c2', kind: 'exchange', role: 'return' }, createdAt: '2026-11-14' }),
      rt({ _id: 'rt3', ref: 'RT-2026-000003', afterSales: { caseId: 'c3', kind: 'return', role: 'return' }, createdAt: '2026-11-08' }),
      { _id: 'ex', type: 'مبيعات', ref: '202680000005', payStatus: 'مكتمل', createdAt: '2026-11-14', afterSales: { caseId: 'c2', role: 'replacement' } },
    ];
    const page = (type: string, extra: any = {}) => buildMovementsPage(txs.map(t => ({ ...t })), [owed, plain], [], { type, limit: 50, ...extra } as any);
    const all = page('all');
    expect(all.tabCounts).toMatchObject({ returns: 1, exchanges: 2 });
    expect(page('مرتجع').pageRows.map((r: any) => r.tx?._id)).toEqual(['rt3']);
    expect(page('استبدال').pageRows.filter((r: any) => r.k === 'tx').map((r: any) => r.tx._id).sort()).toEqual(['ex', 'rt2']);
    expect(all.pageRows.find((r: any) => r.tx?._id === 'rt2').tx.afterSalesMoney).toMatchObject({ remaining: 312, state: 'refund-due' });
    // «معلق» now finds the exchange whose refund is still owed, though its stored payStatus says «مكتمل».
    expect(page('all', { drawerStatus: ['معلق'] }).pageRows.filter((r: any) => r.k === 'tx').map((r: any) => r.tx._id)).toEqual(['rt2']);
  });
});
