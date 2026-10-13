// Verify configured webhooks without creating an order. Unconfigured installs
// remain accessible so the admin can save the signing key in Settings.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

function fail(error) {
  console.error('Shopify webhook check failed: ' + error.message);
  process.exitCode = 1;
}

async function main() {
  let stored = {};
  if (process.env.MONGODB_URI) {
    const mongoose = require('mongoose');
    const connection = mongoose.createConnection(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    try {
      await connection.asPromise();
      stored = await connection.collection('settings').findOne({}, {
        projection: { shopifyWebhookSecret: 1, shopifyStoreName: 1, shopifyAccessToken: 1, shopifyClientId: 1, shopifyClientSecret: 1 },
      }) || {};
    } catch {
      throw new Error('Unable to read persistent Shopify settings');
    } finally {
      await connection.close();
    }
  }
  const config = {
    webhookSecret: stored.shopifyWebhookSecret || process.env.SHOPIFY_WEBHOOK_SECRET || '',
    storeName: stored.shopifyStoreName || process.env.SHOPIFY_STORE_NAME || '',
    accessToken: stored.shopifyAccessToken || process.env.SHOPIFY_ACCESS_TOKEN || '',
    clientId: stored.shopifyClientId || process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: stored.shopifyClientSecret || process.env.SHOPIFY_CLIENT_SECRET || '',
  };
  if (!config.webhookSecret.trim()) {
    console.warn('Shopify order webhooks are NOT configured. Save the signing key in Settings > Shipping > Shopify.');
    return;
  }
  const body = '{}';
  const req = http.request('http://frontend/api/shopify/webhook', {
    method: 'POST', timeout: 10000,
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', config.webhookSecret).update(body).digest('base64'),
    },
  }, res => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { data += chunk; });
    res.on('error', fail);
    res.on('end', () => {
      let result;
      try { result = JSON.parse(data); } catch { /* Non-secret status only. */ }
      if (res.statusCode !== 200 || result?.saved !== false || result?.reason !== 'بيانات ناقصة - لا يوجد id') {
        fail(new Error('signed empty-order probe returned HTTP ' + res.statusCode + '; check proxy and webhook configuration'));
        return;
      }
      console.log('Shopify webhook proxy and signature check passed (no order created).');
      checkAdminApi(config);
    });
  });
  req.on('error', fail);
  req.on('timeout', () => req.destroy(new Error('request timed out')));
  req.end(body);
}

async function checkAdminApi(config) {
  const usesAppCredentials = !!(config.clientId || config.clientSecret);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(config.storeName) || (usesAppCredentials ? !config.clientId || !config.clientSecret : !config.accessToken.trim())) {
    console.warn('Shopify Admin API is NOT configured. New-order webhooks work independently; configure imports and order edits in Settings > Shipping > Shopify.');
    return;
  }
  const warn = () => console.warn('Shopify Admin API order read failed. Verify the store, token and read_orders permission in Settings > Shipping > Shopify. New-order webhooks work independently.');
  let accessToken = config.accessToken;
  if (usesAppCredentials) {
    try { accessToken = await require('./shopify-token.cjs').createShopifyTokenProvider().getToken(config); }
    catch { console.warn('Shopify app authentication failed. Verify Client ID, Client secret, installation and organization in Settings > Shipping > Shopify.'); return; }
  }
  const req = https.request({
    hostname: config.storeName + '.myshopify.com',
    path: '/admin/api/2024-01/orders.json?limit=1&status=any&fields=id',
    method: 'GET', timeout: 10000,
    headers: { 'X-Shopify-Access-Token': accessToken },
  }, res => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { data += chunk; });
    res.on('error', warn);
    res.on('end', () => {
      let result;
      try { result = JSON.parse(data); } catch { /* Never log credentials/customer data. */ }
      if (res.statusCode !== 200 || !Array.isArray(result?.orders)) { warn(); return; }
      console.log('Shopify Admin API order read check passed.');
    });
  });
  req.on('error', warn);
  req.on('timeout', () => req.destroy(new Error('request timed out')));
  req.end();
}

main().catch(fail);
