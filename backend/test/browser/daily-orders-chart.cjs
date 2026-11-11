/* Isolated chart QA: production markup, styles and scripts; deterministic API buckets. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const pub = path.resolve(__dirname, '../../../frontend/public');
const source = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const section = source.match(/<section id="dash-sales-overview"[\s\S]*?<\/section>/)[0];
const styles = [...source.slice(0, source.indexOf('</head>')).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
const out = path.resolve(__dirname, '../../../artifacts/daily-orders');
const fixture = (key, orders) => ({ month: key, totalOrders: orders.reduce((s, n) => s + (n || 0), 0),
  totalRevenue: orders.reduce((s, n) => s + (n || 0) * 100, 0), confirmedOrders: 10, averageOrderValue: 100,
  today: key === '2026-11' ? '2026-11-11' : null,
  days: orders.map((n, i) => ({ date: `${key}-${String(i + 1).padStart(2, '0')}`, orders: n, revenue: 0,
    receivedValue: n * 100, confirmedValue: Math.floor(n / 2) * 100, confirmedOrders: Math.floor(n / 2) })) });
const current = [6, 10, 9, 17, 42, 13, 8, 15, 12, 9, 19, 14, 6, 9, 9, 11, 9, 13, 16, 9, 12, 10, 14, 7, 15, 13, 10, 10, 13, 8, 9];
const previous = [9, 4, 4, 7, 1, 7, 6, 6, 1, 3, 3, 3, 4, 6, 1, 3, 5, 3, 2, 5, 8, 7, 8, 7, 12, 3, 8, 13, 7, 8];
const data = {
  '2026-11': fixture('2026-11', [...Array(10).fill(10), 0, ...Array(19).fill(9999)]),
  '2026-10': { ...fixture('2026-10', current), averageOrderValue: 90 }, '2026-09': fixture('2026-09', previous),
  '2026-08': fixture('2026-08', Array(31).fill(8)), '2026-07': fixture('2026-07', Array(31).fill(12)),
  '2026-02': fixture('2026-02', Array(28).fill(0)), '2026-01': fixture('2026-01', Array(31).fill(10)),
  '2024-02': fixture('2024-02', Array(29).fill(7)), '2024-01': fixture('2024-01', Array(31).fill(5)),
  '2026-04': fixture('2026-04', Array(30).fill(10)), '2026-03': fixture('2026-03', Array(31).fill(5)),
  '2000-01': fixture('2000-01', Array(31).fill(0)),
};
async function selectMonth(page, key) {
  await page.$eval('#so-month', (input, month) => { input.value = month; input.dispatchEvent(new Event('change', { bubbles: true })); }, key);
  await page.waitForFunction(month => !document.getElementById('dash-sales-overview').classList.contains('is-loading') && document.getElementById('so-title').textContent.includes(month), {}, new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${key}-01T12:00:00Z`)));
}
async function selectComparisonMonth(page, key) {
  await page.$eval('#so-compare-trigger', button => button.click());
  await page.evaluate(() => { while (document.querySelector('[data-remove-month]')) document.querySelector('[data-remove-month]').click(); });
  await page.$eval(`#so-month-popover [data-month="${key}"]`, button => button.click());
  await page.$eval('#so-apply-months', button => button.click());
  await page.waitForFunction(() => !document.getElementById('dash-sales-overview').classList.contains('is-loading'));
}
async function tipFor(page, selector) {
  await page.$eval(selector, node => { node.blur(); node.focus(); });
  await page.waitForFunction(() => !document.getElementById('so-tip').hidden, { timeout: 3000 }).catch(async error => {
    console.error('Tooltip focus state', await page.evaluate(() => ({ width: innerWidth, active: document.activeElement.tagName,
      tip: document.getElementById('so-tip').outerHTML, point: document.querySelector('.is-active')?.outerHTML,
      scroll: document.getElementById('so-chart-scroll').scrollLeft })));
    throw error;
  });
  return page.$eval('#so-tip', tip => tip.textContent);
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Daily orders QA</title>' }));
    await page.goto('http://daily-orders.test/');
    await page.setContent(`<!doctype html><html lang="en" dir="ltr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><style>${fs.readFileSync(path.join(pub, 'dashboard-clarity.css'), 'utf8')}</style><style>${fs.readFileSync(path.join(pub, 'sales-overview.css'), 'utf8')}</style><style>body{display:block!important;overflow:auto!important;background:var(--bg,#f5f6f7);padding:24px;margin:0}#main{margin:0!important;padding:0!important;display:block!important;width:100%}#page-dashboard{padding:0!important;display:block!important}*{box-sizing:border-box}@media(max-width:650px){body{padding:10px}}</style></head><body><main id="main"><div id="page-dashboard" class="dashboard-v2">${section}</div></main></body></html>`);
    await page.evaluate(fixtures => {
      const OriginalDate = Date;
      window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-11-11T10:00:00Z'])); } static now() { return new OriginalDate('2026-11-11T10:00:00Z').getTime(); } };
      window.currentLang = 'en'; window.isAdmin = () => true; window._apiWriteRevision = 0;
      window.fixtures = fixtures; window.calls = []; window.failMonth = ''; window.waitMonth = '';
      localStorage.setItem('token', 'chart-test');
      window.api = async url => {
        calls.push(url);
        const params = new URLSearchParams(url.split('?')[1]);
        const key = `${params.get('year')}-${params.get('month').padStart(2, '0')}`;
        if (key === failMonth) throw new Error('Fixture API error');
        if (key === waitMonth) await new Promise(resolve => { window.releaseMonth = resolve; });
        return structuredClone(fixtures[key] || { month: key, days: [], totalOrders: 0 });
      };
    }, data);
    await page.addScriptTag({ path: path.join(pub, 'daily-orders-analysis.js') });
    await page.addScriptTag({ path: path.join(pub, 'sales-overview.js') });
    await page.evaluate(() => salesOverview.load());
    assert.equal(await page.evaluate(() => calls.length), 1, 'the default view only requests the selected month');
    assert.equal(await page.$$eval('.so-series', nodes => nodes.length), 1);
    assert.equal(await page.$eval('#so-legend', node => node.hidden), true);
    assert.equal(await page.$$eval('.so-metric-compare', nodes => nodes.length), 0);
    assert.equal(await page.$eval('#so-chart-note', node => node.textContent), 'Daily Shopify orders for the selected month');
    assert.equal(await page.$$eval('.so-day-label', nodes => nodes.length), 31);
    assert.equal(await page.$$eval('.so-point:not(.is-compare)', nodes => nodes.length), 11, 'future dates are not plotted');
    assert.equal(await page.$$eval('.so-area', nodes => nodes.length), 1, 'the chart opens with a faded area');
    assert.equal(await page.$$eval('.so-annotation.is-low, .so-point.is-low', nodes => nodes.length), 0, 'today has no Low label at the start of the day');
    assert.equal(await page.$eval('#so-area-fade stop:last-child', node => node.getAttribute('stop-opacity')), '0', 'area fades to transparent at the baseline');
    assert.equal(await page.$eval('#so-insight', node => node.hidden), true, 'insufficient completed history has no insight');
    assert.match(await tipFor(page, '.so-point[data-series="0"][data-day="10"]'), /We · November 11, 2026/);
    assert.match(await page.$eval('#so-tip', node => node.textContent), /in progress/);
    assert.equal(await page.$$eval('#so-tip .so-tip-series', nodes => nodes.length), 1, 'default tooltip contains one month');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(out, 'single-month-default.png'), fullPage: true });
    // Closing comparison while its month is loading must also cancel its visible state.
    await page.evaluate(() => { waitMonth = '2026-10'; });
    await page.$eval('#so-compare-toggle', button => button.click());
    await page.waitForFunction(() => typeof releaseMonth === 'function');
    await page.$eval('#so-compare-toggle', button => button.click());
    await page.evaluate(async () => { waitMonth = ''; releaseMonth(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.$$eval('.so-series', nodes => nodes.length), 1, 'a late comparison response does not re-enable comparison');
    assert.equal(await page.$eval('#dash-sales-overview', node => node.classList.contains('is-loading')), false);
    await page.$eval('#so-compare-toggle', button => button.click());
    await page.waitForFunction(() => document.querySelectorAll('.so-series').length === 2 && document.querySelectorAll('.so-metric-compare').length === 4);
    assert.equal(await page.evaluate(() => calls.length), 2, 'opening comparison requests its month once and reuses it');
    const octoberColour = await page.$eval('.so-series[data-series="1"] .so-line', node => getComputedStyle(node).stroke);
    await selectMonth(page, '2026-10');
    assert.equal(await page.$eval('.so-series[data-series="0"] .so-line', node => getComputedStyle(node).stroke), octoberColour, 'a month keeps its colour when promoted to the primary series');
    assert.equal(await page.evaluate(() => calls.length), 3, 'navigation reuses the prior monthly response');
    assert.equal(await page.$$eval('#so-metrics .so-metric', nodes => nodes.length), 4, 'no additional KPI cards');
    assert.equal(await page.$$eval('.so-annotation', nodes => nodes.length), 1);
    assert.match(await page.$eval('.so-annotation.is-peak', node => node.textContent), /Oct 5.*42/);
    assert.equal(await page.$$eval('.so-annotation.is-low, .so-point.is-low', nodes => nodes.length), 0, 'completed months have no Low annotation either');
    assert.equal(await page.$$eval('.so-hotspot-ring', nodes => nodes.length), 1);
    assert.match(await page.$eval('#so-insight', node => node.textContent), /comparable completed days/);
    assert.equal(await page.$$eval('#so-insight span', nodes => nodes.length), 1);
    if (process.env.DAILY_ORDERS_INSPECT) {
      const snapshot = await page.content();
      const setup = `<script>window.currentLang='en';window.isAdmin=()=>true;window.fixtures=${JSON.stringify(data)};window.api=async url=>{const p=new URLSearchParams(url.split('?')[1]);return fixtures[p.get('year')+'-'+p.get('month').padStart(2,'0')]};</script>`;
      const start = `<script>salesOverview.load().then(()=>{const input=document.getElementById('so-month');input.value='2026-10';input.dispatchEvent(new Event('change',{bubbles:true}))});</script>`;
      fs.writeFileSync(path.join(out, 'inspection.html'), snapshot.replace('</head>', `${setup}</head>`).replace('</body>', `${start}</body>`));
    }
    const text = await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
    assert.match(text, /Mo · October 5, 2026/);
    assert.match(text, /Revenue: EGP 4,200/);
    assert.match(text, /Confirmed value: EGP 2,100/);
    assert.equal(await page.$$eval('.so-weekday-label', nodes => nodes.length), 31);
    assert.equal(await page.$eval('.so-weekday-label', node => node.textContent), 'Th');
    assert(await page.$$eval('.so-line.is-up', nodes => nodes.length > 0));
    assert(await page.$$eval('.so-line.is-down', nodes => nodes.length > 0));
    assert(await page.evaluate(() => getComputedStyle(document.querySelector('.so-line.is-up')).stroke === getComputedStyle(document.querySelector('.so-line.is-down')).stroke), 'daily changes do not change the month colour');
    assert.match(text, /42 orders/); assert.match(text, /September 2026: 1 order/);
    assert.match(text, /\+41 orders/); assert.match(text, /\+4,100%/);
    const requests = await page.evaluate(() => calls.length);
    await page.evaluate(() => { window.paintedMetric = document.querySelector('.so-metric-value'); });
    await page.$eval('[data-chart-style="area"]', button => button.click());
    assert.equal(await page.$$eval('.so-area', nodes => nodes.length), 1);
    assert(await page.evaluate(() => paintedMetric === document.querySelector('.so-metric-value')), 'chart controls do not recreate metrics');
    await page.$eval('[data-chart-style="line"]', button => button.click());
    assert.equal(await page.$$eval('.so-area', nodes => nodes.length), 0);
    await page.$eval('[data-series-toggle="1"]', button => button.click());
    await page.$eval('[data-series-toggle="1"]', button => button.focus());
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.seriesToggle), '1', 'keyboard series toggle keeps focus');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('.so-series.is-compare', node => getComputedStyle(node).display), 'none');
    assert(!(await tipFor(page, '.so-point[data-series="0"][data-day="4"]')).includes('September'));
    await page.$eval('[data-series-toggle="1"]', button => button.click());
    await page.waitForFunction(() => document.querySelectorAll('.so-metric-compare').length === 4);
    assert.equal(await page.$eval('.so-delta.is-up', node => getComputedStyle(node).color), 'rgb(24, 131, 75)', 'increasing numbers use green');
    assert(await page.$eval('.so-delta.is-down', node => {
      const panel = document.getElementById('dash-sales-overview');
      const probe = document.createElement('span'); probe.style.color = 'var(--ds-text-2)'; panel.append(probe);
      const neutral = getComputedStyle(probe).color; probe.remove();
      return node.textContent.includes('−') && getComputedStyle(node).color === neutral;
    }), 'decreases keep their minus sign and use a neutral colour');
    await page.evaluate(() => document.body.classList.add('dark-mode'));
    assert.equal(await page.$eval('.so-delta.is-up', node => getComputedStyle(node).color), 'rgb(117, 219, 164)', 'increases remain green in dark mode');
    await page.evaluate(() => document.body.classList.remove('dark-mode'));
    await page.$eval('[data-chart-style="area"]', button => button.click());
    await page.screenshot({ path: path.join(out, 'fade-and-deltas.png'), fullPage: true });
    assert.equal(await page.evaluate(() => calls.length), requests, 'style and comparison toggles reuse cached data');
    await page.$eval('#so-compare-toggle', button => button.click());
    assert.equal(await page.$$eval('.so-metric-compare', nodes => nodes.length), 0);
    assert.equal(await page.$$eval('.so-series', nodes => nodes.length), 1, 'closing comparison removes all comparison curves');
    assert.equal(await page.$eval('#so-legend', node => node.hidden), true);
    assert(!/September|Difference/.test(await tipFor(page, '.so-point[data-series="0"][data-day="4"]')), 'closing comparison removes comparison tooltip data');
    await page.$eval('#so-compare-toggle', button => button.click());
    await page.$eval('#so-compare-trigger', button => button.click());
    const beforeSelection = await page.evaluate(() => calls.length);
    await page.$eval('[data-month="2026-08"]', button => button.click());
    await page.$eval('[data-month="2026-07"]', button => button.click());
    assert.equal(await page.evaluate(() => calls.length), beforeSelection, 'draft selections do not fetch data');
    assert.equal(await page.$$eval('.so-month-grid [aria-pressed="true"]', nodes => nodes.length), 3);
    await page.screenshot({ path: path.join(out, 'multi-month-picker.png'), fullPage: true });
    await page.$eval('#so-apply-months', button => button.click());
    await page.waitForFunction(() => document.querySelectorAll('.so-series').length === 4 && !document.getElementById('dash-sales-overview').classList.contains('is-loading'));
    assert.equal(await page.evaluate(() => calls.length), beforeSelection + 2, 'only newly selected months are requested');
    assert.equal(await page.$$eval('#so-legend [data-series-toggle]', nodes => nodes.length), 4);
    assert.equal(await page.$eval('#so-compare-label', node => node.textContent), '3 months');
    const multiTip = await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
    for (const name of ['October', 'September', 'August', 'July']) assert(multiTip.includes(name));
    assert.equal(await page.$$eval('#so-tip .so-tip-difference', nodes => nodes.length), 3);
    const assertMonthColours = async () => {
      const result = await page.evaluate(() => {
        const curves = [...document.querySelectorAll('.so-series')].map(group => getComputedStyle(group.querySelector('.so-line')).stroke);
        const names = [...document.querySelectorAll('.so-series-toggle')].map(button => getComputedStyle(button).color);
        const tooltipNames = [...document.querySelectorAll('#so-tip .so-tip-month')].map(node => getComputedStyle(node).color);
        const counts = [...document.querySelectorAll('#so-tip .so-tip-order-count')];
        return { curves, names, tooltipNames, countValues: counts.map(node => node.textContent),
          prominent: counts.every(node => parseFloat(getComputedStyle(node).fontSize) > parseFloat(getComputedStyle(node.closest('.so-tip-series').querySelector('small')).fontSize)) };
      });
      assert.equal(new Set(result.curves).size, 4, 'all four months have distinct colours');
      assert.deepEqual(result.names, result.curves, 'legend names match their curves');
      assert.equal(new Set(result.tooltipNames).size, 4, 'tooltip month names have distinct matching hues');
      assert.deepEqual(result.countValues, ['42', '1', '8', '12'], 'each highlighted number belongs to its own month');
      assert(result.prominent, 'order counts are larger than revenue details');
    };
    await assertMonthColours();
    await page.screenshot({ path: path.join(out, 'multi-month-highlighted-numbers.png'), fullPage: true });
    await page.evaluate(() => { document.body.classList.add('dark-mode'); salesOverview.render(); });
    await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
    await assertMonthColours();
    await page.screenshot({ path: path.join(out, 'multi-month-highlighted-numbers-dark.png'), fullPage: true });
    await page.evaluate(() => { document.body.classList.remove('dark-mode'); salesOverview.render(); });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(out, 'multi-month-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 900 });
    await new Promise(resolve => setTimeout(resolve, 170));
    await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
    assert(await page.$eval('#so-tip', tip => { const r = tip.getBoundingClientRect(); return r.left >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11; }));
    await page.screenshot({ path: path.join(out, 'multi-month-mobile-tooltip.png'), fullPage: true });
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.add('dark-mode'); salesOverview.render(); });
    await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
    await assertMonthColours();
    assert.equal(await page.$eval('#so-tip', tip => tip.style.direction), 'rtl');
    assert(await page.$eval('#so-tip', tip => { const r = tip.getBoundingClientRect(); return r.left >= 11 && r.right <= innerWidth - 11 && r.top >= 11 && r.bottom <= innerHeight - 11; }), 'Arabic month comparison fits the mobile viewport');
    await page.screenshot({ path: path.join(out, 'multi-month-ar-dark-mobile-tooltip.png'), fullPage: true });
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; document.body.classList.remove('dark-mode'); salesOverview.render(); });
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise(resolve => setTimeout(resolve, 170));
    for (const index of [0, 1, 2]) await page.$eval(`[data-series-toggle="${index}"]`, button => button.click());
    await page.$eval('[data-series-toggle="3"]', button => button.click());
    assert.equal(await page.$eval('[data-series-toggle="3"]', button => button.getAttribute('aria-pressed')), 'true', 'last visible month remains visible');
    assert((await tipFor(page, '.so-point[data-series="3"][data-day="4"]')).includes('July'));
    await page.$eval('#so-compare-toggle', button => button.click());
    await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.day), '5');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.day), '30');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#so-tip', node => node.hidden), true);
    const hover = await page.$eval('.so-point[data-series="0"][data-day="10"]', point => { const r = point.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; });
    await page.mouse.move(hover.x, hover.y);
    assert.match(await page.$eval('#so-tip', node => node.textContent), /October 11/);
    assert.notEqual(await page.$eval('.so-hover-line', node => getComputedStyle(node).display), 'none');
    await tipFor(page, '.so-point[data-series="0"][data-day="30"]');
    await page.evaluate(() => { window.paintedPlot = document.querySelector('.so-chart-svg'); });
    await page.setViewport({ width: 1440, height: 860 });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(await page.evaluate(() => paintedPlot === document.querySelector('.so-chart-svg')), 'height-only viewport changes do not recreate a fixed-size plot');
    assert.equal(await page.$eval('#so-tip', node => node.hidden), false, 'keyboard tooltip survives a height-only resize');
    await page.$eval('[data-chart-style="area"]', button => button.click());
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      await new Promise(resolve => setTimeout(resolve, 170));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}`);
      await page.$eval('#so-chart-scroll', node => { node.scrollLeft = 0; });
      await page.screenshot({ path: path.join(out, `chart-en-${width}.png`), fullPage: true });
      await tipFor(page, '.so-point[data-series="0"][data-day="30"]');
      assert(await page.$eval('#so-tip', tip => { const r = tip.getBoundingClientRect(); return r.left >= 11 && r.right <= innerWidth - 11 && r.top >= 11 && r.bottom <= innerHeight - 11; }), `tooltip fits at ${width}`);
    }
    await page.setViewport({ width: 390, height: 900 });
    const session = await page.createCDPSession();
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await new Promise(resolve => setTimeout(resolve, 170));
    await page.$eval('#so-chart-scroll', node => { node.scrollLeft = 0; });
    const target = await page.$eval('.so-day-target[data-day="3"]', node => { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 80 }; });
    await page.touchscreen.tap(target.x, target.y);
    assert(await page.$eval('#so-tip', node => !node.hidden && node.textContent.includes('October 4')));
    await page.touchscreen.tap(10, 10);
    assert.equal(await page.$eval('#so-tip', node => node.hidden), true);
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.add('dark-mode'); salesOverview.render(); });
      await new Promise(resolve => setTimeout(resolve, 170));
      assert.equal(await page.$$eval('.so-series', nodes => nodes.length), 1, 'Arabic simple view contains only the selected month');
      assert.equal(await page.$eval('#so-chart-note', node => node.textContent), 'طلبات Shopify اليومية للشهر المحدد');
      assert.match(await page.$eval('#so-insight', node => node.textContent), /رؤية ذكية/);
      assert.equal(await page.$$eval('.so-annotation.is-low, .so-point.is-low', nodes => nodes.length), 0, 'Arabic views have no lowest-day label');
      await page.screenshot({ path: path.join(out, `chart-ar-dark-${width}.png`), fullPage: true });
      await tipFor(page, '.so-point[data-series="0"][data-day="4"]');
      assert.equal(await page.$eval('#so-tip', node => node.style.direction), 'rtl');
    }
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; document.body.classList.remove('dark-mode'); salesOverview.render(); });
    await selectMonth(page, '2026-02');
    assert.equal(await page.$$eval('.so-point:not(.is-compare)', nodes => nodes.length), 28);
    assert.equal(await page.$$eval('.so-point.is-compare', nodes => nodes.length), 0, 'changing months keeps comparison off');
    await page.$eval('#so-compare-toggle', button => button.click());
    await selectComparisonMonth(page, '2026-01');
    const shortMonth = await tipFor(page, '.so-point.is-compare[data-day="30"]');
    assert.match(shortMonth, /No calendar date/);
    assert(!shortMonth.includes('%'), 'nonexistent corresponding day has no percentage');
    await selectMonth(page, '2024-02');
    assert.equal(await page.$$eval('.so-point:not(.is-compare)', nodes => nodes.length), 29);
    await selectMonth(page, '2026-04');
    assert.equal(await page.$$eval('.so-point:not(.is-compare)', nodes => nodes.length), 30);
    await page.waitForFunction(() => !document.getElementById('dash-sales-overview').classList.contains('is-loading'));
    await page.$eval('#so-compare-trigger', button => button.click());
    await page.evaluate(() => { while (document.querySelector('[data-remove-month]')) document.querySelector('[data-remove-month]').click(); });
    await page.$eval('#so-month-popover [data-month="2026-02"]', button => button.click());
    await page.$eval('#so-apply-months', button => button.click());
    await page.waitForFunction(() => document.querySelectorAll('.so-point.is-compare').length === 28);
    assert.match(await tipFor(page, '.so-day-target[data-day="30"]'), /No calendar date/);
    await selectComparisonMonth(page, '2026-03');
    await page.waitForFunction(() => document.querySelectorAll('.so-point.is-compare').length === 31);
    // Missing primary data must leave a gap in both the line and the area.
    await page.evaluate(() => { fixtures['2026-04'].days[9].orders = null; fixtures['2026-04'].days[4].orders = 0; fixtures['2026-03'].days[0].orders = 0; _apiWriteRevision++; });
    await page.evaluate(() => salesOverview.load({ force: true }));
    assert(await page.$$eval('.so-series[data-series="0"] .so-line', nodes => {
      const step = (nodes[0].ownerSVGElement.viewBox.baseVal.width - 64) / 30;
      return nodes.every(node => { const values = node.getAttribute('d').match(/[\d.]+/g).map(Number); return values.at(-2) - values[0] <= step + .01; });
    }), 'no directional segment bridges a missing day');
    assert.match(await tipFor(page, '.so-point.is-compare[data-day="9"]'), /No data/);
    assert.match(await tipFor(page, '.so-point[data-series="0"][data-day="4"]'), /0 orders/);
    assert.match(await tipFor(page, '.so-point[data-series="0"][data-day="0"]'), /N\/A.*previous count is zero/);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => salesOverview.render());
    assert.equal(await page.$eval('.so-series', node => getComputedStyle(node).animationName), 'none');
    // Comparison failures retain primary data without inventing a baseline.
    await page.evaluate(() => { failMonth = '2026-03'; _apiWriteRevision++; });
    await page.evaluate(() => salesOverview.load({ force: true }));
    assert.equal(await page.$$eval('.so-point:not(.is-compare)', nodes => nodes.length), 29);
    assert.equal(await page.$$eval('.so-point.is-compare', nodes => nodes.length), 0);
    assert.match(await tipFor(page, '.so-point[data-series="0"][data-day="0"]'), /Comparison unavailable/);
    await page.evaluate(() => { failMonth = ''; });
    await page.$eval('#so-compare-toggle', button => button.click());
    await selectMonth(page, '2000-01');
    assert.equal(await page.$eval('#so-insight', node => node.hidden), true);
    await tipFor(page, '.so-day-target[data-day="30"]');
    await page.evaluate(() => salesOverview.hide());
    assert.equal(await page.$('#so-tip'), null, 'hiding the dashboard removes the body tooltip');
    assert.deepEqual(errors, []);
    console.log('PASS daily orders: cached comparison, annotations, insights, keyboard, hover/tap, EN/AR, light/dark, 320–1440px, date gaps, zero baseline, partial API failure.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
