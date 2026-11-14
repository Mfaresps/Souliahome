import { BostaService } from '../../src/bosta/bosta.service';
import { shipmentEditPayload, shipmentLocallyEditable } from '../../src/shared/bosta-shipment-edit.util';

export {};

const base = {
  _id: 't1', type: 'مبيعات', bostaOrderId: 'B1', bostaTrackingNumber: 'T1', bostaStatus: 'CREATED', pickupStatus: 'Ready',
  client: 'Ahmed Ali', phone: '01012345678', shippingAddress: '5 Nile St', shippingBostaCity: 'Cairo', remaining: 1000, notes: '',
};

describe('shipmentEditPayload', () => {
  it('nothing the shipment carries changed → null', () => {
    expect(shipmentEditPayload(base, { ...base, tags: ['x'] })).toBeNull();
  });
  it('a new remaining becomes the new COD', () => {
    const r = shipmentEditPayload(base, { ...base, remaining: 850 })!;
    expect(r.payload).toEqual({ cod: 850 });
    expect(r.fields).toEqual(['cod']);
  });
  it('name and phone go as the receiver, the phone also on the address', () => {
    const r = shipmentEditPayload(base, { ...base, client: 'Mona  Samir Adel', phone: '0111-222-3333' })!;
    expect(r.payload.receiver).toEqual({ firstName: 'Mona', lastName: 'Samir Adel', phone: '01112223333' });
    expect(r.payload.dropOffAddress).toEqual({ city: 'Cairo', firstLine: '5 Nile St', phone: '01112223333' });
  });
  it('a new address/city is sent whole', () => {
    const r = shipmentEditPayload(base, { ...base, shippingAddress: '9 Corniche', shippingBostaCity: 'Alexandria' })!;
    expect(r.payload).toEqual({ dropOffAddress: { city: 'Alexandria', firstLine: '9 Corniche', phone: '01012345678' } });
  });
  it('an address without a city is never sent', () => {
    const r = shipmentEditPayload(base, { ...base, shippingAddress: '9 Corniche', shippingBostaCity: '', shippingGov: '', shippingCity: '' });
    expect(r).toBeNull();
  });
});

describe('shipmentLocallyEditable', () => {
  it('only a created shipment the courier has not collected', () => {
    expect(shipmentLocallyEditable(base)).toBe(true);
    expect(shipmentLocallyEditable({ ...base, bostaStatus: 'PICKED_UP' })).toBe(false);
    expect(shipmentLocallyEditable({ ...base, bostaStatus: 'OUT_FOR_DELIVERY' })).toBe(false);
    expect(shipmentLocallyEditable({ ...base, pickupStatus: 'Picked-Up' })).toBe(false);
    expect(shipmentLocallyEditable({ ...base, bostaOrderId: '' })).toBe(false);
  });
});

function makeSvc(saved: any, live: any) {
  const updates: any[] = [];
  const svc: any = Object.create(BostaService.prototype);
  svc.txModel = {
    findById: () => ({ lean: async () => saved }),
    findByIdAndUpdate: (_id: string, u: any) => { updates.push(u); return { catch: () => undefined, then: (r: any) => r() }; },
  };
  svc.logger = { log: () => {}, warn: () => {}, error: () => {} };
  svc.emit = jest.fn();
  svc.getAwb = jest.fn(async () => ({}));
  svc.resolveApiKey = async () => 'KEY';
  svc.request = jest.fn(async (method: string) => (method === 'GET' ? { data: live } : { success: true }));
  return { svc, updates };
}

describe('updateShipmentAfterEdit', () => {
  it('PUTs the changes to the delivery, confirms the COD, records the new amount', async () => {
    const { svc, updates } = makeSvc({ ...base, remaining: 850 }, { cod: 850, state: { code: 10 } });
    const r = await svc.updateShipmentAfterEdit('t1', base, 'Reem');
    expect(r.status).toBe('updated');
    const put = svc.request.mock.calls.find((c: any[]) => c[0] === 'PUT');
    expect(put[1]).toBe('/deliveries/B1');
    expect(put[2]).toEqual({ cod: 850 });
    expect(updates[0].$set).toMatchObject({ bostaOriginalCod: 850, bostaEditSync: { status: 'updated', by: 'Reem', cod: 850 }, bostaAwbBase64: '' });
    expect(updates[0].$push.shipmentEvents).toMatchObject({ type: 'updated', fields: ['cod'], trackingNumber: 'T1' });
  });

  it('Bosta refusing leaves the order saved and records the failure', async () => {
    const { svc, updates } = makeSvc({ ...base, remaining: 850 }, {});
    svc.request = jest.fn(async () => { throw new Error('Delivery cannot be updated'); });
    const r = await svc.updateShipmentAfterEdit('t1', base, 'Reem');
    expect(r).toMatchObject({ status: 'failed', error: 'Delivery cannot be updated' });
    expect(updates[0].$set.bostaEditSync).toMatchObject({ status: 'failed', cod: 850 });
    expect(updates[0].$set.bostaOriginalCod).toBeUndefined();
    expect(updates[0].$push.shipmentEvents).toMatchObject({ type: 'update-failed' });
  });

  it('a COD Bosta did not actually change counts as a failure', async () => {
    const { svc, updates } = makeSvc({ ...base, remaining: 850 }, { cod: 1000 });
    const r = await svc.updateShipmentAfterEdit('t1', base, 'Reem');
    expect(r.status).toBe('failed');
    expect(updates[0].$set.bostaOriginalCod).toBeUndefined();
  });

  it('shipmentEditableNow follows Bosta\'s live state', async () => {
    const { svc } = makeSvc(base, { state: { code: 21 } });
    svc.fetchDelivery = async () => ({ data: { state: { code: 21 } } });
    expect((await svc.shipmentEditableNow(base)).editable).toBe(false);
    svc.fetchDelivery = async () => ({ data: { state: { code: 10 } } });
    expect((await svc.shipmentEditableNow(base)).editable).toBe(true);
  });
});
