import { ShopifyService } from '../../src/shopify/shopify.service';
import { resolveShopifyClientName } from '../../src/shopify/shopify-client-name.util';

const oldName = 'Old Customer', newName = 'New Customer';
const oldContact = { first_name: 'Old', last_name: 'Customer' };
const newContact = { first_name: 'New', last_name: 'Customer' };

function fixture(status = 'pending', shipped = false) {
  const order: any = { _id: 'order-1', shopifyId: '111', ref: '2771', status, client: oldName,
    rawData: { id: 111, customer: oldContact, shipping_address: oldContact },
    items: [], itemsTotal: 0, shipCost: 0, total: 0, depositReceipts: [], save: jest.fn(async () => {}) };
  const service: any = Object.create(ShopifyService.prototype);
  service.shopifyOrderModel = { findOne: jest.fn(async () => order) };
  service.txModel = {
    findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'tx-1', bostaOrderId: shipped ? 'shipment-1' : '' }) }) }),
    updateOne: jest.fn(async () => ({})),
  };
  service.mapItems = jest.fn(async () => []);
  service.employeeScoringService = { scoreDepositDetection: jest.fn(async () => {}) };
  service.presence = { emitEvent: jest.fn() };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, order };
}

describe('Shopify client name synchronization', () => {
  it.each(['pending', 'approved'])('updates the %s order, linked transaction and live views', async status => {
    const { service, order } = fixture(status);
    expect(await service.handleOrderUpdate({ ...order.rawData, customer: newContact })).toEqual({ updated: true });
    expect(order.client).toBe(newName);
    expect(service.txModel.updateOne).toHaveBeenCalledWith({ shopifyOrderId: '111' }, { $set: expect.objectContaining({ client: newName }) });
    expect(service.presence.emitEvent).toHaveBeenCalledWith('shopify:client-changed', { shopifyOrderId: '111', ref: '2771' });
    expect(service.presence.emitEvent).toHaveBeenCalledWith('tx:updated', { _id: 'tx-1' });
  });

  it('keeps a changed shipping name on later unrelated updates despite the stale customer copy', async () => {
    const { service, order } = fixture();
    const payload = { ...order.rawData, shipping_address: newContact };
    await service.handleOrderUpdate(payload);
    expect(order.client).toBe(newName);
    service.presence.emitEvent.mockClear();
    await service.handleOrderUpdate({ ...payload, note: 'Unrelated update' });
    expect(order.client).toBe(newName);
    expect(service.presence.emitEvent).not.toHaveBeenCalledWith('shopify:client-changed', expect.anything());
  });

  it('preserves saved names when incoming fields are missing, empty or redacted', async () => {
    const { service, order } = fixture();
    await service.handleOrderUpdate({ id: 111, customer: null, shipping_address: { first_name: '', name: ' ' } });
    expect(order.client).toBe(oldName);
    expect(service.txModel.updateOne.mock.calls[0][1].$set.client).toBeUndefined();
  });

  it('updates local names after shipping without touching shipment or financial fields', async () => {
    const { service, order } = fixture('approved', true);
    await service.handleOrderUpdate({ ...order.rawData, customer: newContact });
    const update = service.txModel.updateOne.mock.calls[0][1].$set;
    expect(update.client).toBe(newName);
    for (const field of ['total', 'deposit', 'bostaOrderId', 'bostaStatus']) expect(update[field]).toBeUndefined();
  });

  it('supports import fallbacks, trims names and retains local edits on unchanged source data', () => {
    expect(resolveShopifyClientName({ customer: newContact, shipping_address: oldContact })).toBe(newName);
    expect(resolveShopifyClientName({ shipping_address: { name: '  Recipient  ' } })).toBe('Recipient');
    expect(resolveShopifyClientName({ billing_address: { first_name: ' New ', last_name: ' Customer ' } })).toBe(newName);
    expect(resolveShopifyClientName({ customer: { first_name: 'Only' } })).toBe('Only');
    expect(resolveShopifyClientName({})).toBeUndefined();
    const payload = { customer: oldContact };
    expect(resolveShopifyClientName(payload, payload, 'Local edit')).toBeUndefined();
  });
});
