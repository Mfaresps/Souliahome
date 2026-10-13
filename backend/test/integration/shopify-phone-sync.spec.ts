import { ShopifyService } from '../../src/shopify/shopify.service';
import { resolveShopifyPhone } from '../../src/shopify/shopify-phone.util';

const oldPhone = '+201000000001', newPhone = '+201000000002';
function fixture(status = 'pending', shipped = false) {
  const rawData = { id: 111, phone: oldPhone, customer: { phone: oldPhone }, shipping_address: { phone: oldPhone } };
  const order: any = { _id: 'order-1', shopifyId: '111', ref: '2771', status, phone: oldPhone,
    items: [], itemsTotal: 0, shipCost: 0, total: 0, rawData, depositReceipts: [], save: jest.fn(async () => {}) };
  const service: any = Object.create(ShopifyService.prototype);
  const tx = { _id: 'tx-1', phone: oldPhone, bostaOrderId: shipped ? 'existing-shipment' : '' };
  service.shopifyOrderModel = { findOne: jest.fn(async () => order) };
  service.txModel = {
    findOne: () => ({ select: () => ({ lean: async () => tx }) }),
    updateOne: jest.fn(async () => ({})),
  };
  service.mapItems = jest.fn(async () => []);
  service.employeeScoringService = { scoreDepositDetection: jest.fn(async () => {}) };
  service.presence = { emitEvent: jest.fn() };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, order, tx };
}

describe('Shopify phone synchronization', () => {
  it.each(['pending', 'approved'])('syncs an order contact phone into the %s order and its transaction', async status => {
    const { service, order } = fixture(status);
    const payload = { ...order.rawData, phone: newPhone };
    expect(await service.handleOrderUpdate(payload)).toEqual({ updated: true });
    expect(order.phone).toBe(newPhone);
    expect(service.txModel.updateOne.mock.calls[0][1].$set.phone).toBe(newPhone);
    expect(order.total).toBe(0);
    expect(service.presence.emitEvent).toHaveBeenCalledWith('shopify:phone-changed', { shopifyOrderId: '111', ref: '2771' });
    expect(service.presence.emitEvent).toHaveBeenCalledWith('tx:updated', { _id: 'tx-1' });
  });
  it('updates a changed shipping phone despite stale copies in order/customer contact fields and does not revert on the next update', async () => {
    const { service, order } = fixture();
    const payload = { ...order.rawData, shipping_address: { phone: newPhone } };
    await service.handleOrderUpdate(payload);
    expect(order.phone).toBe(newPhone);
    service.txModel.updateOne.mockClear();
    service.presence.emitEvent.mockClear();
    await service.handleOrderUpdate({ ...payload, note: 'unrelated note' });
    expect(order.phone).toBe(newPhone);
    expect(service.txModel.updateOne.mock.calls[0][1].$set.phone).toBeUndefined();
    expect(service.presence.emitEvent).not.toHaveBeenCalledWith('shopify:phone-changed', expect.anything());
  });
  it('syncs a changed customer phone carried by an order update', async () => {
    const { service, order } = fixture();
    await service.handleOrderUpdate({ ...order.rawData, customer: { phone: newPhone } });
    expect(order.phone).toBe(newPhone);
    expect(service.txModel.updateOne.mock.calls[0][1].$set.phone).toBe(newPhone);
  });
  it('keeps saved phone numbers when incoming fields are absent, empty or redacted', async () => {
    const { service, order } = fixture();
    await service.handleOrderUpdate({ id: 111, phone: null, customer: { phone: '' } });
    expect(order.phone).toBe(oldPhone);
    expect(service.txModel.updateOne.mock.calls[0][1].$set.phone).toBeUndefined();
  });
  it('updates local contact details on a shipped order without altering financial or shipment fields', async () => {
    const { service, order } = fixture('approved', true);
    await service.handleOrderUpdate({ ...order.rawData, phone: newPhone });
    expect(order.phone).toBe(newPhone);
    expect(service.txModel.updateOne.mock.calls[0][1].$set).toMatchObject({ phone: newPhone });
    for (const field of ['total', 'deposit', 'bostaOrderId', 'bostaStatus']) expect(service.txModel.updateOne.mock.calls[0][1].$set[field]).toBeUndefined();
  });
  it('repairs legacy phone data that did not follow the previously saved raw payload', async () => {
    const { service, order } = fixture();
    order.rawData = { id: 111, phone: newPhone };
    await service.handleOrderUpdate({ id: 111, phone: newPhone });
    expect(order.phone).toBe(newPhone);
  });
  it('prefers order contact data on initial import and supports shipping, customer and billing fallback', () => {
    expect(resolveShopifyPhone({ phone: newPhone, customer: { phone: oldPhone } })).toBe(newPhone);
    expect(resolveShopifyPhone({ shipping_address: { phone: newPhone }, customer: { phone: oldPhone } })).toBe(oldPhone);
    expect(resolveShopifyPhone({ shipping_address: { phone: newPhone } })).toBe(newPhone);
    expect(resolveShopifyPhone({ customer: { phone: newPhone } })).toBe(newPhone);
    expect(resolveShopifyPhone({ billing_address: { phone: '  ' + newPhone + '  ' } })).toBe(newPhone);
    expect(resolveShopifyPhone({})).toBeUndefined();
  });
});
