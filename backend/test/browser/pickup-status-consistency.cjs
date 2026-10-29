const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && /\.(css|js|html)$/.test(file) && fs.existsSync(file) && !url.pathname.startsWith('/vendor/')) {
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file, 'utf8') });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(() => {
      currentUser = { _id: 'admin', role: 'admin', perms: [] };
      currentLang = 'en'; currentPage = 'movements';
      const row = (id, pickupStatus, pickupRef) => ({ _id: id, ref: id, pickupStatus, pickupRef,
        type: 'مبيعات', client: 'Status regression', date: '2026-10-29', createdAt: '2026-10-29T10:00:00Z',
        total: 100, remaining: 100, deposit: 0, payStatus: 'معلق', items: [] });
      transactions = [row('2950', 'Preparing', 'NEW'), row('2951', 'Pending', null), row('2952', 'Ready', 'RUN')];
      _pickupOrders = [];
      // Keep the test on the movements page; no background request is needed
      // to verify that the event and group cache preserve the actual table.
      _rtFetchTx = () => {};
      _puQueueLivePaint = () => {};
      _rtToastEvent = () => {};
      qs('#login-page').style.display = 'none'; qs('#app').style.display = '';
      qs('#splash-screen')?.remove();
      document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
      qs('#page-movements').classList.add('active');
      const render = () => {
        renderMovements();
        return Object.fromEntries([...document.querySelectorAll('#mov-table tbody tr')].map(tr => [
          tr.querySelector('.mov-check')?.value,
          tr.querySelector('td[data-col="pickup"] .order-state')?.dataset.orderState,
        ]));
      };
      const snapshots = [render()];
      _puLoadPrepGroups([row('2951', 'Preparing', 'OLD'), row('2952', 'Preparing', 'OLD')]);
      for (let i = 0; i < 5; i++) { _puSavePrepGroups(); snapshots.push(render()); }
      _puApplyRealtimeEvent({ ids: ['2951'], action: 'preparing', pickupRef: 'ACTUAL' });
      const preparing = render();
      _puApplyRealtimeEvent({ ids: ['2951'], action: 'undo' });
      const undone = render();
      return { snapshots, preparing, undone };
    });
    const expected = { 2950: 'Preparing', 2951: 'Pending', 2952: 'Ready' };
    for (const snapshot of result.snapshots) assert.deepEqual(snapshot, expected);
    assert.deepEqual(result.preparing, { ...expected, 2951: 'Preparing' });
    assert.deepEqual(result.undone, expected);
    console.log('Passed: actual movements table stays stable over repeated renders and stale group saves; confirmed preparation and undo still update the correct row.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
