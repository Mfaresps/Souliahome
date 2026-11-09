// Read-only local measurement of the Movements response against the configured database.
require('dotenv').config();
const mongoose = require('mongoose');
const { performance } = require('node:perf_hooks');
const { TransactionsService } = require('../../dist/transactions/transactions.service.js');
const { buildMovementsPage } = require('../../dist/transactions/movements-page.util.js');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  const db = mongoose.connection.db;
  const fields = TransactionsService.SUMMARY_FIELDS.split(' ');
  const projection = Object.fromEntries(fields.map(field => [field, 1]));
  projection.editHistory = { $slice: 1 };
  const started = performance.now();
  const [transactions, returns, supplierReturns] = await Promise.all([
    db.collection('transactions').find({ archived: { $ne: true } }, { projection })
      .sort({ createdAt: -1, _id: -1 }).toArray(),
    db.collection('returnrequests').find({}).toArray(),
    db.collection('supplierreturnorders').find({}, { projection: { status: 1, reversal: 1, returnDate: 1, createdAt: 1, total: 1 } }).toArray(),
  ]);
  const readMs = performance.now() - started;
  const summaries = transactions.map(({ editHistory, ...row }) => ({
    ...row, hasEditHistory: Array.isArray(editHistory) && editHistory.length > 0,
  }));
  const scenarios = [
    ['default', { page: 1, limit: 20, sort: 'date-desc' }],
    ['page2', { page: 2, limit: 20, sort: 'date-desc' }],
    ['october', { page: 1, limit: 20, sort: 'date-desc', dateFrom: '2026-10-01', dateTo: '2026-10-31' }],
    ['delivered', { page: 1, limit: 20, sort: 'date-desc', pickup: ['Delivered'] }],
    ['amount', { page: 1, limit: 20, sort: 'date-desc', amountMin: '1000', amountMax: '3000' }],
    ['exchange', { page: 1, limit: 20, sort: 'date-desc', operation: ['exchange'] }],
  ];
  const measurements = scenarios.map(([name, state]) => {
    const t0 = performance.now();
    const result = buildMovementsPage(summaries, returns, supplierReturns, state);
    const computeMs = performance.now() - t0;
    return { name, total: result.total, transactionCount: result.transactionCount,
      pageRows: result.pageRows.length, responseBytes: Buffer.byteLength(JSON.stringify(result)),
      computeMs: Math.round(computeMs * 10) / 10 };
  });
  const sampleSale = transactions.find(row => row.type === 'مبيعات');
  const service = Object.create(TransactionsService.prototype);
  service.transactionModel = mongoose.model('TransactionAuditRead',
    new mongoose.Schema({}, { strict: false }), 'transactions');
  const history = sampleSale
    ? await service.findMovementCustomerHistory(String(sampleSale._id), 'admin') : [];
  console.log(JSON.stringify({ transactionRows: transactions.length, returnRows: returns.length,
    supplierReturnRows: supplierReturns.length, readMs: Math.round(readMs * 10) / 10,
    sixPageBytes: Buffer.byteLength(JSON.stringify(summaries)),
    customerHistoryLookup: Array.isArray(history), measurements }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
