// Local read-only browser measurement. API writes are intercepted and never reach the server.
require('dotenv').config();
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
const { performance } = require('node:perf_hooks');
const { TransactionsService } = require('../../dist/transactions/transactions.service.js');
const { buildMovementsPage } = require('../../dist/transactions/movements-page.util.js');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  const db = mongoose.connection.db;
  const projection = Object.fromEntries(TransactionsService.SUMMARY_FIELDS.split(' ').map(field => [field, 1]));
  projection.editHistory = { $slice: 1 };
  const [transactions, returns, supplierReturns] = await Promise.all([
    db.collection('transactions').find({ archived: { $ne: true } }, { projection })
      .sort({ createdAt: -1, _id: -1 }).toArray(),
    db.collection('returnrequests').find({}).toArray(),
    db.collection('supplierreturnorders').find({}, { projection: { status: 1, reversal: 1, returnDate: 1, createdAt: 1, total: 1 } }).toArray(),
  ]);
  const rows = transactions.map(({ editHistory, ...row }) => ({
    ...row, hasEditHistory: Array.isArray(editHistory) && editHistory.length > 0,
  }));
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], requests = [], summaryReads = [], detailReads = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'movements-readonly');
      localStorage.setItem('user', JSON.stringify({ name: 'Audit', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/sales-overview.js') return request.respond({ status: 200,
        contentType: 'application/javascript', body: '' });
      if (!pathname.startsWith('/api/')) return request.continue();
      let body = '[]';
      if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Audit', role: 'admin', perms: [] });
      if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
      if (pathname === '/api/transactions/startup-overview') body = JSON.stringify({ rows: [], activeCount: rows.length });
      if (pathname === '/api/transactions/summary-page') {
        const url = new URL(request.url());
        const number = Number(url.searchParams.get('page') || 1);
        const limit = Number(url.searchParams.get('limit') || 200);
        body = JSON.stringify({ rows: rows.slice((number - 1) * limit, number * limit),
          total: rows.length, page: number, pageSize: limit });
        summaryReads.push(Buffer.byteLength(body));
      }
      if (pathname === '/api/transactions/movements-page') {
        const state = JSON.parse(request.postData() || '{}');
        const result = buildMovementsPage(rows, returns, supplierReturns, state);
        requests.push({ page: state.page, dateFrom: state.dateFrom, dateTo: state.dateTo,
          bytes: Buffer.byteLength(JSON.stringify(result)), total: result.total });
        body = JSON.stringify(result);
      }
      if (/^\/api\/transactions\/[a-f0-9]{24}$/.test(pathname)) {
        const id = pathname.split('/').pop();
        detailReads.push(id);
        body = JSON.stringify(rows.find(row => String(row._id) === id) || null);
      }
      if (pathname === '/api/warehouse-layout') body = JSON.stringify({ warehouses: [], locations: [], labelSizes: [] });
      request.respond({ status: 200, contentType: 'application/json', body });
    });
    const started = performance.now();
    await page.goto('http://127.0.0.1:8080/#transactions', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => _movServerResponse?.total === 1065 &&
      document.querySelectorAll('#mov-table tbody tr').length === 20);
    const initialRenderedRows = await page.$$eval('#mov-table tbody tr', elements => elements.length);
    const count = await page.$eval('#mov-count-all', element => ({
      target: element.dataset.animatedNumberFinal,
      accessible: element.querySelector('.animated-number-sr')?.textContent,
    }));
    assert.deepEqual(count, { target: '1,053', accessible: '1,053' });
    const routeMs = Math.round(performance.now() - started);
    assert.equal(requests.length, 1);
    await page.evaluate(() => { setMovPage(2); renderMovements(); });
    await page.waitForFunction(() => _movServerResponse?.page === 2);
    assert.equal(requests.length, 2);
    await page.evaluate(() => {
      fxState.mov.dateFrom = '2026-10-01'; fxState.mov.dateTo = '2026-10-31';
      movPage = 1; renderMovements(); renderMovements();
    });
    await page.waitForFunction(() => _movServerResponse?.total === 305);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].bytes < 130000, true);
    await page.evaluate((requestRows, supplierRows) => {
      returnRequests = requestRows; supplierReturns = supplierRows;
    }, returns, supplierReturns);
    const after = await page.evaluate(async () => {
      fxState.mov.dateFrom = ''; fxState.mov.dateTo = '';
      movPage = 1; _movServerKey = '';
      const start = performance.now();
      await renderMovementsServer();
      return { ms: Math.round(performance.now() - start),
        kpi: Object.fromEntries(['sales', 'purchases', 'remainingCollection'].map(key =>
          [key, window._movKpiCharts[key]?.n])) };
    });
    const before = await page.evaluate(async () => {
      _movLegacyFallback = true;
      const start = performance.now();
      transactions = await loadTransactionSummaries({ forceFull: true });
      renderMovementsLegacy();
      return { ms: Math.round(performance.now() - start),
        kpi: Object.fromEntries(['sales', 'purchases', 'remainingCollection'].map(key =>
          [key, window._movKpiCharts[key]?.n])) };
    });
    assert.equal(summaryReads.length, 6);
    assert.deepEqual(after.kpi, before.kpi);
    for (const sort of ['date-desc', 'date-asc', 'amount-desc', 'amount-asc',
      'client-desc', 'client-asc', 'ref-desc', 'ref-asc', 'priority-desc']) {
      const browserIds = await page.evaluate(value => {
        fxState.mov.sort = value; renderMovementsLegacy(); return window._movOrderSeq;
      }, sort);
      const serverIds = buildMovementsPage(rows, returns, supplierReturns,
        { page: 1, limit: 20, sort }).orderIds;
      assert.deepEqual(browserIds, serverIds, `${sort} order differs`);
    }
    const dateWindows = [];
    for (const dateField of ['transactionDate', 'createdAt']) {
      const client = await page.evaluate(field => {
        fxState.mov.sort = 'date-desc'; fxState.mov.dateField = field;
        fxState.mov.dateFrom = '2026-10-01'; fxState.mov.dateTo = '2026-10-31';
        renderMovementsLegacy();
        return { tx: window._movOrderSeq.length, total: window._movOrderSeq.length
          + filterReturnRequestsForMovementsList().length };
      }, dateField);
      const server = buildMovementsPage(rows, returns, supplierReturns,
        { page: 1, limit: 20, sort: 'date-desc', dateField,
          dateFrom: '2026-10-01', dateTo: '2026-10-31' });
      assert.deepEqual(client, { tx: server.transactionCount, total: server.total });
      dateWindows.push({ dateField, ...client });
    }
    for (const search of ['20268000004', '#priority']) {
      const client = await page.evaluate(value => {
        fxState.mov.dateFrom = ''; fxState.mov.dateTo = '';
        document.querySelector('#mov-search').value = value;
        renderMovementsLegacy();
        return { ids: window._movOrderSeq, total: window._movOrderSeq.length
          + filterReturnRequestsForMovementsList().length };
      }, search);
      const server = buildMovementsPage(rows, returns, supplierReturns,
        { page: 1, limit: 20, sort: 'date-desc', search });
      assert.deepEqual(client.ids, server.orderIds, `${search} search differs`);
      assert.equal(client.total, server.total);
    }
    const detailId = String(rows.find(row => row.type === 'مبيعات')._id);
    await page.evaluate(id => showInvoiceDetail(id), detailId);
    await page.waitForFunction(id => transactions.find(row => String(row._id) === id)?._fullyHydrated,
      {}, detailId);
    assert.equal(detailReads.filter(id => id === detailId).length, 1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ routeMs, requests, comparison: {
      beforeMs: before.ms, afterMs: after.ms, beforeRequests: summaryReads.length, afterRequests: 1,
      beforeBytes: summaryReads.reduce((sum, bytes) => sum + bytes, 0),
      afterBytes: requests[3].bytes, kpiMatched: true, sortModesMatched: 9,
      detailReads: detailReads.length, dateWindows,
    },
      initialRenderedRows }, null, 2));
    await page.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
