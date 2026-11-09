// Read-only comparison of transaction records available to Follow-ups.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { performance } = require('node:perf_hooks');

const origin = process.env.TEST_API || 'http://127.0.0.1:4000/api';
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  try {
    const admin = await mongoose.connection.db.collection('users').findOne(
      { role: 'admin', isActive: { $ne: false } }, { projection: { _id: 1, username: 1 } });
    if (!admin) throw new Error('No active admin account');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
    const requests = [];
    const get = async route => {
      const started = performance.now();
      const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`${route}: ${response.status}`);
      const body = await response.text();
      requests.push({ route, bytes: Buffer.byteLength(body), ms: Math.round(performance.now() - started) });
      return JSON.parse(body);
    };
    const [overview, first, followups] = await Promise.all([
      get('/transactions/startup-overview'), get('/transactions/summary-page?page=1&limit=200'), get('/followups'),
    ]);
    const overviewRows = Array.isArray(overview) ? overview : overview.rows || [];
    const firstRows = Array.isArray(first) ? first : first.rows || [];
    const total = first.total ?? first.totalCount ?? first.pagination?.total ?? firstRows.length;
    const pageCount = Math.ceil(total / 200);
    const rest = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, i) =>
      get(`/transactions/summary-page?page=${i + 2}&limit=200`)));
    const full = firstRows.concat(...rest.map(page => Array.isArray(page) ? page : page.rows || []));
    const byId = rows => new Map(rows.map(row => [String(row._id), row]));
    const byRef = rows => new Map(rows.filter(row => row.ref).map(row => [String(row.ref), row]));
    const fullId = byId(full), fullRef = byRef(full), overId = byId(overviewRows), overRef = byRef(overviewRows);
    const missingLinked = [];
    let linkedFull = 0, linkedOverview = 0;
    for (const f of followups) {
      const find = (ids, refs) => ids.get(String(f.transactionId)) || refs.get(String(f.orderRef));
      const old = find(fullId, fullRef), next = find(overId, overRef);
      if (old) linkedFull++;
      if (next) linkedOverview++;
      if (old && !next) missingLinked.push({ type: old.type, archived: !!old.archived });
    }
    const sales = full.filter(row => row.type === 'مبيعات');
    const missingSales = sales.filter(row => !overId.has(String(row._id)));
    const fields = ['_id', 'type', 'ref', 'client', 'phone', 'cancelled', 'createdAt', 'date'];
    const fieldMismatches = Object.fromEntries(fields.map(field => [field, 0]));
    for (const row of sales) {
      const next = overId.get(String(row._id));
      if (!next) continue;
      for (const field of fields) if (String(row[field] ?? '') !== String(next[field] ?? '')) fieldMismatches[field]++;
    }
    console.log(JSON.stringify({ fullCount: full.length, overviewCount: overviewRows.length,
      salesCount: sales.length, missingSalesCount: missingSales.length,
      followupsCount: followups.length, linkedFull, linkedOverview,
      summaryPages: requests.filter(r => r.route.startsWith('/transactions/summary-page')).length,
      summaryBytes: requests.filter(r => r.route.startsWith('/transactions/summary-page')).reduce((n, r) => n + r.bytes, 0),
      summaryMsAggregate: requests.filter(r => r.route.startsWith('/transactions/summary-page')).reduce((n, r) => n + r.ms, 0),
      missingLinkedCount: missingLinked.length, missingLinkedTypes: missingLinked.reduce((o, r) => {
        const key = `${r.type || 'unknown'}:${r.archived}`; o[key] = (o[key] || 0) + 1; return o;
      }, {}), fieldMismatches }, null, 2));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
