import { buildFifoPreview, FifoHistory } from '../../src/inventory-costing/fifo-preview';

export {};

const T = (d: number, h = 0) => new Date(Date.UTC(2026, 0, d, h));
const iso = (d: number) => T(d).toISOString().slice(0, 10);

/**
 * A: opening 2 (card 90 at creation, 100 now), invoice P1 5 × 80, sale S1 of 3.
 * B: opening was 10, sold 4, then zeroed on day 5 — the CUS-45 shape.
 * C: invoice P2 entered day 4; sale S3 entered day 3 but C was added to it in an edit on day 4.
 */
function history(): FifoHistory {
  const products = [
    { _id: 'pa', code: 'A', name: 'A', buyPrice: 100, openingBalance: 2, createdAt: T(1), activityLog: [{ at: T(6), changes: [{ field: 'buyPrice', oldValue: 90, newValue: 100 }] }] },
    { _id: 'pb', code: 'B', name: 'B', buyPrice: 75, openingBalance: 0, createdAt: T(1), activityLog: [{ at: T(5), by: 'X', changes: [{ field: 'openingBalance', oldValue: 10, newValue: 0 }] }] },
    { _id: 'pc', code: 'C', name: 'C', buyPrice: 50, openingBalance: 0, createdAt: T(1) },
  ];
  const transactions = [
    { _id: 'P1', type: 'مشتريات', ref: 'P1', date: iso(2), createdAt: T(2), items: [{ code: 'A', qty: 5, price: 80, total: 400 }] },
    { _id: 'S1', type: 'مبيعات', ref: 'S1', date: iso(3), createdAt: T(3), items: [{ code: 'A', qty: 3, price: 200, total: 600 }] },
    { _id: 'S2', type: 'مبيعات', ref: 'S2', date: iso(3), createdAt: T(3, 1), items: [{ code: 'B', qty: 4, price: 150, total: 600, unitCost: 77, costSource: 'sale-snapshot' }] },
    { _id: 'P2', type: 'مشتريات', ref: 'P2', date: iso(4), createdAt: T(4), items: [{ code: 'C', qty: 2, price: 50, total: 100 }] },
    { _id: 'S3', type: 'مبيعات', ref: 'S3', date: iso(3), createdAt: T(3, 2), items: [{ code: 'C', qty: 1, price: 120, total: 120 }] },
  ];
  const movements = [
    { sourceTransactionId: 'S1', productCode: 'A', qtyDelta: -3, createdAt: T(3) },
    { sourceTransactionId: 'S3', productCode: 'C', qtyDelta: -1, createdAt: T(4, 3) },   // added in an edit after P2
    { sourceTransactionId: 'P2', productCode: 'C', qtyDelta: 2, createdAt: T(4) },
  ];
  return { products, transactions, movements, returnRequests: [], supplierReturnOrders: [], adjustments: [], units: [], productSuppliers: [], suppliers: [] } as any;
}
const line = (p: any, ref: string): any => p.saleLines.find((l: any) => l.ref === ref);
const by = (rows: any[], code: string): any => rows.find((r: any) => r.code === code);

describe('FIFO preview — the owner\'s decisions', () => {
  it('opening cost is proposed (card at creation), never adopted: lines using it stay «opening-pending»', () => {
    const p = buildFifoPreview(history());
    const a = by(p.opening, 'A');
    expect(a).toMatchObject({ proposedCost: 90, proposedSource: 'card-at-creation', status: 'pending', approvedCost: null });
    expect(line(p, 'S1').status).toBe('opening-pending');
    expect(line(p, 'S1').costAfter).toBe(2 * 90 + 80);
    expect(p.blockers.join(' ')).toContain('رصيده الافتتاحي');
    expect(p.approvable).toBe(false);
  });

  it('approving or editing one product\'s opening cost traces its lines, and touches no other product', () => {
    const approve = buildFifoPreview(history(), { decisions: { opening: { A: { decision: 'approve' } } } });
    expect(line(approve, 'S1').status).toBe('traced');
    const edit = buildFifoPreview(history(), { decisions: { opening: { A: { decision: 'edit', cost: 95 } } } });
    expect(line(edit, 'S1').costAfter).toBe(2 * 95 + 80);
    expect(by(edit.opening, 'A').approvedCost).toBe(95);
    expect(line(edit, 'S2').status).toBe('unresolved');
  });

  it('an edit with no cost is rejected and the product stays pending', () => {
    const p = buildFifoPreview(history(), { decisions: { opening: { A: { decision: 'edit' } } } });
    expect(by(p.opening, 'A').status).toBe('pending');
    expect(p.decisionErrors).toEqual([expect.objectContaining({ area: 'opening', code: 'A' })]);
  });

  it('an unresolved shortfall keeps today\'s cost UNCHANGED, is marked, and names the zeroed opening', () => {
    const p = buildFifoPreview(history());
    const s2 = line(p, 'S2');
    expect(s2).toMatchObject({ status: 'unresolved', unresolvedQty: 4, costAfter: 308, costBefore: 308 });   // its own saved 77, not the card 75
    const sku = by(p.shortfallSkus, 'B');
    expect(sku).toMatchObject({ status: 'unresolved', openShortBefore: 4, openingBefore: 10, decisionText: 'معلق — غير محسوم' });
    expect(sku.suggestion).toContain('10');
    expect(by(p.shortfalls, 'B').cause).toBe('opening-lowered');
  });

  it('opening batch + write-off of the rest on the zeroing date: traced, stock reconciles, write-off kept apart', () => {
    const p = buildFifoPreview(history(), { decisions: { shortfalls: { B: { resolution: 'opening-batch', qty: 10, unitCost: 70, remainder: 'write-off' } } } });
    expect(line(p, 'S2')).toMatchObject({ status: 'traced', costAfter: 280 });
    expect(p.writeOffs).toEqual([{ code: 'B', date: iso(5), qty: 6, value: 420, note: 'شطب باقي الدفعة الافتتاحية' }]);
    const b = by(p.products, 'B');
    expect(b).toMatchObject({ derivedStock: -4, expectedAfterDecisions: 0, fifoBalance: 0, reconciled: true });
    expect(by(p.shortfallSkus, 'B').status).toBe('resolved');
  });

  it('a historical purchase invoice resolves it at its own cost and date', () => {
    const p = buildFifoPreview(history(), { decisions: { shortfalls: { B: { resolution: 'historical-purchase', qty: 4, unitCost: 60, ref: 'H-1', supplier: 'S', date: iso(1) } } } });
    expect(line(p, 'S2')).toMatchObject({ status: 'traced', costAfter: 240 });
    expect(line(p, 'S2').layers).toContain('H-1 (قرار)');
  });

  it('a shortfall decision with no cost is refused — no default cost', () => {
    const p = buildFifoPreview(history(), { decisions: { shortfalls: { B: { resolution: 'opening-batch', qty: 10 } } } });
    expect(line(p, 'S2').status).toBe('unresolved');
    expect(by(p.shortfallSkus, 'B').decisionText).toContain('مرفوض');
  });

  it('a product added to an invoice in a later edit leaves stock at that edit (movement log)', () => {
    const p = buildFifoPreview(history());
    expect(line(p, 'S3')).toMatchObject({ status: 'traced', timedBy: 'movement-log-later', costAfter: 50 });
    const noLog = buildFifoPreview(history(), { ignoreMovementLog: true });
    expect(noLog.shortfalls.some((r: any) => r.code === 'C')).toBe(true);
  });

  it('reads only: the history it was given is unchanged', () => {
    const h = history();
    const before = JSON.stringify(h);
    buildFifoPreview(h, { decisions: { opening: { A: { decision: 'approve' } }, shortfalls: { B: { resolution: 'opening-batch', qty: 10, unitCost: 70, remainder: 'write-off' } } } });
    expect(JSON.stringify(h)).toBe(before);
  });
});

describe('FIFO preview — gift samples (owner, Nov 13)', () => {
  it('a gift decision costs the sold pieces at an explicit zero, traced, with no remainder', () => {
    const p = buildFifoPreview(history(), { decisions: { shortfalls: { B: { resolution: 'gift', qty: 4 } } } });
    expect(line(p, 'S2')).toMatchObject({ status: 'traced', costAfter: 0, costBefore: 308 });
    expect(line(p, 'S2').layers).toContain('عينات هدية');
    expect(by(p.products, 'B')).toMatchObject({ expectedAfterDecisions: 0, fifoBalance: 0, reconciled: true });
    expect(by(p.shortfallSkus, 'B').status).toBe('resolved');
  });

  it('a zero cost on any other decision is still refused', () => {
    const p = buildFifoPreview(history(), { decisions: { shortfalls: { B: { resolution: 'historical-purchase', qty: 4, unitCost: 0, date: iso(1) } } } });
    expect(line(p, 'S2').status).toBe('unresolved');
    const g = buildFifoPreview(history(), { decisions: { shortfalls: { B: { resolution: 'gift', qty: 4, unitCost: 75 } } } });
    expect(g.decisionErrors).toEqual([expect.objectContaining({ code: 'B' })]);
  });
});
