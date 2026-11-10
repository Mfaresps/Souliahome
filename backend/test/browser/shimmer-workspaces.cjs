/* Slow data keeps the real page frame visible with placeholders in its own slots. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const output = path.resolve(__dirname, '../../../artifacts/shimmer-workspaces');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file), contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : ext === '.html' ? 'text/html' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
        return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'load' });
    await page.evaluate(() => {
      currentUser = { _id: 'shimmer-admin', name: 'Admin', role: 'admin', perms: [] };
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      _transactionSummariesComplete = true;
      window.holdReads = new Map();
      api = url => new Promise(resolve => { const key = url.split('?')[0]; holdReads.set(key, resolve); });
      window.showWorkspace = name => {
        currentPage = name;
        qsa('#main > .page').forEach(el => el.classList.toggle('active', el.id === 'page-' + (name === 'followups' ? 'complaints' : name)));
      };
      onPageEnter = name => { if (name === 'products') renderProducts(); else if (name === 'transaction') initTxPage(); };
      window.prepareResource = () => {
        const state = { settled: false, start() {} };
        state.promise = new Promise(resolve => { window.releaseResource = () => { state.settled = true; resolve([]); }; });
        window._startupResourceReady = []; window._startupResourceReady[0] = state;
      };
      showWorkspace('dashboard');
    });
    for (const [width, lang] of [[1440, 'en'], [390, 'ar']]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(lang => { currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; }, lang);
      await new Promise(resolve => setTimeout(resolve, 400));
      for (const destination of ['products', 'transaction']) {
        await page.evaluate(destination => { showWorkspace('dashboard'); prepareResource(); navigateTo(destination); }, destination);
        assert.equal(await page.$eval('#main', el => el.dataset.pendingRoute), destination, 'waiting is visible immediately');
        assert.equal(await page.$('#route-loading-view'), null, 'no generic replacement page');
        assert(await page.$eval('#page-' + destination, el => el.inert && el.getAttribute('aria-busy') === 'true' && !!el.getClientRects().length), 'the actual destination frame is used');
        if (destination === 'products') {
          assert(await page.$eval('#prod-table', el => el.querySelector('tbody tr').children.length === el.querySelector('thead tr').children.length), 'product placeholders follow all real table columns');
          assert(await page.$('#prod-grid-view .prod-grid-card .prod-grid-thumb.ss-skeleton'), 'product image uses the actual image slot');
        } else {
          const controls = await page.$$eval('#page-transaction .ss-control-hidden', els => els.map((el,index) => {
            const host = el.tagName === 'SUMMARY' ? el.parentElement.parentElement : el.parentElement;
            const slot = [...host.querySelectorAll(':scope > .ss-control-placeholder')].find(slot => slot.dataset.control === (el.id || el.name || String(index)));
            if (!slot) return {id:el.id,missing:true};
            const a = el.getBoundingClientRect(), b = slot.getBoundingClientRect();
            return {id:el.id,ok:Math.abs(a.x-b.x)<2 && Math.abs(a.y-b.y)<2 && Math.abs(a.width-b.width)<2 && Math.abs(a.height-b.height)<2,a:a.toJSON(),b:b.toJSON()};
          }));
          assert(controls.length >= 5 && controls.every(control=>control.ok), `form shimmer occupies the real input rectangles: ${JSON.stringify(controls)}`);
        }
        await page.screenshot({ path: path.join(output, `${destination}-${lang}-${width}.png`) });
        await page.evaluate(async () => { releaseResource(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
        assert.equal(await page.$eval('#main', el => !!el.dataset.pendingRoute), false, 'waiting clears after dependencies settle');
        assert.equal(await page.$('.ss-pending-page,.ss-control-hidden'), null, 'real controls are restored');
      }
      await page.evaluate(width => { localStorage.setItem('token', 'shimmer-clients-' + width); showWorkspace('clients'); history.replaceState(null, '', '#clients'); window.clientTask = SouliaClients.renderList(); }, width);
      assert(await page.$('#clients-grid .cp-client-card .cp-avatar.ss-skeleton'), 'client avatar has an in-place shimmer');
      assert(await page.$('#clients-grid .cp-client-card footer .ss-skeleton'), 'client footer has its own placeholder');
      await page.screenshot({ path: path.join(output, `clients-${lang}-${width}.png`) });
      await page.evaluate(async () => { holdReads.get('/clients')([]); await clientTask; });
      await page.evaluate(() => {
        showWorkspace('followups'); switchMainTab('fu', true, true); followUps = []; _fuRenderedSnapshot = '';
        window.followupTask = loadFollowUps();
      });
      assert(await page.$eval('#fu-table', el => el.querySelector('tbody tr').children.length === el.querySelector('thead tr').children.length), 'follow-up placeholders follow the real table columns');
      assert(await page.$('#fu-cards .fu-card .fu-card-status-row .ss-skeleton'), 'follow-up cards retain their status slot');
      await page.screenshot({ path: path.join(output, `followups-${lang}-${width}.png`) });
      await page.evaluate(async () => { holdReads.get('/followups')([]); await followupTask; });
      await page.evaluate(() => { showWorkspace('dashboard'); SouliaLoading.route('suppliers'); });
      assert(await page.$('#suppliers-grid .sup-card2 .sup-card2-avatar.ss-skeleton'), 'supplier avatar uses its real slot');
      assert.equal(await page.$$eval('#suppliers-grid .sup-card2:first-child .sup-stat', els => els.length), 3, 'supplier loading keeps the three real financial slots');
      await page.screenshot({ path: path.join(output, `suppliers-${lang}-${width}.png`) });
      await page.evaluate(() => SouliaLoading.clearRoute());
      await page.evaluate(() => { showWorkspace('reports'); reportsUnlocked = true; currentReportData = null; activeReportTab = 'kpis'; window.reportTask = loadReports(); });
      assert.equal(await page.$$eval('#rep-stats .rep-kpi-card .rep-kpi-value .ss-skeleton', els => els.length), 12, 'all twelve KPI values shimmer in their real cards');
      assert(await page.$eval('.rep-loading-plot > .ss-skeleton', el => el.getBoundingClientRect().height > 100), 'chart occupies the actual chart slot');
      await page.screenshot({ path: path.join(output, `reports-${lang}-${width}.png`) });
      await page.evaluate(async () => { holdReads.get('/transactions/reports')({totalSales:1000,netProfit:200,grossProfit:300,totalPurchases:400,expenseTotal:100,totalDeposit:500,totalRemaining:500,productProfits:[],series:[]}); await reportTask; });
      assert.equal(await page.$$eval('#rep-stats .ss-skeleton', els => els.length), 0, 'final report replaces every placeholder');
      await page.evaluate(() => { showWorkspace('shopify-orders'); _spShowOrdersLoading(); _spkRender('loading'); });
      assert(await page.$('.sp-orders-loading-table td[data-col=client] .ss-skeleton'), 'Shopify keeps its real client column');
      await page.screenshot({ path: path.join(output, `shopify-${lang}-${width}.png`) });
      const effects = await page.evaluate(() => {
        const scopes = [...document.querySelectorAll('[data-loading-style=shimmer].page')];
        return scopes.every(root => {
          const probe = document.createElement('div'); probe.innerHTML = '<div class="ss-reveal">123</div>'; root.append(probe);
          revealData(probe.firstElementChild); souliaCascade(probe); souliaCountUp(probe, 'div');
          const ok = !probe.firstElementChild.classList.contains('ss-cascade-item') && getComputedStyle(probe.firstElementChild).animationName === 'none' && probe.textContent === '123';
          probe.remove(); return ok;
        });
      });
      assert(effects, 'arrival has no slide, stagger, fade or counting effect');
    }
    await page.evaluate(() => {
      showWorkspace('dashboard'); prepareResource();
      sessionStorage.setItem('_txPageSnap', 'pending-form-snapshot');
      navigateTo('transaction');
    });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('_txPageSnap')), 'pending-form-snapshot', 'loading never consumes a saved transaction');
    await page.evaluate(async () => { navigateTo('dashboard'); releaseResource(); await new Promise(requestAnimationFrame); });
    assert.equal(await page.evaluate(() => currentPage), 'dashboard', 'cancelled waiting does not navigate later');
    assert.equal(await page.$('.ss-pending-page,.ss-control-hidden'), null, 'cancelled waiting restores the real controls');
    await page.evaluate(() => { sessionStorage.removeItem('_txPageSnap'); showWorkspace('transaction'); txDirty = true; SouliaLoading.route('products'); });
    assert.equal(await page.$eval('#main', el => !!el.dataset.pendingRoute), false, 'unsaved forms stay visible');
    await page.evaluate(() => { txDirty = false; showWorkspace('shopify-orders'); });
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    assert.equal(await page.$eval('.sp-loading-bar', el => getComputedStyle(el,'::after').animationName), 'none');
    assert.deepEqual(errors, []);
    console.log('PASS shimmer workspaces: actual form inputs, product/follow-up columns, client/supplier card slots, 12 report KPIs and chart, instant waiting, cleanup, no arrival motion, Arabic/mobile and reduced motion.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
