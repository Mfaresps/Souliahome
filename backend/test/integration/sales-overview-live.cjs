/* Read-only reconciliation of the monthly aggregate with order and invoice records. */
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { TransactionsService } = require('../../dist/transactions/transactions.service');
const { buildOrderArrivalTrend } = require('../../dist/transactions/order-arrival-trend');
const { cairoToday, salesOverviewMonth } = require('../../dist/transactions/sales-overview');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia', { serverSelectionTimeoutMS: 5000 });
  try {
    const db = mongoose.connection.db;
    const collection = name => db.collection(name);
    const aggregateModel = name => ({ collection: { name }, aggregate: pipeline => ({ exec: () => collection(name).aggregate(pipeline).toArray() }) });
    const service = {
      transactionModel: aggregateModel('transactions'),
      shopifyOrderModel: aggregateModel('shopifyorders'),
      returnRequestModel: aggregateModel('returnrequests'),
    };
    const today = cairoToday();
    const year = Number(process.argv[2] || today.slice(0, 4));
    const month = Number(process.argv[3] || today.slice(5, 7));
    const { start, next, count, broadStart, broadEnd } = salesOverviewMonth(year, month);
    const overview = await TransactionsService.prototype.getSalesOverview.call(service, year, month);
    const orders = await collection('shopifyorders').find({ shopifyCreatedAt: { $gte: broadStart, $lt: broadEnd } },
      { projection: { shopifyId: 1, shopifyCreatedAt: 1, total: 1 } }).toArray();
    const ids = orders.map(order => order.shopifyId).filter(Boolean);
    const broad = field => ({ [field]: { $gte: broadStart, $lt: broadEnd } });
    const candidateSales = await collection('transactions').find({ type: 'مبيعات', $or: [
      { shopifyOrderId: { $in: ids } }, broad('shopifyCreatedAt'), broad('transactionDate'), broad('date'),
    ] }, { projection: { shopifyOrderId: 1, shopifyCreatedAt: 1, transactionDate: 1, date: 1, cancelled: 1, archived: 1, total: 1 } }).toArray();
    const sourceIds = [...new Set(candidateSales.map(sale => sale.shopifyOrderId).filter(Boolean))];
    const linkedOrders = await collection('shopifyorders').find({ shopifyId: { $in: sourceIds } },
      { projection: { shopifyId: 1, shopifyCreatedAt: 1, total: 1 } }).toArray();
    const sources = new Map([...orders, ...linkedOrders].map(order => [order.shopifyId, order]));
    const end = `${start.slice(0, 8)}${String(count).padStart(2, '0')}`;
    const trend = buildOrderArrivalTrend([...sources.values()], candidateSales, start, end);
    const activeSales = await collection('transactions').find({
      type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true }, date: { $gte: start, $lt: next },
    }, { projection: { date: 1, itemsTotal: 1, total: 1, shipCost: 1 } }).toArray();
    const returns = await collection('returnrequests').find({
      status: 'معتمد', createdAt: { $gte: new Date(`${start}T00:00:00Z`), $lt: new Date(`${next}T00:00:00Z`) },
      $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }],
    }, { projection: { createdAt: 1, total: 1 } }).toArray();
    const gross = activeSales.reduce((sum, sale) => sum + (Number(sale.itemsTotal) || Number(sale.total) - (Number(sale.shipCost) || 0)), 0);
    const returned = returns.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
    const cohortValues = new Map();
    const arrivalDay = (...values) => {
      for (const value of values) {
        if (!value) continue;
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
        if (!Number.isNaN(new Date(value).getTime())) return cairoToday(new Date(value));
      }
      return '';
    };
    for (const order of sources.values()) cohortValues.set(`shopify:${order.shopifyId}`, {
      date: arrivalDay(order.shopifyCreatedAt), received: Number(order.total) || 0, confirmed: 0,
    });
    for (const sale of candidateSales) {
      const key = sale.shopifyOrderId ? `shopify:${sale.shopifyOrderId}` : `sale:${sale._id}`;
      const row = cohortValues.get(key);
      const source = sources.get(sale.shopifyOrderId);
      cohortValues.set(key, {
        date: row?.date || arrivalDay(sale.shopifyCreatedAt, sale.transactionDate, sale.date),
        received: source ? Number(source.total) || 0 : Math.max(row?.received || 0, Number(sale.total) || 0),
        confirmed: Math.max(row?.confirmed || 0, !sale.cancelled && !sale.archived ? Number(sale.total) || 0 : 0),
      });
    }
    assert.equal(overview.totalOrders, trend.series.reduce((sum, day) => sum + day.receivedOrders, 0));
    assert.equal(overview.confirmedOrders, trend.series.reduce((sum, day) => sum + day.confirmedOrders, 0));
    assert.equal(overview.totalRevenue, round(Math.max(0, gross - returned)));
    assert.equal(overview.averageOrderValue, activeSales.length ? Math.round(gross / activeSales.length) : 0);
    for (let index = 0; index < overview.days.length; index++) {
      const day = overview.days[index], expected = trend.series[index];
      assert.equal(day.date, expected.date);
      assert.equal(day.orders, expected.receivedOrders, `orders on ${day.date}`);
      assert.equal(day.confirmedOrders, expected.confirmedOrders, `confirmed on ${day.date}`);
      const dailyGross = activeSales.filter(sale => String(sale.date).slice(0, 10) === day.date)
        .reduce((sum, sale) => sum + (Number(sale.itemsTotal) || Number(sale.total) - (Number(sale.shipCost) || 0)), 0);
      const dailyReturns = returns.filter(row => row.createdAt.toISOString().slice(0, 10) === day.date)
        .reduce((sum, row) => sum + (Number(row.total) || 0), 0);
      assert.equal(day.revenue, round(dailyGross - dailyReturns), `revenue on ${day.date}`);
      const cohort = [...cohortValues.values()].filter(row => row.date === day.date);
      assert.equal(day.receivedValue, round(cohort.reduce((sum, row) => sum + row.received, 0)), `received value on ${day.date}`);
      assert.equal(day.confirmedValue, round(cohort.reduce((sum, row) => sum + row.confirmed, 0)), `confirmed value on ${day.date}`);
    }
    console.log(`PASS live sales overview ${overview.month}: counts, full received/confirmed values, net accounting revenue; ${overview.days.length} reconciled days.`);
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
