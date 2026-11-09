// Seven paired read-only MongoDB query/serialization measurements on populated data.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const mongoose = require('mongoose');
const base = ['bostaRawResponse', 'bostaStatusIgnoredEvents', 'bostaTrackingEvents',
  'bostaAwbBase64', 'bostaAwbType'];
const extra = ['editHistory', 'carrierSettlement', 'pickupHistory', 'payments',
  'deposits', 'deliveryAuditLog', 'afterSalesEvents', 'bostaAwbPrints',
  'pickingExceptions', 'bostaShippedAddress'];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const collection = mongoose.connection.db.collection('transactions');
    const filter = { type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } };
    const runs = [];
    for (let i = 0; i < 7; i++) {
      const pair = {};
      for (const name of i % 2 ? ['workspace', 'legacy'] : ['legacy', 'workspace']) {
        const excluded = name === 'legacy' ? base : [...base, ...extra];
        const projection = Object.fromEntries(excluded.map(field => [field, 0]));
        const start = performance.now();
        const rows = await collection.find(filter, { projection }).sort({ createdAt: -1 }).toArray();
        const queryMs = performance.now() - start;
        const serialized = JSON.stringify(rows);
        pair[name] = { rows: rows.length, queryMs: +queryMs.toFixed(1),
          stringifyMs: +(performance.now() - start - queryMs).toFixed(1),
          bytes: Buffer.byteLength(serialized) };
      }
      runs.push(pair);
    }
    console.log(JSON.stringify({ runs }));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
