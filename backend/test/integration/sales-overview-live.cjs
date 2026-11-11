/* Read-only reconciliation of the monthly aggregate with order and invoice records. */
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { TransactionsService } = require('../../dist/transactions/transactions.service');
const { shopifyConfirmationBucket } = require('../../dist/shopify/shopify-confirmation.util');
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
    const orders = await collection('shopifyorders').find({ $or: [
      { shopifyCreatedAt: { $gte: broadStart, $lt: broadEnd } },
      { createdAt: { $gte: new Date(broadStart), $lt: new Date(broadEnd) } },
    ] }, { projection: { shopifyCreatedAt: 1, createdAt: 1, total: 1, status: 1, cancelled: 1,
      shipWithoutDeposit: 1, depositAmount: 1, 'depositReceipts.status': 1, 'depositReceipts.amount': 1 } }).toArray();
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
    for (const order of orders) {
      const date = arrivalDay(order.shopifyCreatedAt, order.createdAt);
      if (!date || date < start || date >= next) continue;
      const bucket = shopifyConfirmationBucket(order);
      const confirmedCount = bucket === 'deposit' || bucket === 'nodep';
      cohortValues.set(String(order._id), { date, received: Number(order.total) || 0,
        confirmedCount, confirmed: confirmedCount ? Number(order.total) || 0 : 0 });
    }
    assert.equal(overview.orderSource, 'shopify');
    assert.equal(overview.totalOrders, cohortValues.size);
    assert.equal(overview.confirmedOrders, [...cohortValues.values()].filter(row => row.confirmedCount).length);
    assert.equal(overview.totalRevenue, round(Math.max(0, gross - returned)));
    assert.equal(overview.averageOrderValue, activeSales.length ? Math.round(gross / activeSales.length) : 0);
    for (let index = 0; index < overview.days.length; index++) {
      const day = overview.days[index];
      const dailyGross = activeSales.filter(sale => String(sale.date).slice(0, 10) === day.date)
        .reduce((sum, sale) => sum + (Number(sale.itemsTotal) || Number(sale.total) - (Number(sale.shipCost) || 0)), 0);
      const dailyReturns = returns.filter(row => row.createdAt.toISOString().slice(0, 10) === day.date)
        .reduce((sum, row) => sum + (Number(row.total) || 0), 0);
      assert.equal(day.revenue, round(dailyGross - dailyReturns), `revenue on ${day.date}`);
      const cohort = [...cohortValues.values()].filter(row => row.date === day.date);
      assert.equal(day.orders, cohort.length, `Shopify orders on ${day.date}`);
      assert.equal(day.confirmedOrders, cohort.filter(row => row.confirmedCount).length, `Shopify confirmations on ${day.date}`);
      assert.equal(day.receivedValue, round(cohort.reduce((sum, row) => sum + row.received, 0)), `received value on ${day.date}`);
      assert.equal(day.confirmedValue, round(cohort.reduce((sum, row) => sum + row.confirmed, 0)), `confirmed value on ${day.date}`);
    }
    console.log(`PASS live sales overview ${overview.month}: Shopify counts/confirmation values, separate net accounting revenue; ${overview.days.length} reconciled days.`);
  } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
