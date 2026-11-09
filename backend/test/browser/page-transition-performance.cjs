/* Measures the page shell with route data work held constant. Run with --baseline before editing CSS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const baseline = process.argv.includes('--baseline');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const networkPaths = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const local = path.join(publicDir, url.pathname.slice(1));
      if (url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname.startsWith('/api/')) {
        networkPaths.push(url.pathname);
        return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if ((url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) && fs.existsSync(local)) {
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(local) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, body: '' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(() => {
      currentUser = { _id: 'transition-admin', name: 'Admin', role: 'admin', perms: [] };
      currentPage = 'dashboard';
      localStorage.setItem('token', 'transition-test');
      document.getElementById('app').style.display = '';
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('splash-screen')?.remove();
      document.querySelectorAll('#main > .page').forEach(node => node.classList.toggle('active', node.id === 'page-dashboard'));
      const sidebar = document.getElementById('sidebar'), header = document.getElementById('header');
      const pageNodes = [...document.querySelectorAll('#main > .page')];
      const entered = [];
      onPageEnter = route => entered.push({ route, at: performance.now() });
      const routes = ['categories', 'dashboard', 'csp', 'users'];
      const durations = [];
      let timers = 0;
      const originalSetTimeout = window.setTimeout;
      window.setTimeout = (...args) => { timers++; return originalSetTimeout(...args); };
      try {
        for (let index = 0; index < 40; index++) {
          const route = routes[index % routes.length];
          const started = performance.now();
          navigateTo(route, false);
          durations.push(performance.now() - started);
          if (currentPage !== route || entered.at(-1)?.route !== route ||
              !document.querySelector(`#page-${route}`)?.classList.contains('active')) {
            throw new Error(`${route}: navigation or route work was delayed`);
          }
          if (document.getElementById('sidebar') !== sidebar || document.getElementById('header') !== header ||
              [...document.querySelectorAll('#main > .page')].some((node, position) => node !== pageNodes[position])) {
            throw new Error('The persistent shell or page nodes were remounted');
          }
        }
      } finally {
        window.setTimeout = originalSetTimeout;
      }
      durations.sort((a, b) => a - b);
      const active = document.querySelector('#main > .page.active');
      const nested = document.createElement('div');
      nested.className = 'page';
      active.append(nested);
      const nestedAnimation = getComputedStyle(nested).animationName;
      nested.remove();
      return {
        medianNavigationMs: Number(durations[20].toFixed(2)),
        p95NavigationMs: Number(durations[38].toFixed(2)),
        timerCalls: timers,
        animationName: getComputedStyle(active).animationName,
        animationMs: parseFloat(getComputedStyle(active).animationDuration) * 1000,
        pageTransform: getComputedStyle(active).transform,
        nestedAnimation,
        headerAnimation: getComputedStyle(header).animationName,
        sidebarAnimation: getComputedStyle(sidebar).animationName,
        pageCount: pageNodes.length,
      };
    });
    assert.equal(result.animationName, 'uiPageReveal');
    if (!baseline) {
      assert(result.animationMs >= 120 && result.animationMs <= 180, 'page entrance stays within 120–180ms');
      assert.equal(result.nestedAnimation, 'none', 'nested content is not given a second page entrance');
    }
    assert.equal(result.pageTransform, 'none', 'the page never creates a fixed-position containing block');
    assert.equal(result.headerAnimation, 'none');
    assert.equal(result.sidebarAnimation, 'none');
    assert.equal(result.timerCalls, 41, 'navigation uses the same number of timers as the baseline');
    assert(networkPaths.every(route => ['/api/branding', '/api/drafts', '/api/warehouses'].includes(route)), 'page transitions add no API requests');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const reducedMs = await page.$eval('#main > .page.active', node => parseFloat(getComputedStyle(node).animationDuration) * 1000);
    assert(reducedMs < 1, 'reduced motion removes the visible transition');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode: baseline ? 'baseline' : 'optimized', ...result, networkPaths, reducedMs }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
