import { diffOrderLines, planPickingAfterEdit } from '../../src/inventory-units/picking-edit-reconcile';

// The owner's scenario: an order of 4 products, product A scanned, the rest not yet;
// then the order is edited and A is removed.
const lines = [
  { lineId: 'a', code: 'A', name: 'Basket A', qty: 1 },
  { lineId: 'b', code: 'B', name: 'Basket B', qty: 2 },
  { lineId: 'c', code: 'C', name: 'Basket C', qty: 1 },
  { lineId: 'd', code: 'D', name: 'Basket D', qty: 3 },
];
const codes = new Map([['pA', 'A'], ['pB', 'B'], ['pC', 'C'], ['pD', 'D'], ['pX', 'X']]);
const unit = (id: string, productId: string, lineId: string, status = 'picking', updatedAt = '2026-11-14T10:00:00Z') =>
  ({ _id: id, productId, status, assignment: { transactionId: 't', lineId }, updatedAt });

describe('order edited during preparation', () => {
  it('removing the scanned product puts its piece back and keeps the others untouched', () => {
    const after = lines.filter(l => l.code !== 'A');
    const plan = planPickingAfterEdit({ items: after }, [unit('u1', 'pA', 'a')], codes);
    expect(plan.release.map(u => u._id)).toEqual(['u1']);
    expect(plan.undoSkipIds).toEqual([]);
    expect(plan.complete).toBe(false);
    expect(diffOrderLines(lines, after)).toEqual({ removed: [{ code: 'A', name: 'Basket A', qty: 1 }], added: [], changed: [] });
  });

  it('a removed line also switches off its «without scan» skips', () => {
    const skip = { id: 's1', active: true, kind: 'damaged-label', lineId: 'a', sku: 'A', quantity: 1 };
    const plan = planPickingAfterEdit({ items: lines.slice(1), pickingExceptions: [skip] }, [], codes);
    expect(plan.undoSkipIds).toEqual(['s1']);
  });

  it('a lower quantity drops skips first, then the newest scanned pieces', () => {
    const items = lines.map(l => l.code === 'D' ? { ...l, qty: 1 } : l);
    const held = [unit('old', 'pD', 'd', 'picking', '2026-11-14T09:00:00Z'), unit('new', 'pD', 'd', 'picking', '2026-11-14T11:00:00Z')];
    const skip = { id: 'sD', active: true, kind: 'damaged-label', lineId: 'd', sku: 'D', quantity: 1, at: '2026-11-14T10:00:00Z' };
    const plan = planPickingAfterEdit({ items, pickingExceptions: [skip] }, held, codes);
    expect(plan.undoSkipIds).toEqual(['sD']);
    expect(plan.release.map(u => u._id)).toEqual(['new']);
  });

  it('a line switched to another product releases the old product pieces', () => {
    const items = lines.map(l => l.lineId === 'c' ? { ...l, code: 'X', name: 'Basket X' } : l);
    const plan = planPickingAfterEdit({ items }, [unit('uc', 'pC', 'c')], codes);
    expect(plan.release.map(u => u._id)).toEqual(['uc']);
    const diff = diffOrderLines(lines, items);
    expect(diff.removed.map(r => r.code)).toEqual(['C']);
    expect(diff.added.map(r => r.code)).toEqual(['X']);
  });

  it('adding a product or raising a quantity releases nothing', () => {
    const items = [...lines.map(l => l.code === 'B' ? { ...l, qty: 3 } : l), { lineId: 'e', code: 'X', name: 'New', qty: 1 }];
    const plan = planPickingAfterEdit({ items }, [unit('u1', 'pA', 'a'), unit('u2', 'pB', 'b')], codes);
    expect(plan.release).toEqual([]);
    expect(diffOrderLines(lines, items)).toMatchObject({ changed: [{ code: 'B', from: 2, to: 3 }], added: [{ code: 'X', qty: 1 }], removed: [] });
  });

  it('a prepared order stays prepared when the removed line was the only change and the rest is complete', () => {
    const items = [{ lineId: 'b', code: 'B', qty: 1 }, { lineId: 'c', code: 'C', qty: 1 }];
    const held = [unit('ua', 'pA', 'a', 'prepared'), unit('ub', 'pB', 'b', 'prepared'), unit('uc', 'pC', 'c', 'prepared')];
    const plan = planPickingAfterEdit({ items }, held, codes);
    expect(plan.release.map(u => u._id)).toEqual(['ua']);
    expect(plan.complete).toBe(true);
  });

  it('nothing changed → empty diff', () => {
    expect(diffOrderLines(lines, JSON.parse(JSON.stringify(lines)))).toEqual({ removed: [], added: [], changed: [] });
  });
});
