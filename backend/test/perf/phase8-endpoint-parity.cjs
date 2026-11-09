// Read-only contract and permission parity on the populated database.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const origin = process.env.TEST_API || 'http://127.0.0.1:4000/api';

function assertSubset(projected, source, path = '') {
  if (Array.isArray(projected)) {
    assert.ok(Array.isArray(source), `${path}: source array`);
    assert.equal(projected.length, source.length, `${path}: array length`);
    projected.forEach((item, index) => assertSubset(item, source[index], `${path}[${index}]`));
    return;
  }
  if (projected && typeof projected === 'object') {
    assert.ok(source && typeof source === 'object', `${path}: source object`);
    for (const [key, value] of Object.entries(projected)) assertSubset(value, source[key], `${path}.${key}`);
    return;
  }
  assert.deepEqual(projected, source, path);
}
async function get(token, route) {
  const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, value: response.ok ? await response.json() : null };
}
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  try {
    const users = await mongoose.connection.db.collection('users')
      .find({ role: { $in: ['admin', 'staff', 'viewer'] }, isActive: { $ne: false } },
        { projection: { _id: 1, username: 1, role: 1 } }).toArray();
    const chosen = [...new Map(users.map(user => [user.role, user])).values()];
    const results = [];
    for (const user of chosen) {
      const token = jwt.sign({ sub: String(user._id), username: user.username },
        process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
      const [fullFu, dashFu, fullTx, dashTx] = await Promise.all([
        get(token, '/followups'), get(token, '/followups/dashboard-summary'),
        get(token, '/transactions/startup-overview'), get(token, '/transactions/dashboard-overview'),
      ]);
      assert.equal(dashFu.status, fullFu.status, `${user.role}: Follow-ups permission`);
      assert.equal(dashTx.status, fullTx.status, `${user.role}: Transactions permission`);
      if (fullFu.status === 200) {
        assert.equal(dashFu.value.length, fullFu.value.length, `${user.role}: Follow-ups count`);
        for (let i = 0; i < dashFu.value.length; i++) assertSubset(dashFu.value[i], fullFu.value[i], `followups[${i}]`);
        if (fullFu.value.length) {
          const detail = await get(token, `/followups/${fullFu.value[0]._id}`);
          assert.equal(detail.status, 200, `${user.role}: Follow-up detail permission`);
          assert.deepEqual(detail.value, fullFu.value[0], `${user.role}: Follow-up full detail`);
        }
      }
      if (fullTx.status === 200) {
        assert.equal(dashTx.value.activeCount, fullTx.value.activeCount, `${user.role}: activeCount`);
        assert.equal(dashTx.value.rows.length, fullTx.value.rows.length, `${user.role}: transaction rows`);
        for (let i = 0; i < dashTx.value.rows.length; i++) assertSubset(dashTx.value.rows[i], fullTx.value.rows[i], `transactions[${i}]`);
      }
      results.push({ role: user.role, followupsStatus: fullFu.status,
        followupsCount: fullFu.value?.length ?? null, transactionsStatus: fullTx.status,
        transactionsCount: fullTx.value?.rows?.length ?? null,
        activeCount: fullTx.value?.activeCount ?? null });
    }
    console.log(JSON.stringify({ mode: 'read-only-live-parity', results }, null, 2));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
