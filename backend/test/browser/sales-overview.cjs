const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const pub = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new vm.Script(match[1]);
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const local = path.join(pub, url.pathname.slice(1));
      if (url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
      if ((url.pathname.endsWith('.css') || ['/sales-overview.js', '/admin-team-home.js', '/order-status.js', '/designme/date-range-picker/soulia-range.js'].includes(url.pathname)) && fs.existsSync(local)) {
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(local) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'sales-admin', name: 'Admin', role: 'admin', perms: [] };
      currentPage = 'dashboard'; currentLang = 'en';
      document.documentElement.dir = 'ltr';
      document.getElementById('app').style.display = '';
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('splash-screen')?.remove();
      document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-dashboard'));
      localStorage.setItem('token', 'sales-overview-browser-fixture');
      buildSidebar = () => {}; buildNotifications = () => {}; loadDashboardTreasury = () => {};
      window.overviewCalls = [];
      window.operationalCalls = [];
      transactions = [
        { _id: 'ship-issue-1', type: 'مبيعات', ref: 'S-1', client: 'Shipping customer',
          date: '2026-11-09', total: 100, bostaStatus: 'FAILED_ATTEMPT', shipIssueState: 'open' },
        { _id: 'ship-delivered-1', type: 'مبيعات', ref: 'S-2', client: 'Delivered customer',
          date: '2025-01-14', deliveredAt: '2025-01-15', total: 200, bostaStatus: 'DELIVERED' },
      ];
      window.operationalRows = transactions;
      api = async url => {
        const route = url.split('?')[0];
        if (route !== '/transactions/sales-overview') {
          operationalCalls.push(url);
          if (route === '/followups') return [];
          if (route === '/employee-performance/duty-board') return { onDuty: [{ userId: 'worker-1', name: 'Shift worker', receivesOrders: true, shiftStart: '09:00', shiftEnd: '17:00', remainingMinutes: 60 }], nextUp: [], onLeave: [] };
          if (route === '/employee-performance/team-workspace') return { totals: { pending: 1, followUps: 0, issues: 1 }, employees: [] };
          if (route === '/transactions/startup-overview') return { rows: operationalRows, activeCount: operationalRows.length };
          throw new Error(`Unexpected dashboard request: ${url}`);
        }
        assertUrl(url);
        overviewCalls.push(url);
        const params = new URLSearchParams(url.split('?')[1]);
        const year = Number(params.get('year')), month = Number(params.get('month'));
        const key = `${year}-${String(month).padStart(2, '0')}`;
        const length = new Date(year, month, 0).getDate();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        return { month: key, timeZone: 'Africa/Cairo', totalOrders: length, totalRevenue: length * 100,
          confirmedOrders: length - 1, averageOrderValue: 100, today: today.startsWith(key) ? today : null,
          days: Array.from({ length }, (_, index) => ({ date: `${key}-${String(index + 1).padStart(2, '0')}`, orders: 1, confirmedOrders: 1, revenue: 100 })) };
      };
      function assertUrl(url) { if (!url.startsWith('/transactions/sales-overview?')) throw new Error(`Unexpected dashboard request: ${url}`); }
    });
    await page.evaluate(async () => { renderDashWelcome(false); await loadDashboard(); });
    assert.equal(await page.$$eval('#so-metrics .so-metric', nodes => nodes.length), 4);
    assert.equal(await page.$('#dash-stats'), null);
    assert.equal(await page.evaluate(() => overviewCalls.length), 1);
    assert.equal(await page.$eval('#dash-staff-section', node => getComputedStyle(node).display !== 'none'), true, 'shipping operations are visible below sales');
    assert.equal(await page.$('#dash-ship-subbar'), null, 'shipping date controls and duplicate total are removed');
    assert.equal(await page.$('#dash-ship-total'), null);
    assert.equal(await page.$$eval('#dash-myorders-section .ds-toggle-pair button', nodes => nodes.length), 2, 'My Orders period buttons remain');
    assert.equal(await page.$eval('#dash-tab-count-delivered', node => node.textContent), '1', 'an older delivery remains in the unfiltered dashboard');
    await page.$eval('.ds-ship-tab[data-tab="delivered"]', button => button.click());
    assert((await page.$eval('#dash-staff-pickedup', node => node.textContent)).includes('S-2'), 'older delivered order remains visible');
    assert.equal(await page.$eval('#dash-tab-count-issues', node => node.textContent), '1');
    assert.equal(await page.$eval('#dash-attn-section', node => getComputedStyle(node).display !== 'none'), true, 'shipping attention is visible');
    await page.$eval('.ds-ship-tab[data-tab="issues"]', button => button.click());
    const issueList = await page.$eval('#dash-staff-pickedup', node => node.textContent);
    assert(issueList.includes('S-1'), `shipping issue list retains its order: ${issueList.slice(0, 400)}; errors=${errors.join(' | ')}; tab=${await page.evaluate(() => _dashShipTab)}`);
    await page.waitForFunction(() => document.querySelector('#dash-admin-team')?.textContent.includes('Team oversight'));
    await page.waitForFunction(() => document.querySelector('#dash-duty-section')?.style.display !== 'none');
    assert(await page.$eval('#dash-duty-admin', node => node.textContent.includes('Shift worker')), 'on-duty staff remains visible');
    if (process.env.SALES_OPERATIONS_SHOT) {
      await page.setViewport({ width: 1440, height: 900 });
      await page.$eval('#dash-staff-section', section => section.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: process.env.SALES_OPERATIONS_SHOT });
      await page.setViewport({ width: 800, height: 600 });
    }
    if (process.env.SALES_OPERATIONS_MOBILE_SHOT) {
      await page.setViewport({ width: 390, height: 900 });
      await new Promise(resolve => setTimeout(resolve, 160));
      await page.$eval('#dash-staff-section', section => section.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: process.env.SALES_OPERATIONS_MOBILE_SHOT });
      await page.setViewport({ width: 800, height: 600 });
    }
    assert.equal(await page.$$eval('#so-chart-canvas .so-point.is-today', nodes => nodes.length), 1);
    await page.$eval('#so-chart-canvas .so-point.is-today', point => point.focus());
    assert(await page.$eval('#so-tip', tip => !tip.hidden && tip.textContent.includes('Revenue')));

    await page.evaluate(() => {
      const input = document.getElementById('so-month');
      input.value = '2025-12'; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('so-month').value === '2025-12' && document.querySelectorAll('#so-chart-canvas .so-point').length === 31);
    assert.equal(await page.$eval('#so-metrics .so-metric-value', node => node.textContent.trim()), '31');
    await page.$eval('#so-next', button => button.click());
    await page.waitForFunction(() => document.getElementById('so-month').value === '2026-01' && document.querySelectorAll('#so-chart-canvas .so-point').length === 31);
    await page.$eval('#so-prev', button => button.click());
    await page.waitForFunction(() => document.getElementById('so-month').value === '2025-12' && document.querySelectorAll('#so-chart-canvas .so-point').length === 31);
    assert.equal(await page.evaluate(() => overviewCalls.length), 3, 'recent month is read from the small response cache');
    assert.equal(await page.$eval('#so-month', input => input.type), 'hidden', 'dashboard uses its styled month picker');
    await page.$eval('#so-month-trigger', button => { button.scrollIntoView({ block: 'center' }); button.click(); });
    const desktopPicker = await page.$eval('#so-month-popover', node => { const r = node.getBoundingClientRect(); return { hidden: node.hidden, expanded: document.getElementById('so-month-trigger').getAttribute('aria-expanded'), hostHidden: document.getElementById('dash-sales-overview').hidden, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert(!desktopPicker.hidden && desktopPicker.left >= 12 && desktopPicker.right <= desktopPicker.width - 12 && desktopPicker.top >= 0 && desktopPicker.bottom <= desktopPicker.height, `desktop picker ${JSON.stringify(desktopPicker)}`);
    assert.equal(await page.$$eval('#so-month-popover [data-month]', nodes => nodes.length), 12);
    assert.equal(await page.$eval('#so-month-popover [data-month="2025-12"]', node => node.getAttribute('aria-pressed')), 'true');
    await page.click('#so-month-popover [data-year-step="1"]');
    assert.equal(await page.$eval('#so-month-popover .so-month-head strong', node => node.textContent), '2026');
    assert.equal(await page.$eval('#so-month-popover [data-month="2026-12"]', node => node.disabled), true, 'future month is disabled');
    await page.click('#so-month-popover [data-month="2026-02"]');
    await page.waitForFunction(() => document.getElementById('so-month').value === '2026-02');
    assert.match(await page.evaluate(() => overviewCalls.at(-1)), /year=2026&month=2$/);
    const requestsBeforeCompare = await page.evaluate(() => overviewCalls.length);
    await page.$eval('#so-compare-toggle', button => button.click());
    await page.waitForFunction(() => document.querySelectorAll('#so-metrics .so-metric-compare').length === 4);
    assert.equal(await page.evaluate(() => overviewCalls.length), requestsBeforeCompare, 'comparison reuses the cached previous month');
    assert.equal(await page.$$eval('#so-legend span', nodes => nodes.length), 2);
    assert.equal(await page.$$eval('#so-chart-canvas .so-point:not(.is-compare)', nodes => nodes.length), 28);
    assert.equal(await page.$$eval('#so-chart-canvas .so-point.is-compare', nodes => nodes.length), 31);
    assert.equal(await page.$eval('#so-legend [data-series-toggle="0"]', node => node.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.$eval('#so-chart-style [data-chart-style="line"]', node => node.getAttribute('aria-pressed')), 'true');
    await page.$eval('#so-chart-style [data-chart-style="area"]', button => button.click());
    assert.equal(await page.$$eval('#so-chart-canvas .so-area', nodes => nodes.length), 1, 'area style fills the primary series');
    await page.$eval('#so-chart-style [data-chart-style="line"]', button => button.click());
    assert.equal(await page.$$eval('#so-chart-canvas .so-area', nodes => nodes.length), 0, 'line style removes the fill');
    await page.$eval('#so-legend [data-series-toggle="1"]', button => button.click());
    assert.equal(await page.$eval('#so-chart-canvas .so-series[data-series="1"]', node => getComputedStyle(node).display), 'none');
    await page.$eval('#so-chart-canvas .so-point[data-series="0"][data-day="0"]', point => point.focus());
    assert.equal(await page.$eval('#so-tip', tip => tip.textContent.includes('January 2026')), false, 'hidden series leaves the hover readout');
    await page.$eval('#so-legend [data-series-toggle="0"]', button => button.click());
    assert.equal(await page.$eval('#so-legend [data-series-toggle="0"]', node => node.getAttribute('aria-pressed')), 'true', 'last visible series cannot be hidden');
    await page.$eval('#so-legend [data-series-toggle="1"]', button => button.click());
    await page.$eval('#so-legend [data-series-toggle="0"]', button => button.click());
    assert.equal(await page.$eval('#so-chart-canvas .so-series[data-series="0"]', node => getComputedStyle(node).display), 'none');
    await page.$eval('#so-chart-canvas .so-point.is-compare[data-day="0"]', point => point.focus());
    assert.equal(await page.$eval('#so-tip', tip => tip.textContent.includes('February 2026')), false, 'primary series leaves the hover readout when hidden');
    await page.$eval('#so-legend [data-series-toggle="0"]', button => button.click());
    assert.equal(await page.$eval('#dash-sales-overview', node => getComputedStyle(node).getPropertyValue('--so-compare').trim()), '#4969c8');
    await page.evaluate(() => toggleDarkMode());
    assert.equal(await page.$eval('#dash-sales-overview', node => getComputedStyle(node).getPropertyValue('--so-compare').trim()), '#a5b3ff', 'dark theme recolors the comparison');
    assert.equal(await page.$eval('#so-tip', node => node.style.getPropertyValue('--so-compare').trim()), '#a5b3ff', 'dark theme recolors the tooltip');
    if (process.env.SALES_COMPARE_DARK_SHOT) {
      await page.setViewport({ width: 1440, height: 900 });
      await page.$eval('#dash-sales-overview', section => section.scrollIntoView({ block: 'start' }));
      await new Promise(resolve => setTimeout(resolve, 850));
      await page.screenshot({ path: process.env.SALES_COMPARE_DARK_SHOT });
      await page.setViewport({ width: 800, height: 600 });
      await new Promise(resolve => setTimeout(resolve, 160));
    }
    await page.evaluate(() => toggleDarkMode());
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => { document.querySelector('#so-chart-canvas svg').classList.add('is-animating'); });
    assert.equal(await page.$eval('#so-chart-canvas .so-series', node => getComputedStyle(node).animationName), 'none', 'reduced motion disables the reveal');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    assert.equal(await page.$eval('#so-chart-canvas .so-series', node => getComputedStyle(node).animationName), 'so-series-reveal');
    const hoverTarget = await page.$eval('#so-chart-canvas svg', svg => {
      svg.scrollIntoView({ block: 'center' });
      const point = svg.querySelector('.so-point[data-series="0"][data-day="10"]');
      const rect = svg.getBoundingClientRect(), scale = rect.width / svg.viewBox.baseVal.width;
      return { x: rect.left + Number(point.getAttribute('cx')) * scale + 6, y: rect.top + 150 * scale };
    });
    await page.mouse.move(hoverTarget.x, hoverTarget.y);
    assert(await page.$eval('#so-tip', tip => !tip.hidden && tip.textContent.includes('February 2026')), 'hovering between points reads the nearest day');
    assert.equal(await page.$eval('#so-chart-canvas .so-hover-line', node => node.hidden), false, 'hover guide follows the day');
    assert.equal(await page.$eval('#so-metrics .so-metric-value', node => node.textContent.trim()), '28');
    assert(await page.$eval('#so-metrics .so-delta', node => node.textContent.includes('3')), 'metric shows the difference');
    await page.$eval('#so-chart-canvas .so-point.is-compare[data-day="28"]', point => point.focus());
    assert(await page.$eval('#so-tip', node => !node.hidden && node.textContent.includes('January 2026') && node.textContent.includes('February 2026')));
    if (process.env.SALES_COMPARE_SHOT) {
      await page.setViewport({ width: 1440, height: 900 });
      await page.$eval('#dash-sales-overview', section => section.scrollIntoView({ block: 'start' }));
      await new Promise(resolve => setTimeout(resolve, 850));
      await page.screenshot({ path: process.env.SALES_COMPARE_SHOT });
    }
    await page.$eval('#so-compare-trigger', button => { button.scrollIntoView({ block: 'center' }); button.click(); });
    await page.click('#so-month-popover [data-year-step="-1"]');
    await page.click('#so-month-popover [data-month="2025-12"]');
    await page.waitForFunction(() => document.getElementById('so-compare-label').textContent.includes('December 2025'));
    assert.equal(await page.evaluate(() => overviewCalls.length), requestsBeforeCompare, 'a cached comparison month needs no request');
    await page.setViewport({ width: 390, height: 900 });
    await new Promise(resolve => setTimeout(resolve, 160));
    await page.$eval('#so-chart-canvas .so-point.is-compare[data-day="28"]', point => point.focus());
    const tooltipPosition = await page.$eval('#so-tip', tip => {
      const tipRect = tip.getBoundingClientRect(), viewport = document.getElementById('so-chart-scroll').getBoundingClientRect();
      const style = getComputedStyle(tip);
      return { hidden: tip.hidden, left: tipRect.left, right: tipRect.right, top: tipRect.top, bottom: tipRect.bottom, display: style.display, visibility: style.visibility, opacity: style.opacity, zIndex: style.zIndex, background: style.backgroundColor, viewportLeft: viewport.left, viewportRight: viewport.right, scrollLeft: document.getElementById('so-chart-scroll').scrollLeft };
    });
    if (process.env.SALES_COMPARE_MOBILE_SHOT) await page.screenshot({ path: process.env.SALES_COMPARE_MOBILE_SHOT });
    assert(!tooltipPosition.hidden && tooltipPosition.left >= 12 && tooltipPosition.right <= 390 - 12, `comparison tooltip fits the mobile viewport: ${JSON.stringify(tooltipPosition)}`);
    await page.setViewport({ width: 800, height: 600 });
    await new Promise(resolve => setTimeout(resolve, 160));
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; salesOverview.render(); });
    assert.equal(await page.$eval('#so-compare-toggle', button => button.textContent), 'إغلاق المقارنة');
    assert.equal(await page.$$eval('#so-legend span', nodes => nodes.length), 2, 'Arabic comparison keeps both series');
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; salesOverview.render(); });
    await page.$eval('#so-compare-toggle', button => button.click());
    assert.equal(await page.$$eval('#so-metrics .so-metric-compare', nodes => nodes.length), 0, 'closing comparison restores the simple view');
    await page.$eval('#so-month-trigger', button => { button.scrollIntoView({ block: 'center' }); button.click(); });
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.getElementById('so-month-popover').hidden && document.activeElement.id === 'so-month-trigger'));
    await page.setViewport({ width: 390, height: 900 });
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.$eval('#so-month-trigger', button => button.click());
    const mobilePicker = await page.$eval('#so-month-popover', node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert(mobilePicker.left >= 12 && mobilePicker.right <= mobilePicker.width - 12 && mobilePicker.top >= 0 && mobilePicker.bottom <= mobilePicker.height, `mobile month picker stays within the viewport: ${JSON.stringify(mobilePicker)}`);
    if (process.env.SALES_OVERVIEW_SHOT) { await new Promise(resolve => setTimeout(resolve, 180)); await page.screenshot({ path: process.env.SALES_OVERVIEW_SHOT }); }
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; salesOverview.render(); });
    await page.keyboard.press('Escape');
    await page.$eval('#so-month-trigger', button => button.click());
    assert.equal(await page.$eval('#so-month-popover', node => node.dir), 'rtl');
    await page.setViewport({ width: 320, height: 800 });
    await page.waitForFunction(() => { const r = document.getElementById('so-month-popover').getBoundingClientRect(); return r.left >= 12 && r.right <= innerWidth - 12 && r.top >= 0 && r.bottom <= innerHeight; }, { timeout: 1500 });
    await page.keyboard.press('Escape');
    assert(await page.$eval('#so-chart-scroll', node => node.scrollWidth > node.clientWidth));
    assert.equal(await page.$eval('#so-metrics', node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
    await page.evaluate(async () => { operationalRows = []; await refreshPageData('dashboard'); });
    assert.equal(await page.$eval('#dash-tab-count-issues', node => node.textContent), '0', 'dashboard refresh updates shipping issues');
    assert.equal(await page.$eval('#dash-attn-section', node => getComputedStyle(node).display), 'none', 'resolved issues leave attention');
    assert(await page.evaluate(() => operationalCalls.some(url => url.startsWith('/transactions/startup-overview'))), 'refresh uses the bounded operational source');
    await page.evaluate(() => {
      currentUser = { _id: 'staff', role: 'staff', perms: ['dashboard'] };
      renderDashWelcome(false); salesOverview.hide();
    });
    assert.equal(await page.$eval('#dash-sales-overview', node => getComputedStyle(node).display), 'none');
    assert.deepEqual(errors, []);
    console.log('PASS dashboard: chart and comparison, shipping without date strip or hidden filter, operational refresh, Arabic/English, mobile tooltip.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
