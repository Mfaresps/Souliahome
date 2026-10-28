// Local acceptance check: ONLY status/list/preview, never execute/config/retry.
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { JwtService } = require('@nestjs/jwt');
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
      if (!['status', 'orders?ref=2882', 'preview'].includes(route)) throw new Error('Read-only route allowlist');
      const res = await fetch('http://127.0.0.1:4000/api/shopify/sync/' + route, { method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await res.json(); if (!res.ok) throw new Error('Local endpoint ' + route + ' HTTP ' + res.status + ': ' + result.message);
      return result;
    };
    const status = await request('status');
    if (status.enabled) throw new Error('Acceptance expects auto sync to remain disabled');
    const list = await request('orders?ref=2882');
    if (list.rows.length !== 1) throw new Error('Order 2882 not uniquely available');
    const preview = await request('preview', { transactionIds: [list.rows[0].id], includePayments: false });
    const report = { testedAt: new Date().toISOString(), automaticSync: status.enabled, domain: preview.domain,
      ref: list.rows[0].ref, preview: preview.results.map(({ actions, issues, warnings, matched }) => ({ actions, issues, warnings, matched })),
      shopifyMutationsSent: 0 };
    const dir = path.resolve(__dirname, '../../../artifacts/shopify-sync'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'local-readonly-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await db.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
