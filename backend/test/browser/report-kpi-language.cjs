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
        totalSales: 1000, orderCount: 2, avgOrderValue: 500, netProfit: 200,
        grossProfit: 300, totalPurchases: 0, expenseTotal: 100,
        returnCount: 0, totalReturns: 0, totalDeposit: 300,
        totalRemaining: 700, totalShipping: 50, totalShipLoss: 10,
        transactionCount: 2, series: [],
        bestSellingProduct: { name: 'Linen Set', qty: 2, revenue: 800 },
        productProfits: [{ name: 'Linen Set', qty: 2, rev: 800, cost: 500, profit: 300 }],
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
        period: document.querySelector('#rep-period-echo').textContent.trim(),
        visibleArabic: [...document.querySelectorAll('.rep-page-header, #rep-panel-kpis')]
          .map(el => el.innerText).join(' ').match(/[\u0600-\u06ff]+/g) || [],
      };
      en.allExplanationArabic = [];
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
    await page.setViewport({ width: 390, height: 900 });
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
    console.log('PASS report KPI language: formal Arabic, English switch, explanations, drill, mobile labels');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
