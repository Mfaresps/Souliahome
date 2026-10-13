import { EventEmitter } from 'events';
import { ShopifyAdminService } from '../../src/shopify/shopify-admin.service';
const https = require('https');
describe('Shopify API renewable token retry', () => {
  afterEach(() => jest.restoreAllMocks());
  function service(statuses: number[]) {
    let tokens = 0, calls = 0;
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, status: 200,
      json: async () => ({ access_token: 'issued-' + (++tokens), expires_in: 86399 }) }) as any);
    const request = jest.spyOn(https, 'request').mockImplementation((options: any, callback: any) => {
      const req: any = new EventEmitter(); req.write = jest.fn();
      req.end = () => {
        const res: any = new EventEmitter(); res.statusCode = statuses[calls++] ?? 200;
        callback(res); res.emit('data', JSON.stringify({ orders: [], errors: 'Authorization rejected' })); res.emit('end');
      };
      return req;
    });
    const settings: any = { getShopifyConfig: async () => ({ storeName: 'test-store', clientId: 'client-id', clientSecret: 'client-secret', accessToken: 'obsolete-static-token' }) };
    return { admin: new ShopifyAdminService(settings), fetch, request };
  }
  it('renews after HTTP 401 and retries with the new token', async () => {
    const { admin, fetch, request } = service([401, 200]);
    expect(await admin.listOrders({ limit: 1 })).toMatchObject({ success: true, orders: [] });
    expect(fetch).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[0][0] as any).headers['X-Shopify-Access-Token']).toBe('issued-1');
    expect((request.mock.calls[1][0] as any).headers['X-Shopify-Access-Token']).toBe('issued-2');
  });
  it('stops after one authentication retry', async () => {
    const { admin, fetch, request } = service([401, 401]);
    expect((await admin.listOrders()).success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not attempt token renewal for a permissions failure', async () => {
    const { admin, fetch, request } = service([403]);
    expect((await admin.listOrders()).success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
  });
});
