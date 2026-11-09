// Read-only startup endpoint profile against the configured database/API.
// Requests only the GET paths observed in the prior browser startup run.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { performance } = require('node:perf_hooks');

const artifact = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../artifacts/phase6-populated-after.json'), 'utf8').replace(/^\uFEFF/, ''));
const run = artifact.runs[0];
const paths = [...new Set(run.api.slice(0, run.startupApi))]
  .filter(route => process.env.SKIP_VAULT !== '1' || route !== '/api/vault');
const apiOrigin = process.env.TEST_API || 'http://127.0.0.1:4000/api';

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  try {
    const admin = await mongoose.connection.db.collection('users').findOne(
      { role: 'admin', isActive: { $ne: false } },
      { projection: { _id: 1, username: 1 } });
    if (!admin) throw new Error('No active admin account for read-only endpoint profile');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
    const results = [];
    for (const route of paths) {
      const started = performance.now();
      try {
        const response = await fetch(apiOrigin + route.replace(/^\/api/, ''), {
          method: 'GET', headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
        });
        const body = await response.arrayBuffer();
        results.push({ path: route, status: response.status,
          bytes: body.byteLength, ms: Math.round(performance.now() - started) });
      } catch (error) {
        results.push({ path: route, error: error.message,
          ms: Math.round(performance.now() - started) });
      }
    }
    console.log(JSON.stringify({ mode: 'read-only-live-api', endpoints: results,
      totalBytes: results.reduce((sum, row) => sum + (row.bytes || 0), 0),
      totalMsSequential: results.reduce((sum, row) => sum + row.ms, 0) }, null, 2));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
