import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { EventEmitter } from 'events';
import { createHmac } from 'crypto';

const script = readFileSync(resolve(__dirname, '../../scripts/check-shopify-webhook.cjs'), 'utf8');

function run(options: { missingSecret?: boolean; missingToken?: boolean; invalidStore?: boolean; proxyStatus?: number; adminStatus?: number; adminBody?: any; proxyTimeout?: boolean; adminTimeout?: boolean; stored?: any } = {}) {
  const env: Record<string, string> = {
    SHOPIFY_WEBHOOK_SECRET: 'test-secret', SHOPIFY_STORE_NAME: 'test-store', SHOPIFY_ACCESS_TOKEN: 'test-token',
  };
  if (options.missingSecret) delete env.SHOPIFY_WEBHOOK_SECRET;
  if (options.missingToken) delete env.SHOPIFY_ACCESS_TOKEN;
  if (options.invalidStore) env.SHOPIFY_STORE_NAME = 'unexpected.example/path';
  if (options.stored) env.MONGODB_URI = 'mongodb://test-only/settings';
  const proc = { env, exitCode: 0, exit: (code: number) => { throw { exitCode: code }; } };
  const consoleMock = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const requests: any[] = [];
  const close = jest.fn(async () => {});
  const tokenExchange = jest.fn(async (_config: any) => 'generated-token');
  const mongo = { createConnection: () => ({ asPromise: async () => {}, close,
    collection: () => ({ findOne: async () => options.stored }) }) };
  let completion: any;
  function request(kind: 'proxy' | 'admin', config: any, callback: any) {
    requests.push({ kind, config });
    const req: any = new EventEmitter();
    req.destroy = (error: Error) => req.emit('error', error);
    req.end = (body: string) => {
      if ((kind === 'proxy' && options.proxyTimeout) || (kind === 'admin' && options.adminTimeout)) {
        req.emit('timeout'); return;
      }
      if (kind === 'proxy') expect(body).toBe('{}');
      const res: any = new EventEmitter();
      res.statusCode = kind === 'proxy' ? options.proxyStatus ?? 200 : options.adminStatus ?? 200;
      res.setEncoding = () => {};
      callback(res);
      res.emit('data', JSON.stringify(kind === 'proxy'
        ? { saved: false, reason: 'بيانات ناقصة - لا يوجد id' }
        : options.adminBody ?? { orders: [{ id: 111 }] }));
      res.emit('end');
    };
    return req;
  }
  try {
    completion = runInNewContext(script, {
      require: (name: string) => name === 'node:http'
        ? { request: (_url: string, config: any, cb: any) => request('proxy', config, cb) }
        : name === 'node:https' ? { request: (config: any, cb: any) => request('admin', config, cb) }
        : name === 'mongoose' ? mongo
        : name === './shopify-token.cjs' ? { createShopifyTokenProvider: () => ({ getToken: tokenExchange }) }
        : { createHmac },
      Buffer, process: proc, console: consoleMock,
    });
  } catch (error: any) {
    if (error.exitCode !== 1) throw error;
    proc.exitCode = error.exitCode;
  }
  return { proc, consoleMock, requests, completion, close, tokenExchange };
}

describe('Shopify deployment health check', () => {
  it('verifies the signed proxy request and read-only Shopify access without logging credentials or order data', () => {
    const result = run();
    expect(result.proc.exitCode).toBe(0);
    expect(result.requests.map(r => r.kind)).toEqual(['proxy', 'admin']);
    expect(result.requests[0].config.headers['X-Shopify-Hmac-Sha256']).toBe(createHmac('sha256', 'test-secret').update('{}').digest('base64'));
    expect(result.requests[1].config).toMatchObject({ method: 'GET', hostname: 'test-store.myshopify.com', path: expect.stringContaining('fields=id') });
    const logs = JSON.stringify(result.consoleMock.log.mock.calls);
    for (const sensitive of ['test-secret', 'test-token', '111']) expect(logs).not.toContain(sensitive);
  });
  it.each([{ proxyStatus: 400 }, { proxyTimeout: true }])('fails when configured webhook reception is broken: %j', options => {
    const result = run(options);
    expect(result.proc.exitCode).toBe(1);
    expect(result.consoleMock.error).toHaveBeenCalled();
  });
  it.each([
    { missingSecret: true }, { missingToken: true }, { invalidStore: true },
    { adminStatus: 401 }, { adminStatus: 403 }, { adminBody: { errors: 'bad token' } }, { adminTimeout: true },
  ])('reports incomplete setup without preventing admin access or working new-order webhooks: %j', options => {
    const result = run(options);
    expect(result.proc.exitCode).toBe(0);
    expect(result.consoleMock.warn).toHaveBeenCalled();
  });
  it('does not send the API token when the proxy check fails or store name is invalid', () => {
    for (const options of [{ proxyStatus: 400 }, { invalidStore: true }]) {
      expect(run(options).requests.map(r => r.kind)).toEqual(['proxy']);
    }
  });
  it('checks the persisted signing key after deploy rather than an obsolete environment value', async () => {
    const result = run({ stored: { shopifyWebhookSecret: 'saved-in-database', shopifyStoreName: 'saved-store', shopifyAccessToken: 'saved-token' } });
    await result.completion;
    expect(result.proc.exitCode).toBe(0);
    expect(result.requests[0].config.headers['X-Shopify-Hmac-Sha256']).toBe(createHmac('sha256', 'saved-in-database').update('{}').digest('base64'));
    expect(result.requests[1].config).toMatchObject({ hostname: 'saved-store.myshopify.com', headers: { 'X-Shopify-Access-Token': 'saved-token' } });
    expect(result.close).toHaveBeenCalledTimes(1);
  });
  it('uses persistent app credentials for the deployment API read check instead of an expired static token', async () => {
    const result = run({ stored: { shopifyWebhookSecret: 'saved-key', shopifyStoreName: 'saved-store', shopifyClientId: 'app-id', shopifyClientSecret: 'app-secret', shopifyAccessToken: 'expired-token' } });
    await result.completion; await Promise.resolve();
    expect(result.tokenExchange).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'app-id', clientSecret: 'app-secret', storeName: 'saved-store' }));
    expect(result.requests[1].config.headers['X-Shopify-Access-Token']).toBe('generated-token');
    expect(result.proc.exitCode).toBe(0);
  });
});
