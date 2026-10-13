const { createHash } = require('node:crypto');

// Tokens stay in server memory. Credentials are read from persistent settings;
// a restart simply acquires a fresh token. Concurrent callers share one exchange.
function createShopifyTokenProvider({ fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  const keyOf = config => createHash('sha256').update(JSON.stringify([config.storeName, config.clientId, config.clientSecret])).digest('hex');
  async function getToken(config) {
    if (!config.clientId && !config.clientSecret) return config.accessToken || '';
    if (!config.clientId || !config.clientSecret) throw new Error('Shopify Client ID and Client secret are both required');
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(config.storeName || '')) throw new Error('Invalid Shopify store name');
    const key = keyOf(config);
    const saved = cache.get(key);
    if (saved && now() < saved.refreshAt) return saved.token;
    if (pending.has(key)) return pending.get(key);
    const exchange = (async () => {
      let response;
      try {
        response = await fetchFn('https://' + config.storeName + '.myshopify.com/admin/oauth/access_token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }).toString(),
        });
      } catch { throw new Error('Shopify token request failed: network or timeout'); }
      if (!response.ok) throw new Error('Shopify token request failed (HTTP ' + response.status + '); verify app installation, organization and credentials');
      let result;
      try { result = await response.json(); } catch { throw new Error('Invalid Shopify token response'); }
      const lifetime = Number(result.expires_in) * 1000;
      if (typeof result.access_token !== 'string' || !result.access_token.trim() || /[\r\n]/.test(result.access_token) || !Number.isFinite(lifetime) || lifetime <= 0) throw new Error('Invalid Shopify token response');
      // Retain only the active configuration; rotating credentials cannot reuse
      // a token issued for the previous app or store.
      cache.clear();
      cache.set(key, { token: result.access_token, refreshAt: now() + lifetime - Math.min(60000, lifetime / 10) });
      return result.access_token;
    })();
    pending.set(key, exchange);
    try { return await exchange; } finally { pending.delete(key); }
  }
  function invalidate(config, token) {
    if (!config.clientId || !config.clientSecret) return;
    const key = keyOf(config);
    if (cache.get(key)?.token === token) cache.delete(key);
  }
  return { getToken, invalidate };
}
module.exports = { createShopifyTokenProvider };
