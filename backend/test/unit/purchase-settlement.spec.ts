import {
  allocateReturnOffset,
  openingPurchaseDeposit,
  purchaseOwedAfterEdit,
  purchaseCancellationLedgerDelta,
  purchaseCancellationRefunds,
} from '../../src/shared/purchase-settlement.util';

const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

describe('purchase cancellation — cash goes back only where it came from', () => {
  it('ordinary invoice, one vault: same result as before (deposit back, remaining off the ledger)', () => {
    const tx = { total: 10000, deposit: 4000, remaining: 6000, depMethod: 'كاش', payments: [] };
    expect(purchaseCancellationRefunds(tx)).toEqual([{ method: 'كاش', amount: 4000, kind: 'opening-deposit' }]);
    expect(purchaseCancellationLedgerDelta(tx)).toBe(-6000);
  });

  it('deposit + payment from another vault: each vault gets back its own money', () => {
    const tx = {
      total: 10000, deposit: 10000, remaining: 0, depMethod: 'كاش', collectMethod: 'Instapay',
      payments: [{ amount: 8000, method: 'Instapay' }],
    };
    expect(purchaseCancellationRefunds(tx)).toEqual([
      { method: 'كاش', amount: 2000, kind: 'opening-deposit' },
      { method: 'Instapay', amount: 8000, kind: 'payment' },
    ]);
  });

  it('a write-off is never refunded as cash', () => {
    // 6,000 paid via collect, 4,000 waived. Old rule refunded 10,000.
    const tx = {
      total: 10000, deposit: 6000, remaining: 0, depMethod: 'كاش', collectMethod: 'كاش',
      payments: [{ amount: 6000, method: 'كاش' }], writeOff: { amount: 4000 },
    };
    expect(sum(purchaseCancellationRefunds(tx))).toBe(6000);
    expect(purchaseCancellationLedgerDelta(tx)).toBe(0);
  });

  it('supplier credit is not refunded as cash and returns to the supplier balance', () => {
    // total 10,000: credit 7,000 + Instapay payment 1,000, 2,000 still open.
    const tx = {
      total: 10000, deposit: 1000, remaining: 2000, depMethod: 'كاش', collectMethod: 'Instapay',
      creditApplied: 7000, payments: [{ amount: 1000, method: 'Instapay' }],
    };
    expect(purchaseCancellationRefunds(tx)).toEqual([{ method: 'Instapay', amount: 1000, kind: 'payment' }]);
    // ledger: debt +2,000 net of credit … −(2,000 open + 7,000 credit) → the 7,000 credit is back.
    expect(purchaseCancellationLedgerDelta(tx)).toBe(-9000);
  });

  it('reversed payments are not refunded (their undo already returned them)', () => {
    const tx = {
      total: 1000, deposit: 300, remaining: 700, depMethod: 'كاش',
      payments: [{ amount: 300, method: 'كاش' }, { amount: 200, method: 'Instapay', reversed: true }],
    };
    expect(purchaseCancellationRefunds(tx)).toEqual([{ method: 'كاش', amount: 300, kind: 'payment' }]);
  });

  it('legacy invoice whose payments were kept outside deposit still refunds them (old behaviour)', () => {
    const tx = { total: 5000, deposit: 1000, remaining: 0, depMethod: 'كاش', collectMethod: 'تحويل بنكي', payments: [] };
    expect(purchaseCancellationRefunds(tx)).toEqual([
      { method: 'كاش', amount: 1000, kind: 'opening-deposit' },
      { method: 'تحويل بنكي', amount: 4000, kind: 'legacy-payment' },
    ]);
  });

  it('total refunded never exceeds cash that actually left (deposit)', () => {
    const tx = {
      total: 9000, deposit: 5000, remaining: 0, depMethod: 'كاش', collectMethod: 'Instapay',
      creditApplied: 1000, writeOff: { amount: 3000 }, payments: [{ amount: 3000, method: 'Instapay' }],
    };
    expect(sum(purchaseCancellationRefunds(tx))).toBe(5000);
  });
});

describe('opening deposit of a purchase', () => {
  it('is deposit minus live payments', () => {
    expect(openingPurchaseDeposit({ deposit: 5000, payments: [{ amount: 3000 }, { amount: 500, reversed: true }] })).toBe(2000);
  });
  it('falls back to the whole deposit for legacy rows', () => {
    expect(openingPurchaseDeposit({ deposit: 1000, payments: [{ amount: 4000 }] })).toBe(1000);
  });
});

describe('what a purchase owes after an edit', () => {
  const owe = (a: any) => purchaseOwedAfterEdit({ credit: 0, returnOffset: 0, writeOff: 0, ...a });
  it('a written-off invoice stays closed when only a note is edited', () => {
    expect(owe({ newTotal: 10000, newDeposit: 6000, writeOff: 4000 })).toEqual({ owed: 0, remaining: 0 });
  });
  it('raising the total after a write-off adds only the new amount', () => {
    expect(owe({ newTotal: 12000, newDeposit: 6000, writeOff: 4000 }).remaining).toBe(2000);
  });
  it('a waiver never pushes the invoice into credit', () => {
    expect(owe({ newTotal: 8000, newDeposit: 6000, writeOff: 4000 })).toEqual({ owed: 0, remaining: 0 });
  });
  it('a return offset is real value: a total below it is owed back', () => {
    // total 10,000, 3,000 offset by a return; total corrected to 2,000 → supplier owes us 1,000.
    expect(owe({ newTotal: 2000, newDeposit: 0, returnOffset: 3000 })).toEqual({ owed: -1000, remaining: 0 });
  });
  it('a return offset survives an unrelated edit', () => {
    expect(owe({ newTotal: 10000, newDeposit: 2000, returnOffset: 3000 }).remaining).toBe(5000);
  });
  it('without credit, offset or waiver it is the old rule', () => {
    expect(owe({ newTotal: 10000, newDeposit: 2000, credit: 3000 }).remaining).toBe(5000);
  });
});

describe('spreading a supplier return over open invoices', () => {
  const inv = [
    { id: 'A', ref: 'A', remaining: 5000, date: '2026-10-01' },
    { id: 'B', ref: 'B', remaining: 2000, date: '2026-09-01' },
    { id: 'C', ref: 'C', remaining: 4000, date: '2026-11-01' },
  ];
  it('the invoice the goods came from first, up to the returned value from it', () => {
    const r = allocateReturnOffset(3000, inv, [{ id: 'C', cap: 3000 }]);
    expect(r.rows).toEqual([{ id: 'C', ref: 'C', amount: 3000 }]);
    expect(r.unallocated).toBe(0);
  });
  it('then the oldest open invoices', () => {
    const r = allocateReturnOffset(6000, inv, [{ id: 'C', cap: 3000 }]);
    expect(r.rows).toEqual([{ id: 'C', ref: 'C', amount: 3000 }, { id: 'B', ref: 'B', amount: 2000 }, { id: 'A', ref: 'A', amount: 1000 }]);
  });
  it('never more than an invoice remaining; the rest stays ledger-only', () => {
    const r = allocateReturnOffset(12000, inv, [{ id: 'C', cap: 9000 }]);
    expect(r.rows.reduce((s, x) => s + x.amount, 0)).toBe(11000);
    expect(r.unallocated).toBe(1000);
  });
  it('a linked invoice that is no longer open is skipped', () => {
    const r = allocateReturnOffset(1000, inv, [{ id: 'Z', cap: 1000 }]);
    expect(r.rows).toEqual([{ id: 'B', ref: 'B', amount: 1000 }]);
  });
  it('rounds to the piastre', () => {
    const r = allocateReturnOffset(0.1 + 0.2, [{ id: 'A', ref: 'A', remaining: 1 }]);
    expect(r.rows[0].amount).toBe(0.3);
  });
});
