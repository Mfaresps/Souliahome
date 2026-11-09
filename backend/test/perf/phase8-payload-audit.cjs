// Read-only payload and Mongo query profile. Outputs sizes/counts only, never record values.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { performance } = require('node:perf_hooks');

const origin = process.env.TEST_API || 'http://127.0.0.1:4000/api';
const keyBytes = rows => {
  const fields = new Map();
  for (const row of rows) for (const [key, value] of Object.entries(row))
    fields.set(key, (fields.get(key) || 0) + Buffer.byteLength(JSON.stringify({ [key]: value })));
  return [...fields].sort((a, b) => b[1] - a[1]).map(([key, bytes]) => ({ key, bytes }));
};
async function get(token, route) {
  const started = performance.now();
  const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return { value: JSON.parse(raw), bytes: Buffer.byteLength(raw), ms: Math.round(performance.now() - started) };
}
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  try {
    const db = mongoose.connection.db;
    const admin = await db.collection('users').findOne({ role: 'admin', isActive: { $ne: false } },
      { projection: { _id: 1, username: 1 } });
    if (!admin) throw new Error('No active admin');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
    const followupRoute = process.env.FOLLOWUP_ROUTE || '/followups';
    const transactionRoute = process.env.TRANSACTION_ROUTE || '/transactions/startup-overview';
    const [followups, transactions] = await Promise.all([
      get(token, followupRoute), get(token, transactionRoute),
    ]);
    const fRows = Array.isArray(followups.value) ? followups.value : followups.value.rows;
    const tRows = Array.isArray(transactions.value) ? transactions.value : transactions.value.rows;
    const fFields = '_id ticketNo orderRef transactionId shopifyOrderId clientName responsibleId responsibleName reason status autoSource assignSource orderOutcome cancelled createdAt deferredUntil deferReason'.split(' ');
    const tFields = '_id type ref date createdAt client phone deposit remaining payStatus cancelled cancelRequest bostaOrderId bostaTrackingNumber bostaStatus bostaLastSync bostaDeliveryException pickupStatus pickupDate shippedAt deliveredAt deliverySource shipmentAttempts shopifyOrderId shipIssueState failedDelivery shipCo'.split(' ');
    const project = (row, fields) => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
    const fCandidate = fRows.map(row => project(row, fFields));
    const tCandidate = tRows.map(row => ({ ...project(row, tFields),
      ...(row.carrierSettlement ? { carrierSettlement: project(row.carrierSettlement,
        'status reason variance readAt remaining deliveredAt fees'.split(' ')) } : {}) }));
    const fProjection = Object.fromEntries(fFields.map(field => [field, 1]));
    const tProjection = Object.fromEntries(tFields.map(field => [field, 1]));
    for (const field of 'status reason variance readAt remaining deliveredAt fees.sizeName'.split(' '))
      tProjection[`carrierSettlement.${field}`] = 1;
    const followupCursor = db.collection('followups').find().sort({ createdAt: -1 });
    if (followupRoute.endsWith('dashboard-summary')) followupCursor.project(fProjection);
    const followupExplain = await followupCursor.explain('executionStats');
    const transactionCursor = db.collection('transactions').find({ archived: { $ne: true }, $or: [
      { type: 'مبيعات' }, { 'cancelRequest.status': 'معلق' }, { 'carrierSettlement.status': 'review' },
    ] });
    if (transactionRoute.endsWith('dashboard-overview')) transactionCursor.project(tProjection);
    const transactionExplain = await transactionCursor.explain('executionStats');
    const stats = explain => ({ executionMs: explain.executionStats?.executionTimeMillis,
      docsExamined: explain.executionStats?.totalDocsExamined,
      keysExamined: explain.executionStats?.totalKeysExamined,
      returned: explain.executionStats?.nReturned });
    console.log(JSON.stringify({ mode: 'read-only-live', followups: { route: followupRoute,
      count: fRows.length, bytes: followups.bytes, apiMs: followups.ms,
      candidateBytes: Buffer.byteLength(JSON.stringify(fCandidate)), fields: keyBytes(fRows),
      query: stats(followupExplain) }, transactions: { route: transactionRoute,
      count: tRows.length, activeCount: transactions.value.activeCount,
      bytes: transactions.bytes, apiMs: transactions.ms,
      candidateBytes: Buffer.byteLength(JSON.stringify({ rows: tCandidate, activeCount: transactions.value.activeCount })),
      carrierSettlementFields: keyBytes(tRows.filter(row => row.carrierSettlement).map(row => row.carrierSettlement)),
      fields: keyBytes(tRows),
      query: stats(transactionExplain) } }, null, 2));
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
