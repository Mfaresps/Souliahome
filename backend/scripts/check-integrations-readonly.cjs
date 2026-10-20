'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

// Local settings only, GET requests only. No token renewal, webhook invocation or storage writes.
async function main() {
  const env = { ...process.env };
  const file = path.resolve(__dirname, '../.env');
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && !env[match[1]]) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const uri = env.MONGODB_URI;
  if (!uri || !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(uri)) throw new Error('Local loopback MongoDB configuration required');
  const connection = mongoose.createConnection(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  let settings;
  try {
    await connection.asPromise();
    settings = await connection.collection('settings').findOne({}) || {};
  } finally { await connection.close(); }
  const result = { checkedAt: new Date().toISOString(), source: 'local settings / environment; production server configuration not inspected', methods: ['GET'], providers: {} };
  const get = async (url, headers) => {
    try {
      const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      await response.body?.cancel();
      return { reachable: response.ok, httpStatus: response.status };
    } catch { return { reachable: false, error: 'Network request failed or timed out' }; }
  };
  const store = String(settings.shopifyStoreName || env.SHOPIFY_STORE_NAME || '').trim();
  const token = settings.shopifyAccessToken || env.SHOPIFY_ACCESS_TOKEN;
  result.providers.shopify = /^[a-z0-9][a-z0-9-]*$/i.test(store) && token
    ? await get(`https://${store}.myshopify.com/admin/api/2024-01/orders/count.json?status=any`, { 'X-Shopify-Access-Token': token })
    : { skipped: true, reason: 'No existing store/access token for GET-only verification; app credential token exchange was not performed' };
  const bostaKey = settings.bostaApiKey || env.BOSTA_API_KEY;
  result.providers.bosta = bostaKey
    ? await get('https://app.bosta.co/api/v2/users/profile', { Authorization: bostaKey })
    : { skipped: true, reason: 'No Bosta API key in local settings/environment' };
  const cfg = {
    accountId: settings.r2AccountId || env.R2_ACCOUNT_ID,
    accessKeyId: settings.r2AccessKeyId || env.R2_ACCESS_KEY_ID,
    secretAccessKey: settings.r2SecretAccessKey || env.R2_SECRET_ACCESS_KEY,
    bucket: settings.r2Bucket || 'soulia-backups',
  };
  if (cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey) {
    const { r2ListObjects } = require('../dist/shared/r2-uploader.util.js');
    const listed = await r2ListObjects(cfg, 'backups/');
    result.providers.cloudflareR2 = { reachable: listed.ok, backupObjects: listed.ok ? listed.objects.length : undefined,
      ...(!listed.ok ? { error: 'Read-only backup listing failed' } : {}) };
  } else result.providers.cloudflareR2 = { skipped: true, reason: 'Incomplete R2 credentials in local settings/environment' };
  const output = path.resolve(__dirname, '../../artifacts/pre-release-integrations-readonly.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => { console.error('Read-only integration inspection failed; credentials and database addresses were not printed.'); process.exitCode = 1; });
