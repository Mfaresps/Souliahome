import { ShopifySyncApiService, SyncApiError } from '../../src/shopify/sync/sync-api.service';
import { ShopifyAdminService } from '../../src/shopify/shopify-admin.service';

describe('outbound Shopify transport', () => {
  let api: ShopifySyncApiService, fetchMock: jest.SpyInstance;
  const settings: any = { getShopifyConfig: async () => ({ storeName: 'test-store', accessToken: 'private-test-token', clientId: '', clientSecret: '' }) };
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    api = new ShopifySyncApiService(settings);
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([429, 500, 403])('classifies HTTP %s for safe retry', async code => {
    fetchMock.mockResolvedValue({ ok: false, status: code });
    try { await api.query('mutation { test }', {}, true); throw new Error('expected failure'); }
    catch (e: any) { expect(e).toBeInstanceOf(SyncApiError); expect(e.transient).toBe(code !== 403); expect(e.uncertain).toBe(code === 500); expect(e.message).not.toContain('private-test-token'); }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('treats a mutation timeout as uncertain without a blind transport retry', async () => {
    fetchMock.mockRejectedValue(new Error('socket closed'));
    await expect(api.query('mutation { test }', {}, true)).rejects.toMatchObject({ transient: true, uncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects a different connected shop before any write', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { shop: { id: 'other' }, order: {} } }) });
    await expect(api.read('123', 'expected')).rejects.toThrow('تغير المتجر');
  });
  it('sends delivery status to the fulfillment, with the original event timestamp', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { fulfillmentEventCreate: { fulfillmentEvent: { id: 'event' }, userErrors: [] } } }) });
    const input = { fulfillmentId: 'gid://shopify/Fulfillment/1', status: 'DELIVERED', happenedAt: '2026-10-25T10:00:11Z' };
    await api.apply({ kind: 'event', label: 'delivery', input });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.input).toEqual(input); expect(body.query).toContain('fulfillmentEventCreate');
  });
  it('classifies userErrors as a definite failure even on HTTP 200', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { metafieldsSet: { metafields: null, userErrors: [{ message: 'stale digest' }] } } }) });
    await expect(api.apply({ kind: 'metadata', label: 'metadata', input: {} })).rejects.toMatchObject({ transient: false, uncertain: false });
  });
  it('legacy fulfillment, cancellation and payment callers cannot bypass the queue setting', async () => {
    fetchMock.mockRejectedValue(new Error('must not use network'));
    const sync: any = { legacyRequest: jest.fn(async () => ({ success: false, error: 'disabled' })) };
    const old = new ShopifyAdminService(settings, sync);
    expect((await old.fulfillOrder('1', 'tracking')).success).toBe(false);
    expect((await old.cancelOrder('1')).success).toBe(false);
    expect((await old.markOrderPaid('1', 100)).success).toBe(false);
    expect(sync.legacyRequest).toHaveBeenCalledTimes(3); expect(fetchMock).not.toHaveBeenCalled();
  });
});
