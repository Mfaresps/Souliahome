import { allocateOrders, QueueOrder } from '../../src/demand-planning/order-allocation.util';

const o = (id: string, day: number, need: Record<string, number>, extra: Partial<QueueOrder> = {}): QueueOrder => ({
  id,
  createdAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  selected: true,
  unlinked: false,
  need: new Map(Object.entries(need)),
  ...extra,
});
const stock = (s: Record<string, number>) => new Map(Object.entries(s));

describe('allocateOrders — oldest first, all or nothing', () => {
  it('serves the oldest order first, whatever the input order', () => {
    const r = allocateOrders([o('new', 5, { A: 1 }), o('old', 1, { A: 1 })], stock({ A: 1 }));
    expect(r.orders.get('old')!.state).toBe('ready');
    expect(r.orders.get('new')!.state).toBe('short');
    expect(r.orders.get('new')!.missing.get('A')).toBe(1);
    expect(r.orders.get('old')!.position).toBe(1);
  });

  it('an order that cannot be completed takes nothing (no starving a newer one)', () => {
    // old needs A + B, B is missing → it must not keep A from `next`.
    const r = allocateOrders([o('old', 1, { A: 1, B: 1 }), o('next', 2, { A: 1 })], stock({ A: 1, B: 0 }));
    expect(r.orders.get('old')!.state).toBe('short');
    expect(r.orders.get('next')!.state).toBe('ready');
    expect(r.allocatedSelected.get('A')).toBe(1);
  });

  it('an unlinked order claims no stock', () => {
    const r = allocateOrders([o('u', 1, { A: 2 }, { unlinked: true }), o('b', 2, { A: 2 })], stock({ A: 2 }));
    expect(r.orders.get('u')!.state).toBe('unlinked');
    expect(r.orders.get('b')!.state).toBe('ready');
  });

  it('an older order outside the selection claims first and is reported as reserved', () => {
    const r = allocateOrders([o('mine', 3, { A: 2 }), o('older', 1, { A: 2 }, { selected: false })], stock({ A: 3 }));
    expect(r.orders.get('older')!.state).toBe('ready');
    expect(r.orders.get('mine')!.state).toBe('short');
    expect(r.orders.get('mine')!.missing.get('A')).toBe(1);
    expect(r.reservedOlder.get('A')).toBe(2);
  });

  it('a newer order outside the selection is never counted against the selection', () => {
    const r = allocateOrders([o('mine', 1, { A: 2 }), o('newer', 3, { A: 1 }, { selected: false })], stock({ A: 3 }));
    expect(r.orders.get('mine')!.state).toBe('ready');
    expect(r.reservedOlder.get('A') || 0).toBe(0);
  });

  it('one unit is never given to two orders', () => {
    const r = allocateOrders([o('a', 1, { A: 1 }), o('b', 2, { A: 1 }), o('c', 3, { A: 1 })], stock({ A: 2 }));
    const ready = ['a', 'b', 'c'].filter(id => r.orders.get(id)!.state === 'ready');
    expect(ready).toEqual(['a', 'b']);
    expect(r.allocatedSelected.get('A')).toBe(2);
  });

  it('recomputes from the input: a cancelled older order frees its stock', () => {
    const before = allocateOrders([o('old', 1, { A: 1 }, { selected: false }), o('mine', 2, { A: 1 })], stock({ A: 1 }));
    expect(before.orders.get('mine')!.state).toBe('short');
    const after = allocateOrders([o('mine', 2, { A: 1 })], stock({ A: 1 }));   // old cancelled → gone from the queue
    expect(after.orders.get('mine')!.state).toBe('ready');
  });

  it('undated orders go last; same date breaks by id (stable)', () => {
    const r = allocateOrders([o('z', 1, { A: 1 }), { ...o('x', 1, { A: 1 }), createdAt: '' }, o('y', 1, { A: 1 })], stock({ A: 2 }));
    expect(r.orders.get('y')!.position).toBe(1);
    expect(r.orders.get('z')!.position).toBe(2);
    expect(r.orders.get('x')!.state).toBe('short');
  });

  it('a negative or missing stock figure counts as zero', () => {
    const r = allocateOrders([o('a', 1, { A: 1, B: 1 })], stock({ A: -3 }));
    expect(r.orders.get('a')!.missing.get('A')).toBe(1);
    expect(r.orders.get('a')!.missing.get('B')).toBe(1);
  });
});
