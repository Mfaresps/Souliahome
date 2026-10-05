import { BostaService } from '../../src/bosta/bosta.service';

export {};

function makeSvc(tx: any) {
  const updates: any[] = [];
  const svc: any = Object.create(BostaService.prototype);
  svc.txModel = {
    findById: () => ({ lean: async () => tx, select: () => ({ lean: async () => tx }) }),
    findByIdAndUpdate: (_id: string, u: any) => { updates.push(u); return { lean: async () => ({ ...tx, bostaAwbPrints: [u.$push?.bostaAwbPrints].filter(Boolean) }) }; },
  };
  svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
  svc.emit = jest.fn();
  svc.resolveApiKey = async () => 'KEY';
  return { svc, updates };
}

describe('shipment history — shipmentEvents', () => {
  it('a deletion is logged once, with the shipment it removed and who did it', async () => {
    const { svc, updates } = makeSvc({ _id: 't1', bostaOrderId: 'B1', bostaTrackingNumber: 'T1', bostaStatus: 'CREATED' });
    await svc.markAsDeleted('t1', 'Reem');
    const ev = updates[0].$push.shipmentEvents;
    expect(ev).toMatchObject({ type: 'deleted', trackingNumber: 'T1', bostaOrderId: 'B1', source: 'manual', by: 'Reem' });
    expect(updates[0].bostaOrderId).toBe('');
  });

  it('a repeated sync on an already-deleted order does not log it twice', async () => {
    const { svc, updates } = makeSvc({ _id: 't1', bostaOrderId: '', bostaTrackingNumber: 'T1', bostaStatus: 'DELETED' });
    await svc.markAsDeleted('t1', 'Reem');
    expect(updates[0].$push).toBeUndefined();
  });

  it('a print is logged in both logs, tied to the label it printed', async () => {
    const { svc, updates } = makeSvc({ _id: 't1', bostaOrderId: 'B1', bostaTrackingNumber: 'T1' });
    await svc.recordAwbPrint('t1', 'Reem', 'u1');
    expect(updates[0].$push.bostaAwbPrints).toMatchObject({ by: 'Reem', trackingNumber: 'T1' });
    expect(updates[0].$push.shipmentEvents).toMatchObject({ type: 'printed', by: 'Reem', trackingNumber: 'T1' });
  });

  it('a cancellation at the carrier is logged with who cancelled', async () => {
    const { svc, updates } = makeSvc({ _id: 't1', bostaOrderId: 'B1', bostaTrackingNumber: 'T1', bostaStatus: 'CREATED' });
    svc.request = jest.fn(async () => ({}));
    await svc.cancelOrder('t1', 'Reem');
    expect(updates[0].$push.shipmentEvents).toMatchObject({ type: 'cancelled', trackingNumber: 'T1', by: 'Reem' });
  });

  it('a delivery update saying "deleted" logs it with its source', async () => {
    const tx = { _id: 't1', bostaOrderId: 'B1', bostaTrackingNumber: 'T1', bostaStatus: 'IN_TRANSIT' };
    const { svc, updates } = makeSvc(tx);
    await svc.applyDeliveryUpdate('t1', tx, { isDeleted: true }, 'webhook');
    expect(updates[0].$push.shipmentEvents).toMatchObject({ type: 'deleted', source: 'webhook', trackingNumber: 'T1' });
  });
});

describe('createOrder — sent vs resent', () => {
  function run(tx: any) {
    const { svc, updates } = makeSvc(tx);
    svc.request = jest.fn(async () => ({ data: { _id: 'B2', trackingNumber: 'T2', state: { code: 10 } } }));
    svc.settingsService = { getSettings: async () => ({}), getBostaApiKey: async () => 'KEY', getBostaPickupLocationId: async () => '' };
    svc.shopifyAdmin = { fulfillOrder: async () => ({ success: true }) };
    svc.getCodThreshold = async () => 0;
    return { svc, updates };
  }
  const base = { type: 'مبيعات', pickupStatus: 'Preparing', phone: '01000000000', shippingAddress: 'شارع 9',
    shippingGov: 'القاهرة', shippingBostaCity: 'Cairo', client: 'سارة', total: 900, remaining: 900, items: [{ name: 'Bag', qty: 1 }] };

  it('first send → "sent"', async () => {
    const { svc, updates } = run({ ...base, _id: 't1' });
    const r = await svc.createOrder('t1', 'Reem');
    expect(r.success).toBe(true);
    const ev = updates.map(u => u.$push?.shipmentEvents).find(Boolean);
    expect(ev).toMatchObject({ type: 'sent', trackingNumber: 'T2', by: 'Reem' });
  });

  it('after a deletion → "resent", naming the label it replaces', async () => {
    const { svc, updates } = run({ ...base, _id: 't1', bostaOrderId: '', bostaTrackingNumber: 'T1', bostaStatus: 'DELETED' });
    const r = await svc.createOrder('t1', 'Reem');
    expect(r.success).toBe(true);
    const ev = updates.map(u => u.$push?.shipmentEvents).find(Boolean);
    expect(ev).toMatchObject({ type: 'resent', trackingNumber: 'T2', prevTrackingNumber: 'T1', by: 'Reem' });
  });
});
