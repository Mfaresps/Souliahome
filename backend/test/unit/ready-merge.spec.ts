import { readyMergeBlock, readyOrderCarrier, readyOrderCollected } from '../../src/shared/ready-merge.util';

const order = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: id, pickupStatus: 'Ready', bostaStatus: 'CREATED', bostaOrderId: 'b' + id, shipCo: 'Bosta', warehouseCode: 'MAIN', ...extra,
});

describe('ready group merge rules', () => {
  it('allows two ready Bosta groups from the same warehouse with no pickup request', () => {
    expect(readyMergeBlock([order('1')], [order('2'), order('3')], [])).toBeNull();
  });

  it('allows joining a group whose orders are under a pickup request (source has none)', () => {
    expect(readyMergeBlock([order('1')], [order('2')], [{ id: 'P', orderIds: ['2'] }])).toBeNull();
  });

  it('allows both groups under the same pickup request', () => {
    expect(readyMergeBlock([order('1')], [order('2')], [{ id: 'P', orderIds: ['1', '2'] }])).toBeNull();
  });

  it('refuses two groups covered by different pickup requests', () => {
    expect(readyMergeBlock([order('1')], [order('2')], [{ id: 'A', orderIds: ['1'] }, { id: 'B', orderIds: ['2'] }]))
      .toEqual({ code: 'PICKUP_REQUEST' });
  });

  it('refuses a source order already with the courier', () => {
    expect(readyMergeBlock([order('1', { ref: '2701', bostaStatus: 'PICKED_UP' })], [order('2')], [], (o: any) => o.ref))
      .toEqual({ code: 'COLLECTED', refs: ['2701'] });
    expect(readyOrderCollected(order('1', { pickupStatus: 'Picked-Up' }))).toBe(true);
    expect(readyOrderCollected(order('1', { shippedAt: '2026-11-14' }))).toBe(true);
    expect(readyOrderCollected(order('1', { bostaStatus: '' }))).toBe(false);
  });

  it('refuses another carrier and another warehouse', () => {
    const manual = order('1', { bostaOrderId: '', shipCo: 'Mylerz' });
    expect(readyMergeBlock([manual], [order('2')], [])?.code).toBe('CARRIER');
    expect(readyMergeBlock([order('1', { warehouseCode: 'ALEX' })], [order('2')], [])?.code).toBe('WAREHOUSE');
  });

  it('treats Bosta spellings, an empty warehouse and an unknown carrier as compatible', () => {
    expect(readyOrderCarrier({ _id: 1, shipCo: 'بوسطة' })).toBe('bosta');
    const legacy = order('1', { bostaOrderId: '', shipCo: '', warehouseCode: '' });
    expect(readyMergeBlock([legacy], [order('2')], [])).toBeNull();
  });
});
