// A signed payload without an order ID exercises the public proxy and HMAC
// verification without creating an order, notification or financial movement.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
if (!secret || !secret.trim()) {
  console.error('Shopify webhook check failed: SHOPIFY_WEBHOOK_SECRET is missing.');
  process.exit(1);
}

const body = '{}';
const req = http.request('http://frontend/api/shopify/webhook', {
  method: 'POST',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-Shopify-Topic': 'orders/create',
    'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', secret).update(body).digest('base64'),
  },
}, res => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', chunk => { data += chunk; });
  res.on('error', fail);
  res.on('end', () => {
    let result;
    try { result = JSON.parse(data); } catch { /* Report only non-secret status. */ }
    if (res.statusCode !== 200 || result?.saved !== false ||
        result?.reason !== 'بيانات ناقصة - لا يوجد id') {
      fail(new Error(`signed empty-order probe returned HTTP ${res.statusCode}; check proxy and webhook configuration`));
      return;
    }
    console.log('Shopify webhook proxy and signature check passed (no order created).');
    checkAdminApi();
  });
});
function fail(error) {
  console.error(`Shopify webhook check failed: ${error.message}`);
  process.exitCode = 1;
}
req.on('error', fail);
req.on('timeout', () => req.destroy(new Error('request timed out')));
req.end(body);

function checkAdminApi() {
  const store = process.env.SHOPIFY_STORE_NAME || '';
  const token = process.env.SHOPIFY_ACCESS_TOKEN || '';
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(store) || !token.trim()) {
    fail(new Error('SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN are required for order edits and recovery'));
    return;
  }
  // Match the application's Admin API request, reading IDs only. Never print
  // credentials or customer/order data, including Shopify error response bodies.
  const adminReq = https.request({
    hostname: `${store}.myshopify.com`,
    path: '/admin/api/2024-01/orders.json?limit=1&status=any&fields=id',
    method: 'GET',
    timeout: 10000,
    headers: { 'X-Shopify-Access-Token': token },
  }, res => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { data += chunk; });
    res.on('error', fail);
    res.on('end', () => {
      let result;
      try { result = JSON.parse(data); } catch { /* Non-secret status only. */ }
      if (res.statusCode !== 200 || !Array.isArray(result?.orders)) {
        fail(new Error(`Shopify Admin API order read returned HTTP ${res.statusCode}; verify the token and read_orders permission`));
        return;
      }
      console.log('Shopify Admin API order read check passed.');
    });
  });
  adminReq.on('error', fail);
  adminReq.on('timeout', () => adminReq.destroy(new Error('Shopify Admin API request timed out')));
  adminReq.end();
}
