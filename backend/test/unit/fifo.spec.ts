import { FifoBook, supplierReturnVariance } from '../../src/shared/fifo.util';

export {};

const T = (d: number) => Date.UTC(2026, 0, d);
const buy = (b: FifoBook, id: string, qty: number, cost: number, day: number, supplier = 'S1') =>
  b.addLayer({ id, kind: 'purchase', at: T(day), originalQty: qty, unitCost: cost, confidence: 'actual', sourceRef: id, supplierName: supplier });

describe('FifoBook — the 10 required cases', () => {
  it('1. same product from two suppliers at different prices keeps two layers', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1, 'Talla');
    buy(b, '002', 20, 90, 2, 'Nour');
    expect(b.layers.map((l) => [l.id, l.unitCost, l.supplierName])).toEqual([['001', 150, 'Talla'], ['002', 90, 'Nour']]);
    expect(b.value()).toBe(10 * 150 + 20 * 90);
  });

  it('2. selling part of the first layer takes only from it', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1); buy(b, '002', 20, 90, 2);
    const r = b.consume('s1', 4, T(3));
    expect(r.allocations).toEqual([{ layerId: '001', qty: 4, unitCost: 150 }]);
    expect(b.getLayer('001')!.remainingQty).toBe(6);
  });

  it('3. exhausting the first layer moves on to the second', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1); buy(b, '002', 20, 90, 2);
    b.consume('s1', 10, T(3));
    const r = b.consume('s2', 3, T(4));
    expect(b.getLayer('001')!.remainingQty).toBe(0);
    expect(r.allocations).toEqual([{ layerId: '002', qty: 3, unitCost: 90 }]);
  });

  it('4. the user example: 15 pieces = 10 × 150 + 5 × 90 = 1,950', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1); buy(b, '002', 20, 90, 2);
    const r = b.consume('s1', 15, T(3));
    expect(r.totalCost).toBe(1950);
    expect(r.allocations).toEqual([{ layerId: '001', qty: 10, unitCost: 150 }, { layerId: '002', qty: 5, unitCost: 90 }]);
    expect(r.unitCost).toBe(130);
    expect(r.shortQty).toBe(0);
  });

  it('5. a new layer at a different price does not change an earlier sale', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1);
    const r1 = b.consume('s1', 5, T(2));
    buy(b, '003', 10, 200, 3);
    expect(b.outflow('s1')!.totalCost).toBe(750);
    expect(r1.totalCost).toBe(750);
    expect(b.consume('s2', 6, T(4)).totalCost).toBe(5 * 150 + 1 * 200);
  });

  it('6. a sound customer return goes back to the old layer it came from', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1); buy(b, '002', 20, 90, 2);
    b.consume('s1', 12, T(3));                     // 10 from 001, 2 from 002
    const back = b.release('s1', 3, T(4), 'ret1');  // newest allocation first: 2 to 002, 1 to 001
    expect(back.restored).toEqual([{ layerId: '002', qty: 2 }, { layerId: '001', qty: 1 }]);
    expect(back.releasedCost).toBe(2 * 90 + 150);
    expect(b.getLayer('001')!.remainingQty).toBe(1);
    // the next sale takes the returned old piece first
    expect(b.consume('s2', 1, T(5)).allocations[0]).toEqual({ layerId: '001', qty: 1, unitCost: 150 });
  });

  it('7. cancelling a sale puts everything back and the next sale costs as if it never happened', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 150, 1); buy(b, '002', 20, 90, 2);
    b.consume('s1', 15, T(3));
    b.release('s1', 15, T(4));
    expect(b.layers.map((l) => l.remainingQty)).toEqual([10, 20]);
    expect(b.consume('s2', 15, T(5)).totalCost).toBe(1950);
  });

  it('8. two sales of the last pieces never take the same quantity twice; a repeated key consumes nothing', () => {
    const b = new FifoBook('P');
    buy(b, '001', 3, 100, 1);
    const a = b.consume('sA', 2, T(2));
    const c = b.consume('sB', 2, T(2));
    expect(a.allocations).toEqual([{ layerId: '001', qty: 2, unitCost: 100 }]);
    expect(c.allocations[0]).toEqual({ layerId: '001', qty: 1, unitCost: 100 });
    expect(c.shortQty).toBe(1);
    const again = b.consume('sA', 2, T(2));
    expect(again.repeated).toBe(true);
    expect(b.getLayer('001')!.remainingQty).toBe(0);
    expect(b.openDeficitQty()).toBe(1);
  });

  it('9. opening stock without an invoice is the first layer, at the cost given to it', () => {
    const b = new FifoBook('P');
    b.addLayer({ id: 'opening', kind: 'opening', at: 0, originalQty: 4, unitCost: 120, confidence: 'card' });
    buy(b, '001', 10, 150, 5);
    const r = b.consume('s1', 6, T(6));
    expect(r.allocations).toEqual([{ layerId: 'opening', qty: 4, unitCost: 120 }, { layerId: '001', qty: 2, unitCost: 150 }]);
  });

  it('10. a backdated invoice enters at its entry time: a sale entered before it is a deficit, settled by it', () => {
    const b = new FifoBook('P');
    buy(b, '001', 2, 100, 1);
    const sale = b.consume('s1', 5, T(3));          // 2 covered, 3 short at provisional 100
    expect(sale.shortQty).toBe(3);
    expect(sale.totalCost).toBe(500);
    // invoice dated day 2 but entered day 4 → enters at day 4
    buy(b, '002-backdated', 10, 130, 4);
    expect(b.outflow('s1')!.totalCost).toBe(500);   // the sale keeps its cost
    expect(b.getLayer('002-backdated')!.remainingQty).toBe(7);
    expect(b.variances).toEqual([{ at: T(4), kind: 'deficit-settled', eventKey: 's1', layerId: '002-backdated', qty: 3, amount: 90 }]);
    expect(b.openDeficitQty()).toBe(0);
  });
});

describe('FifoBook — returns, cancellations, edits, adjustments', () => {
  it('a sale with no stock at all uses the fallback cost and says where it came from', () => {
    const b = new FifoBook('P', () => ({ cost: 77, source: 'opening-candidate' }));
    const r = b.consume('s1', 2, T(1));
    expect(r.allocations).toEqual([{ layerId: null, qty: 2, unitCost: 77, deficitId: expect.any(String) }]);
    expect(b.deficits[0].provisionalSource).toBe('opening-candidate');
    expect(b.balance()).toBe(-2);
  });

  it('a return of a short sale cancels the open deficit first, touching no layer', () => {
    const b = new FifoBook('P');
    buy(b, '001', 1, 100, 1);
    b.consume('s1', 3, T(2));                       // 1 from 001, 2 short
    const back = b.release('s1', 2, T(3));
    expect(back.restored).toEqual([{ layerId: null, qty: 2 }]);
    expect(b.openDeficitQty()).toBe(0);
    expect(b.getLayer('001')!.remainingQty).toBe(0);
  });

  it('a return of a short sale already settled goes back to the settling layer and undoes its variance', () => {
    const b = new FifoBook('P');
    buy(b, '001', 1, 100, 1);
    b.consume('s1', 3, T(2));                       // 2 short at 100
    buy(b, '002', 5, 120, 3);                       // settles 2 → variance +40
    b.release('s1', 2, T(4), 'ret');
    expect(b.getLayer('002')!.remainingQty).toBe(5);
    expect(b.variances.reduce((s, v) => s + v.amount, 0)).toBe(0);
  });

  it('an order edited down releases the newest pieces; edited up takes more FIFO under a new key', () => {
    const b = new FifoBook('P');
    buy(b, '001', 3, 100, 1); buy(b, '002', 10, 80, 2);
    b.consume('s1', 5, T(3));                       // 3×100 + 2×80
    b.release('s1', 1, T(4));                       // back to 002
    expect(b.outflow('s1')!.allocations).toEqual([{ layerId: '001', qty: 3, unitCost: 100 }, { layerId: '002', qty: 1, unitCost: 80 }]);
    const more = b.consume('s1:edit:1', 2, T(5));
    expect(more.allocations).toEqual([{ layerId: '002', qty: 2, unitCost: 80 }]);
  });

  it('a positive adjustment is a layer; a negative one consumes FIFO like a sale', () => {
    const b = new FifoBook('P');
    buy(b, '001', 2, 100, 1);
    b.addLayer({ id: 'adj+1', kind: 'adjustment', at: T(2), originalQty: 1, unitCost: 100, confidence: 'card' });
    const minus = b.consume('adj-1', 2, T(3));
    expect(minus.allocations).toEqual([{ layerId: '001', qty: 2, unitCost: 100 }]);
    expect(b.getLayer('adj+1')!.remainingQty).toBe(1);
  });

  it('a supplier return leaves from its own invoice layer first, the rest FIFO, and reports the variance', () => {
    const b = new FifoBook('P');
    buy(b, '001', 5, 100, 1); buy(b, '002', 5, 90, 2);
    const r = b.consume('sret', 3, T(3), { prefer: [{ layerId: '002' }] });
    expect(r.allocations).toEqual([{ layerId: '002', qty: 3, unitCost: 90 }]);
    expect(supplierReturnVariance(r, 95)).toBe(15);       // refund 95 vs cost 90
    const over = b.consume('sret2', 4, T(4), { prefer: [{ layerId: '002' }] });
    expect(over.allocations).toEqual([{ layerId: '002', qty: 2, unitCost: 90 }, { layerId: '001', qty: 2, unitCost: 100 }]);
  });

  it('a purchase edited after a sale: new price for what is left, a variance for what was sold, sales unchanged', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 100, 1);
    b.consume('s1', 4, T(2));
    expect(b.revalueLayer('001', 110, T(3), 'edit')).toBe(40);
    expect(b.outflow('s1')!.totalCost).toBe(400);
    expect(b.value()).toBe(6 * 110);
  });

  it('a purchase cut below what was already sold is refused; above it is fine', () => {
    const b = new FifoBook('P');
    buy(b, '001', 10, 100, 1);
    b.consume('s1', 7, T(2));
    expect(b.resizeLayer('001', 5)).toEqual({ ok: false, needsReplay: true, consumed: 7 });
    expect(b.resizeLayer('001', 8)).toEqual({ ok: true });
    expect(b.getLayer('001')!.remainingQty).toBe(1);
  });

  it('balance = layers − open deficits, and value counts only remaining layer pieces', () => {
    const b = new FifoBook('P');
    buy(b, '001', 2, 50, 1);
    b.consume('s1', 5, T(2));
    expect(b.balance()).toBe(-3);
    expect(b.value()).toBe(0);
  });
});
