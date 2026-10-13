import { Test } from '@nestjs/testing';
import { INestApplication, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { DepositReceiptsService } from '../../src/shopify/deposit-receipts.service';
import { DepositAutoApproveService } from '../../src/shopify/deposit-auto-approve.service';

describe('Shopify webhook HTTP ingress', () => {
  let app: INestApplication;
  let url: string;
  const originalSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const secret = 'test-only-shopify-signing-secret';
  const service = {
    verifyWebhook: ShopifyService.prototype.verifyWebhook,
    handleOrder: jest.fn(), handleOrderUpdate: jest.fn(),
    handleOrderEdited: jest.fn(), handleOrderCancelled: jest.fn(),
    handleFulfillment: jest.fn(),
  };

  beforeAll(async () => {
    process.env.SHOPIFY_WEBHOOK_SECRET = secret;
    const module = await Test.createTestingModule({
      controllers: [ShopifyController],
      providers: [
        { provide: ShopifyService, useValue: service },
        { provide: DepositReceiptsService, useValue: {} },
        { provide: DepositAutoApproveService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()) + '/api/shopify/webhook';
  });
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SHOPIFY_WEBHOOK_SECRET = secret;
    for (const key of ['handleOrder', 'handleOrderUpdate', 'handleOrderEdited', 'handleOrderCancelled', 'handleFulfillment']) {
      (service as any)[key].mockResolvedValue({ handled: true });
    }
  });
  afterAll(async () => {
    await app?.close();
    if (originalSecret === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET;
    else process.env.SHOPIFY_WEBHOOK_SECRET = originalSecret;
  });
  function post(topic: string, body: string, signedBody = body, signingSecret = secret) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic,
        'X-Shopify-Hmac-Sha256': createHmac('sha256', signingSecret).update(signedBody).digest('base64') },
      body,
    });
  }
  it.each([
    ['orders/create', 'handleOrder'], ['orders/updated', 'handleOrderUpdate'],
    ['orders/edited', 'handleOrderEdited'], ['orders/cancelled', 'handleOrderCancelled'],
    ['fulfillments/create', 'handleFulfillment'], ['fulfillments/update', 'handleFulfillment'],
  ])('accepts signed %s and passes the JSON to %s without JWT auth', async (topic, handler) => {
    const body = '{ "id": 111, "note": "مرحبا" }';
    const res = await post(topic, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: true });
    expect((service as any)[handler]).toHaveBeenCalledWith(JSON.parse(body));
    expect(Object.values(service).filter((f: any) => f.mock).reduce((n, f: any) => n + f.mock.calls.length, 0)).toBe(1);
  });
  it.each(['wrong-key', 'changed-body', 'missing-key'])('rejects %s before processing an order', async mode => {
    if (mode === 'missing-key') delete process.env.SHOPIFY_WEBHOOK_SECRET;
    const res = await post('orders/create', '{"id":111}', mode === 'changed-body' ? '{ "id":111 }' : '{"id":111}', mode === 'wrong-key' ? 'wrong' : secret);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Invalid webhook signature');
    expect(service.handleOrder).not.toHaveBeenCalled();
  });
  it('returns a retryable failure when an edit cannot be fetched', async () => {
    service.handleOrderEdited.mockRejectedValueOnce(new ServiceUnavailableException('Unable to fetch edited order from Shopify'));
    const res = await post('orders/edited', '{"order_edit":{"order_id":111}}');
    expect(res.status).toBe(503);
  });
});

describe('Shopify order edit delta resolution', () => {
  const payload = { order_edit: { id: 999, order_id: 111, line_items: { additions: [{ id: 2, delta: 1 }] } } };
  function subject(result: any) {
    const service: any = Object.create(ShopifyService.prototype);
    service.shopifyAdminService = { getOrder: jest.fn().mockResolvedValue(result) };
    service.handleOrderUpdate = jest.fn().mockResolvedValue({ updated: true });
    return service;
  }
  it('uses the order ID, not the edit ID, and applies only the fetched complete order', async () => {
    const order = { id: 111, note: 'kept', shipping_address: { address1: 'kept' }, line_items: [{ id: 2, quantity: 3 }] };
    const service = subject({ success: true, order });
    expect(await service.handleOrderEdited(payload)).toEqual({ updated: true });
    expect(service.shopifyAdminService.getOrder).toHaveBeenCalledWith('111');
    expect(service.handleOrderUpdate).toHaveBeenCalledWith(order);
  });
  it.each([{ success: false }, { success: true }, { success: true, order: { id: 999 } }])('fails safely without overwriting data: %j', async result => {
    const service = subject(result);
    await expect(service.handleOrderEdited(payload)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(service.handleOrderUpdate).not.toHaveBeenCalled();
  });
  it.each([{}, { order_edit: { id: 999 } }, { order_edit: { order_id: '../111' } }])('rejects a missing/invalid order ID: %j', async body => {
    const service = subject({ success: true });
    await expect(service.handleOrderEdited(body)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.shopifyAdminService.getOrder).not.toHaveBeenCalled();
    expect(service.handleOrderUpdate).not.toHaveBeenCalled();
  });
});
