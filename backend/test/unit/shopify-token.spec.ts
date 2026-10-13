const { createShopifyTokenProvider } = require('../../scripts/shopify-token.cjs');
const config = { storeName: 'test-store', clientId: 'test-client-id', clientSecret: 'private-client-secret' };
const response = (token = 'token-1', expires = 86399) => ({ ok: true, status: 200, json: async () => ({ access_token: token, expires_in: expires }) });

describe('Shopify client credentials token renewal', () => {
  it('exchanges credentials using the Shopify grant without following redirects', async () => {
    const fetchFn = jest.fn(async () => response());
    const provider = createShopifyTokenProvider({ fetchFn });
    expect(await provider.getToken(config)).toBe('token-1');
    const [url, options] = fetchFn.mock.calls[0] as any;
    expect(url).toBe('https://test-store.myshopify.com/admin/oauth/access_token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret });
  });
  it('caches a token and refreshes before the reported expiry', async () => {
    let time = 0;
    const fetchFn = jest.fn().mockResolvedValueOnce(response('first')).mockResolvedValueOnce(response('renewed'));
    const provider = createShopifyTokenProvider({ fetchFn, now: () => time });
    expect(await provider.getToken(config)).toBe('first');
    time = 86399 * 1000 - 61000;
    expect(await provider.getToken(config)).toBe('first');
    time += 2000;
    expect(await provider.getToken(config)).toBe('renewed');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('shares one token exchange across concurrent calls', async () => {
    const fetchFn = jest.fn(async () => response());
    const provider = createShopifyTokenProvider({ fetchFn });
    expect(await Promise.all(Array.from({ length: 12 }, () => provider.getToken(config)))).toEqual(Array(12).fill('token-1'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('gets a fresh token after credential changes or a server restart', async () => {
    const fetchFn = jest.fn(async () => response());
    const provider = createShopifyTokenProvider({ fetchFn });
    await provider.getToken(config);
    await provider.getToken({ ...config, clientSecret: 'replacement-secret' });
    await createShopifyTokenProvider({ fetchFn }).getToken(config);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('does not invalidate an already renewed token when another request rejects an older one', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(response('old')).mockResolvedValueOnce(response('new'));
    const provider = createShopifyTokenProvider({ fetchFn });
    await provider.getToken(config);
    provider.invalidate(config, 'old');
    expect(await provider.getToken(config)).toBe('new');
    provider.invalidate(config, 'old');
    expect(await provider.getToken(config)).toBe('new');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('supports static legacy tokens and rejects partial app credentials', async () => {
    const fetchFn = jest.fn(); const provider = createShopifyTokenProvider({ fetchFn });
    expect(await provider.getToken({ accessToken: 'legacy-token' })).toBe('legacy-token');
    await expect(provider.getToken({ ...config, clientSecret: '' })).rejects.toThrow('both required');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('rejects invalid store hosts before sending credentials', async () => {
    const fetchFn = jest.fn();
    await expect(createShopifyTokenProvider({ fetchFn }).getToken({ ...config, storeName: 'attacker.example/path' })).rejects.toThrow('Invalid Shopify store');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('does not echo credential-containing error bodies or cache failed exchanges', async () => {
    const json = jest.fn(async () => ({ error: config.clientSecret }));
    const fetchFn = jest.fn().mockResolvedValueOnce({ ok: false, status: 401, json }).mockResolvedValueOnce(response());
    const provider = createShopifyTokenProvider({ fetchFn });
    await expect(provider.getToken(config)).rejects.toThrow('HTTP 401');
    expect(json).not.toHaveBeenCalled();
    expect(await provider.getToken(config)).toBe('token-1');
  });
  it.each([{ access_token: 'token' }, { access_token: '', expires_in: 10 }, { access_token: 'token', expires_in: -1 }])('rejects unusable token responses: %j', async result => {
    const fetchFn = jest.fn(async () => ({ ok: true, json: async () => result }));
    await expect(createShopifyTokenProvider({ fetchFn }).getToken(config)).rejects.toThrow('Invalid Shopify token response');
  });
});

export {};
