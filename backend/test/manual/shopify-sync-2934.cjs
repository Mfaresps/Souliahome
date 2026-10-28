// Order-specific repair. Preview by default; --apply sends shipping ONLY for #2934.
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { JwtService } = require('@nestjs/jwt');
const { ShopifySyncApiService } = require('../../dist/shopify/sync/sync-api.service');
const env = require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../../.env')));
const uri = env.MONGODB_URI;
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27018\/soulia(?:\?|$)/.test(uri || '')) throw new Error('Expected local Soulia database');
(async () => {
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const admin = await db.collection('users').findOne({ role: 'admin', isActive: { $ne: false } });
    if (!admin) throw new Error('Local admin not found');
    const token = new JwtService({ secret: env.JWT_SECRET || 'soulia_jwt_default_secret' }).sign({ sub: String(admin._id), username: admin.username }, { expiresIn: '5m' });
    const request = async (route, body) => {
      if (!['status', 'orders?ref=2934', 'preview', ...(process.argv.includes('--apply') ? ['execute'] : [])].includes(route)) throw new Error('Route allowlist');
      const res = await fetch('http://127.0.0.1:4000/api/shopify/sync/' + route, { method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await res.json(); if (!res.ok) throw new Error('Local endpoint ' + route + ' HTTP ' + res.status + ': ' + result.message);
      return result;
    };
    const status = await request('status');
    if (status.enabled) throw new Error('Acceptance expects auto sync to remain disabled');
    const list = await request('orders?ref=2934');
    if (list.rows.length !== 1) throw new Error('Order 2934 not uniquely available');
    const preview = await request('preview', { transactionIds: [list.rows[0].id], includePayments: false });
    if (preview.domain !== 'tscxpn-ze.myshopify.com' || list.rows[0].orderId !== '7227495973165') throw new Error('Unexpected store or order');
    const report = { testedAt: new Date().toISOString(), automaticSync: status.enabled, domain: preview.domain,
      ref: list.rows[0].ref, preview: preview.results.map(({ actions, issues, warnings, matched }) => ({ actions, issues, warnings, matched })),
      shopifyMutationsSent: 0 };
    const dir = path.resolve(__dirname, '../../../artifacts/shopify-sync'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2934-preview.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--apply')) {
      const p = preview.results[0];
      if (p.issues.length || p.actions.some(a => !['تسجيل تنفيذ الطلب المسلّم يدويًا بدون رقم تتبع', 'تحديث التوصيل: DELIVERED'].includes(a))) throw new Error('Unexpected preview; no execution');
      const saved = await db.collection('settings').findOne({});
      const client = new ShopifySyncApiService({ getShopifyConfig: async () => ({ storeName: saved.shopifyStoreName,
        clientId: saved.shopifyClientId, clientSecret: saved.shopifyClientSecret, accessToken: saved.shopifyAccessToken }) });
      const connection = await client.connection();
      const before = await client.read(list.rows[0].orderId, connection.shopId);
      if (!p.matched) {
        const queued = await request('execute', { tokens: [p.token] });
        if (queued.results[0].error) throw new Error(queued.results[0].error);
        let result;
        for (let n = 0; n < 20; n++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          result = (await request('orders?ref=2934')).rows[0].sync;
          if (!['pending', 'running'].includes(result?.status)) break;
        }
        if (result?.status !== 'synced') throw new Error('Shipping result: ' + result?.status + ': ' + (result?.error || ''));
      }
      const after = await client.read(list.rows[0].orderId, connection.shopId);
      if (after.displayFulfillmentStatus !== 'FULFILLED' || !after.fulfillments.some(f => f.events.nodes.some(e => e.status === 'DELIVERED'))) throw new Error('Shopify shipping read-back did not confirm delivery');
      if (after.displayFinancialStatus !== before.displayFinancialStatus || JSON.stringify(after.transactions) !== JSON.stringify(before.transactions)) throw new Error('Financial state changed unexpectedly');
      const verified = { ref: '2934', orderId: list.rows[0].orderId, verifiedAt: new Date().toISOString(),
        before: { fulfillment: before.displayFulfillmentStatus, payment: before.displayFinancialStatus },
        after: { fulfillment: after.displayFulfillmentStatus, payment: after.displayFinancialStatus,
          shipments: after.fulfillments.map(f => ({ id: f.id, status: f.displayStatus, tracking: f.trackingInfo, events: f.events.nodes })) },
        paymentUnchanged: true };
      fs.writeFileSync(path.join(dir, '2934-verified.json'), JSON.stringify(verified, null, 2));
      console.log(JSON.stringify(verified, null, 2));
    }
  } finally { await db.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
