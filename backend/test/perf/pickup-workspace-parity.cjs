// Read-only parity check against the populated database. Never writes an order.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const omit = new Set(['editHistory', 'carrierSettlement', 'pickupHistory',
  'payments', 'deposits', 'deliveryAuditLog', 'afterSalesEvents',
  'bostaAwbPrints', 'pickingExceptions', 'bostaShippedAddress']);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const user = await mongoose.connection.db.collection('users').findOne({ role: 'admin', isActive: { $ne: false } });
    assert(user, 'Active admin fixture is required');
    const token = jwt.sign({ sub: String(user._id), username: user.username }, process.env.JWT_SECRET);
    async function get(pathname) {
      const start = performance.now();
      const response = await fetch('http://127.0.0.1:4000/api/' + pathname,
        { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(response.status, 200, pathname);
      const raw = await response.text();
      return { rows: JSON.parse(raw), bytes: Buffer.byteLength(raw), ms: +(performance.now() - start).toFixed(1) };
    }
    const old = await get('transactions/pickup-orders');
    const compact = await get('transactions/pickup-orders/workspace');
    assert.equal(compact.rows.length, old.rows.length);
    for (let i = 0; i < old.rows.length; i++) {
      const expected = Object.fromEntries(Object.entries(old.rows[i]).filter(([key]) => !omit.has(key)));
      assert.deepEqual(compact.rows[i], expected, 'Row mismatch at index ' + i);
    }
    const deniedUser = await mongoose.connection.db.collection('users').findOne({
      role: { $ne: 'admin' }, isActive: { $ne: false }, perms: { $nin: ['pickup-orders'] },
    });
    let deniedStatus = null;
    if (deniedUser) {
      const deniedToken = jwt.sign({ sub: String(deniedUser._id), username: deniedUser.username }, process.env.JWT_SECRET);
      const denied = await fetch('http://127.0.0.1:4000/api/transactions/pickup-orders/workspace',
        { headers: { Authorization: 'Bearer ' + deniedToken } });
      deniedStatus = denied.status;
      assert.equal(deniedStatus, 403, 'Workspace endpoint must keep pickup permission guard');
    }
    console.log(JSON.stringify({ rows: old.rows.length, oldBytes: old.bytes,
      workspaceBytes: compact.bytes, oldMs: old.ms, workspaceMs: compact.ms,
      identicalRetainedFields: true, deniedStatus }));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
