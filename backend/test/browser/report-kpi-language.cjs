/* Reports overview localization against the real page in Chromium; no backend requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test') {
        if (url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(publicDir, 'index.html')) });
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
          return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
        }
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: '' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'load' });
    const result = await page.evaluate(() => {
      const report = {
        totalSales: 1000, orderCount: 2, avgOrderValue: 500, netProfit: 280,
        grossProfit: 380, totalPurchases: 440, expenseTotal: 100,
        returnCount: 0, totalReturns: 0, totalDeposit: 300,
        totalRemaining: 700, totalShipping: 50, totalShipLoss: 10,
        transactionCount: 2, series: [
          { date: '2026-11-07', sales: 400, purchases: 180 }, { date: '2026-11-08', sales: 600, purchases: 260 },
        ],
        topCustomers: [{ name: 'Mona Hassan', revenue: 600, orders: 1 }],
        bestSellingProduct: { name: 'Linen Set', qty: 2, revenue: 800 },
        productProfits: [
          { name: 'Linen Set', qty: 2, rev: 400, cost: 100, profit: 300 },
          { name: 'Clay Tray', qty: 1, rev: 550, cost: 450, profit: 100 },
          { name: 'Glass Vase', qty: 1, rev: 50, cost: 70, profit: -20 },
        ],
      };
      currentUser = { _id: 'language-admin', name: 'Admin', role: 'admin', perms: [] };
      currentPage = 'reports';
      reportsUnlocked = true;
      currentReportData = report;
      transactions = [];
      supplierReturns = [];
      expenses = [];
      document.querySelector('#app').style.display = '';
      document.querySelector('#login-page').style.display = 'none';
      document.querySelector('#splash-screen')?.remove();
      document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-reports'));

      currentLang = 'en';
      applyLang();
      const en = {
        tab: document.querySelector('[data-rep-tab="kpis"] [data-i18n="repTabKpis"]').textContent.trim(),
        preset: document.querySelector('[data-rep-preset="all"]').textContent.trim(),
        group: document.querySelector('#rep-kpi-heading-overview').textContent.trim(),
        kpi: document.querySelector('.rep-kpi-card--rep_sales .rep-kpi-label').textContent.trim(),
        product: document.querySelector('.rep-profit-head h3').textContent.trim(),
        column: document.querySelector('#rep-profit-table .rep-cell-num[data-label="Revenue"]')?.getAttribute('data-label'),
        quantity: document.querySelector('#rep-best-seller-qty').textContent.trim(),
        summaryTitle: document.querySelector('#rep-advanced-trend-title').textContent.trim(),
        summaryLine: document.querySelector('.rep-advanced-line')?.getAttribute('d'),
        summarySeries: document.querySelectorAll('.rep-advanced-line[data-rep-series]').length,
        summaryCustomer: document.querySelector('.rep-advanced-customer').textContent.trim(),
        rankProfitFirst: document.querySelector('.rep-profit-rank-row .rep-profit-rank-product strong')?.textContent.trim(),
        rankLossCount: document.querySelector('.rep-profit-rank-head')?.textContent.trim(),
        period: document.querySelector('#rep-period-echo').textContent.trim(),
        visibleArabic: [...document.querySelectorAll('.rep-page-header, #rep-panel-kpis')]
          .map(el => el.innerText).join(' ').match(/[\u0600-\u06ff]+/g) || [],
      };
      en.allExplanationArabic = [];
      const emptySummary = renderReportAdvancedSummary({ ...report, totalSales: 0, netProfit: 0, series: [], topCustomers: [] });
      en.emptySummary = {
        trend: emptySummary.includes('No daily sales or purchases in this period.'),
        customer: emptySummary.includes('No customer sales in this period.'),
        noFakeGoal: !emptySummary.includes('Enterprise Adoption') && !emptySummary.includes('Target: 90%'),
      };
      renderReportAdvancedSummary(report);
      const plot = document.querySelector('#rep-advanced-chart');
      plot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: plot.getBoundingClientRect().left + 1 }));
      en.hoverActive = plot.classList.contains('is-active');
      en.hoverDate = document.querySelector('.rep-advanced-readout-date').textContent.trim();
      en.hoverSales = document.querySelector('.rep-advanced-readout-value[data-rep-series="sales"]').textContent.trim();
      en.hoverPurchases = document.querySelector('.rep-advanced-readout-value[data-rep-series="purchases"]').textContent.trim();
      document.querySelector('.rep-advanced-toggle[data-rep-series="purchases"]').click();
      en.purchaseToggle = document.querySelector('.rep-advanced-toggle[data-rep-series="purchases"]').getAttribute('aria-pressed');
      en.purchaseLineHidden = document.querySelector('.rep-advanced-line[data-rep-series="purchases"]').classList.contains('is-hidden');
      document.querySelector('.rep-advanced-toggle[data-rep-series="sales"]').click();
      en.salesStillVisible = document.querySelector('.rep-advanced-toggle[data-rep-series="sales"]').getAttribute('aria-pressed');
      document.querySelector('.rep-advanced-toggle[data-rep-series="purchases"]').click();
      plot.focus();
      plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      en.keyboardDate = document.querySelector('.rep-advanced-readout-date').textContent.trim();
      plot.blur();
      setRepProfitRankSort('revenue');
      en.rankRevenueFirst = document.querySelector('.rep-profit-rank-row .rep-profit-rank-product strong')?.textContent.trim();
      document.querySelector('#profit-search').value = 'glass';
      filterProfitTable();
      en.rankSearch = [...document.querySelectorAll('.rep-profit-rank-product strong')].map(el => el.textContent.trim());
      en.tableSearch = [...document.querySelectorAll('#rep-profit-table tbody .rep-cell-name')].map(el => el.textContent.trim());
      document.querySelector('#profit-search').value = '';
      setRepProfitRankSort('profit');
      for (const id of Object.keys(REP_KPI_META)) {
        openRepKpiExplain(id);
        en.allExplanationArabic.push(...(document.querySelector('#ds-explain-overlay').innerText.match(/[\u0600-\u06ff]+/g) || []));
      }
      openRepKpiExplain('rep_avg');
      en.explain = document.querySelector('#dse-title').textContent.trim();
      en.explainRows = [...document.querySelectorAll('#dse-rows .dse-row-val')].map(el => el.textContent.trim());
      document.querySelector('#ds-explain-overlay').classList.remove('active');
      openRepKpiDrill('rep_purchases');
      en.drill = document.querySelector('.rd-head-label').textContent.trim();
      en.drillRule = document.querySelector('.rd-rule').textContent.trim();
      en.drillSearch = document.querySelector('#rd-search').placeholder;
      closeRepKpiDrill();

      currentLang = 'ar';
      applyLang();
      const ar = {
        group: document.querySelector('#rep-kpi-heading-overview').textContent.trim(),
        kpi: document.querySelector('.rep-kpi-card--rep_sales .rep-kpi-label').textContent.trim(),
        product: document.querySelector('.rep-profit-head h3').textContent.trim(),
        column: document.querySelector('#rep-profit-table .rep-cell-num[data-label="الإيراد"]')?.getAttribute('data-label'),
      };
      openRepKpiExplain('rep_avg');
      ar.explainLabel = document.querySelector('#dse-rows .dse-row-label').textContent.trim();
      return { en, ar, explanationLengthsMatch: Object.keys(REP_KPI_META).every(id => REP_KPI_META[id].rows.length === REP_KPI_EXPLANATIONS_EN[id].length) };
    });
    assert.equal(result.en.tab, 'Performance indicators');
    assert.equal(result.en.preset, 'All');
    assert.equal(result.en.group, 'Performance summary');
    assert.equal(result.en.kpi, 'Total sales');
    assert.equal(result.en.product, 'Product profitability');
    assert.equal(result.en.column, 'Revenue');
    assert.equal(result.en.quantity, '2 units');
    assert.equal(result.en.summaryTitle, 'Sales and purchases trend');
    assert.match(result.en.summaryLine, /^M/);
    assert.equal(result.en.summarySeries, 2);
    assert.equal(result.en.hoverActive, true);
    assert.match(result.en.hoverDate, /7 Nov 2026/);
    assert.match(result.en.hoverSales, /400/);
    assert.match(result.en.hoverPurchases, /180/);
    assert.equal(result.en.purchaseToggle, 'false');
    assert.equal(result.en.purchaseLineHidden, true);
    assert.equal(result.en.salesStillVisible, 'true');
    assert.match(result.en.keyboardDate, /8 Nov 2026/);
    assert.match(result.en.summaryCustomer, /Mona Hassan/);
    assert.match(result.en.summaryCustomer, /60% of sales/);
    assert.equal(result.en.rankProfitFirst, 'Linen Set');
    assert.match(result.en.rankLossCount, /1 at a loss/);
    assert.equal(result.en.rankRevenueFirst, 'Clay Tray');
    assert.deepEqual(result.en.rankSearch, ['Glass Vase']);
    assert.deepEqual(result.en.tableSearch, ['Glass Vase']);
    assert.deepEqual(result.en.emptySummary, { trend: true, customer: true, noFakeGoal: true });
    assert.match(result.en.period, /Displayed period:.*All time/);
    assert.deepEqual(result.en.visibleArabic, []);
    assert.equal(result.en.explain, 'Average invoice value');
    assert.deepEqual(result.en.allExplanationArabic, []);
    assert.ok(result.en.explainRows.every(row => row && !/[\u0600-\u06ff]/.test(row)));
    assert.equal(result.en.drill, 'Net purchases');
    assert.match(result.en.drillRule, /Calculation rule:/);
    assert.equal(result.en.drillSearch, 'Search records...');
    assert.equal(result.ar.group, 'ملخص الأداء');
    assert.equal(result.ar.kpi, 'إجمالي المبيعات');
    assert.equal(result.ar.product, 'تحليل ربحية الأصناف');
    assert.equal(result.ar.column, 'الإيراد');
    assert.equal(result.ar.explainLabel, 'التعريف');
    assert.equal(result.explanationLengthsMatch, true);
    if (process.env.REPORT_PREVIEW_DIR) {
      const output = path.resolve(process.env.REPORT_PREVIEW_DIR);
      fs.mkdirSync(output, { recursive: true });
      await page.evaluate(() => {
        document.querySelector('#ds-explain-overlay')?.classList.remove('active');
        currentLang = 'en'; applyLang();
      });
      await page.setViewport({ width: 1440, height: 900 });
      await page.screenshot({ path: path.join(output, 'reports-en-1440.png') });
      await page.evaluate(() => {
        document.querySelector('.rep-advanced-trend')?.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -80);
        setRepTrendHoverIndex(0);
      });
      await page.screenshot({ path: path.join(output, 'trend-en-1440.png') });
      await page.evaluate(() => document.body.classList.add('dark-mode'));
      await page.screenshot({ path: path.join(output, 'trend-dark-1440.png') });
      await page.evaluate(() => document.body.classList.remove('dark-mode'));
      await page.evaluate(() => document.querySelector('#rep-profit-ranked')?.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(output, 'profit-en-1440.png') });
      await page.evaluate(() => { currentLang = 'ar'; applyLang(); });
    }
    await page.setViewport({ width: 390, height: 900 });
    if (process.env.REPORT_PREVIEW_DIR) {
      await page.screenshot({ path: path.join(path.resolve(process.env.REPORT_PREVIEW_DIR), 'reports-ar-390.png') });
      await page.evaluate(() => document.querySelector('.rep-advanced-margin')?.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(path.resolve(process.env.REPORT_PREVIEW_DIR), 'reports-ar-390-summary.png') });
      await page.evaluate(() => {
        document.querySelector('.rep-advanced-trend')?.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -100);
        setRepTrendHoverIndex(1);
      });
      await page.screenshot({ path: path.join(path.resolve(process.env.REPORT_PREVIEW_DIR), 'trend-ar-390.png') });
      await page.evaluate(() => {
        document.querySelector('.rep-profit-panel')?.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -100);
      });
      await page.screenshot({ path: path.join(path.resolve(process.env.REPORT_PREVIEW_DIR), 'profit-ar-390.png') });
    }
    const mobile = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, label: document.querySelector('#rep-profit-table .rep-cell-num[data-label="الإيراد"]')?.getAttribute('data-label') }));
    assert.ok(mobile.width <= mobile.viewport + 1, `Horizontal overflow: ${mobile.width} > ${mobile.viewport}`);
    assert.equal(mobile.label, 'الإيراد');
    const mobileEnglish = await page.evaluate(() => {
      currentLang = 'en';
      applyLang();
      return { viewport: innerWidth, width: document.documentElement.scrollWidth,
        label: document.querySelector('#rep-profit-table .rep-cell-num[data-label="Revenue"]')?.getAttribute('data-label') };
    });
    assert.ok(mobileEnglish.width <= mobileEnglish.viewport + 1, `English horizontal overflow: ${mobileEnglish.width} > ${mobileEnglish.viewport}`);
    assert.equal(mobileEnglish.label, 'Revenue');
    assert.deepEqual(errors, []);
    console.log('PASS report KPIs: two-series chart hover, toggles, keyboard, empty state, Arabic/English, drill, mobile labels');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
