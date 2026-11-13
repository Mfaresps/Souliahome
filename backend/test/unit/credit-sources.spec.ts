import { allocateCreditSources } from '../../src/supplier-ledger/credit-sources.util';

export {};

describe('allocateCreditSources — where a purchase invoice\'s supplier credit came from', () => {
  it('names the advance payment and its vault (#900021: 7,000 of credit)', () => {
    const rows = [
      { entryType: 'purchase-debt', amount: 3000, date: '2026-10-01' },
      { entryType: 'payment', amount: -3000, date: '2026-10-05' },
      { entryType: 'advance-deposit', amount: -7000, date: '2026-11-01', vaultSeg: 'Instapay', vaultTxNo: 'TXN-120' },
      { entryType: 'purchase-debt', amount: 5000, date: '2026-11-13' },
      { entryType: 'credit-used', amount: 7000, date: '2026-11-13' },
    ];
    expect(allocateCreditSources(rows, 4)).toEqual([
      expect.objectContaining({ amount: 7000, entryType: 'advance-deposit', vaultSeg: 'Instapay', vaultTxNo: 'TXN-120', date: '2026-11-01' }),
    ]);
  });

  it('an advance that first clears debt only contributes what is left over', () => {
    const rows = [
      { entryType: 'purchase-debt', amount: 2000 },
      { entryType: 'advance-deposit', amount: -5000, vaultSeg: 'كاش' },
      { entryType: 'credit-used', amount: 3000 },
    ];
    expect(allocateCreditSources(rows, 2)).toEqual([expect.objectContaining({ amount: 3000, vaultSeg: 'كاش' })]);
  });

  it('splits FIFO across two sources, oldest first, and skips credit already used', () => {
    const rows = [
      { entryType: 'return-credit', amount: -1000, sourceRef: 'SR-1' },
      { entryType: 'advance-deposit', amount: -4000, vaultSeg: 'كاش' },
      { entryType: 'credit-used', amount: 500 },
      { entryType: 'credit-used', amount: 2000 },
    ];
    const out = allocateCreditSources(rows, 3);
    expect(out.map((s) => [s.entryType, s.amount])).toEqual([['return-credit', 500], ['advance-deposit', 1500]]);
  });

  it('returns nothing when there was no credit to draw on', () => {
    expect(allocateCreditSources([{ entryType: 'credit-used', amount: 100 }], 0)).toEqual([]);
  });
});
