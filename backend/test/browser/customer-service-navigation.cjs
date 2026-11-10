/* Real route/disclosure behavior with isolated page data; no live writes. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), pub = path.join(root, 'frontend/public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const out = path.join(root, 'artifacts/customer-service-navigation');
fs.mkdirSync(out, { recursive: true });
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(7000);
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
      if (['/navigation-shell.js','/navigation-history.js','/workspace-tabs.js','/order-status.js','/designme/date-range-picker/soulia-range.js'].includes(url.pathname) || url.pathname.endsWith('.css') || url.pathname === '/soulia-logo.svg') {
        const file = path.resolve(pub, '.' + url.pathname);
        if (file.startsWith(pub + path.sep) && fs.existsSync(file)) return request.respond({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'navigation-admin', name: 'Navigation review', role: 'admin', perms: [] };
      document.querySelector('#app').style.display = '';
      document.querySelector('#login-page').style.display = 'none';
      document.querySelector('#splash-screen')?.remove();
      _transactionSummariesComplete = true;
      window.entries = []; window.loads = [];
      api = async () => [];
      loadComplaints = async () => { loads.push('complaints'); renderComplaints(); };
      loadFollowUps = async () => { loads.push('followups'); renderFollowUps(); };
      const originalEnter = onPageEnter;
      onPageEnter = page => {
        entries.push(page);
        if (['complaints','followups'].includes(page)) originalEnter(page);
        else if (page === 'reports') {
          const tab = location.hash.slice(1).split('/')[1] || _firstAllowedReportTab();
          switchReportTab(tab, document.querySelector(`[data-rep-tab="${tab}"]`), true);
          buildSidebar();
        }
      };
    });
    for (const language of ['en', 'ar']) {
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluate(language => {
        currentLang = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
        document.documentElement.lang = language;
        navigateTo('dashboard'); buildSidebar(); initMobileNav();
        entries.length = 0; loads.length = 0;
      }, language);
      const before = await page.evaluate(() => ({ url: location.href, entries: entries.length }));
      await page.click('#sidebar .nav-parent[data-page="complaints"]');
      assert.deepEqual(await page.evaluate(() => ({ url: location.href, entries: entries.length })), before, 'opening Customer Service never navigates');
      assert.equal(await page.evaluate(() => loads.length), 0);
      assert.equal(await page.$eval('#nav-sub-complaints', element => element.classList.contains('is-open')), true);
      assert.equal(await page.$$eval('#nav-sub-complaints a svg', icons => icons.length), 2);
      assert(await page.$eval('#nav-sub-complaints', element => element.parentElement === document.querySelector('#sidebar [data-page="complaints"]').parentElement));
      await page.click('[data-cs-sub="followups"]');
      await page.waitForFunction(() => currentPage === 'followups' && location.hash === '#followups');
      assert.equal(await page.$eval('#complaints-section-title', element => element.textContent), language === 'ar' ? 'متابعة الطلبات' : 'Order Follow-ups');
      assert.equal(await page.$eval('#fu-orders-section', element => element.style.display), 'block');
      assert.equal(await page.$eval('#cmp-complaints-section', element => element.style.display), 'none');
      assert.equal(await page.$eval('.cs-main-tabs', element => getComputedStyle(element).display), 'none');
      assert.deepEqual(await page.evaluate(() => loads), ['followups'], 'follow-ups load their own page data only');
      assert((await page.$eval('#shell-breadcrumb', element => element.textContent)).includes(language === 'ar' ? 'خدمة العملاء' : 'Customer Service'));
      await page.click('[data-cs-sub="complaints"]');
      await page.waitForFunction(() => currentPage === 'complaints' && location.hash === '#complaints');
      assert.equal(await page.$eval('#shell-breadcrumb [aria-current=page]', element => element.textContent), language === 'ar' ? 'الشكاوى' : 'Complaints');
      assert.equal(await page.$eval('#complaints-section-title', element => element.textContent), language === 'ar' ? 'الشكاوى' : 'Complaints');
      assert.equal(await page.$eval('#fu-orders-section', element => element.style.display), 'none');
      assert.equal(await page.$eval('#cmp-complaints-section', element => element.style.display), 'block');
      await page.goBack(); await page.waitForFunction(() => currentPage === 'followups');
      await page.goForward(); await page.waitForFunction(() => currentPage === 'complaints');
      await page.click('#sidebar .nav-parent[data-page="complaints"]');
      await page.evaluate(() => buildSidebar());
      assert.equal(await page.$eval('#sidebar [data-page="complaints"]', element => element.getAttribute('aria-expanded')), 'false', 'badge redraws retain an explicitly collapsed group');
      const reportBefore = await page.evaluate(() => ({ url: location.href, entries: entries.length, loads: loads.length }));
      await page.click('#sidebar .nav-parent[data-page="reports"]');
      assert.deepEqual(await page.evaluate(() => ({ url: location.href, entries: entries.length, loads: loads.length })), reportBefore, 'opening Reports never chooses the default report');
      assert.equal(await page.$$eval('#nav-sub-reports a svg', icons => icons.length), 6);
      await page.click('[data-rep-sub="shipping"]');
      await page.waitForFunction(() => currentPage === 'reports' && location.hash === '#reports/shipping' && activeReportTab === 'shipping');
      await page.click('#sidebar .nav-parent[data-page="reports"]');
      await page.evaluate(() => buildSidebar());
      assert.equal(await page.$eval('#sidebar [data-page="reports"]', element => element.getAttribute('aria-expanded')), 'false');
      await page.focus('#sidebar .nav-parent[data-page="reports"]'); await page.keyboard.press('Space');
      assert.equal(await page.$eval('#sidebar [data-page="reports"]', element => element.getAttribute('aria-expanded')), 'true');
      await page.screenshot({ path: path.join(out, `reports-${language}-1440.png`) });
      await page.evaluate(() => navigateTo('followups'));
      await page.screenshot({ path: path.join(out, `followups-${language}-1440.png`) });
      await page.setViewport({ width: 390, height: 844 });
      await page.evaluate(() => { navigateTo('dashboard'); setupMobileNavFab(); });
      const mobileBefore = await page.evaluate(() => location.href);
      await page.click('#mnav-fab');
      assert.equal(await page.evaluate(() => location.href), mobileBefore);
      assert(await page.$eval('#sidebar', element => element.classList.contains('open')));
      await page.screenshot({ path: path.join(out, `customer-service-${language}-390.png`) });
      await page.click('[data-cs-sub="complaints"]');
      await page.waitForFunction(() => currentPage === 'complaints');
      assert.equal(await page.$eval('#sidebar', element => element.classList.contains('open')), false, 'mobile drawer closes after choosing a child');
    }
    await page.evaluate(() => {
      currentUser = { _id: 'limited', role: 'staff', perms: ['reports','reports-shipping'] };
      buildSidebar();
    });
    assert.equal(await page.$('#nav-sub-complaints'), null);
    assert.deepEqual(await page.$$eval('#nav-sub-reports a', links => links.map(link => link.dataset.repSub)), ['shipping']);
    const deniedBefore = await page.evaluate(() => currentPage);
    await page.evaluate(() => handleCustomerServiceNavClick({ preventDefault() {} }));
    assert.equal(await page.evaluate(() => currentPage), deniedBefore);
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('PASS: parent disclosures do not navigate, independent service routes and data, correct breadcrumbs, report selection, keyboard, Back/Forward, mobile drawer, icons and permissions in Arabic/English.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
