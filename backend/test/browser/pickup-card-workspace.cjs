/* Pickup card opens its workspace directly, with keyboard and scroll behavior. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
        return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'test-user', name: 'Test user', role: 'admin', perms: ['pickup-orders', 'movements'] };
      qs('#app').style.display = '';
      qs('#login-page').style.display = 'none';
      qs('#splash-screen')?.remove();
      onPageEnter = () => {};
      const base = { client: 'Mona Hassan', phone: '01000000000', date: '2026-11-08', total: 450, shipCo: 'Bosta', items: [{ lineId: 'line-1', name: 'Ceramic bowl', qty: 1, price: 450 }] };
      _pickupOrders = [
        { ...base, _id: 'prep-order', ref: '4101', pickupStatus: 'Preparing', pickupRef: 'PREP-4101', prepCreatedAt: '2026-11-08T08:00:00Z' },
        { ...base, _id: 'ready-order', ref: '4102', pickupStatus: 'Ready', pickupRef: 'READY-4102' },
      ];
      transactions = _pickupOrders;
      _puOrdersLoaded = true;
      _puLoadPrepGroups(_pickupOrders);
      api = async url => url.endsWith('/picking') ? { lines: [] } : [];
      navigateTo('pickup-orders');
      qs('#page-pickup-orders').classList.add('active');
      qs('#fx-drawer').style.display = 'none';
      qs('#drafts-drawer').style.display = 'none';
      renderPickupBoard();
      document.body.style.minHeight = '1800px'; // Exercise scroll locking with a page scrollbar.
    });

    for (const [width, lang] of [[1440, 'en'], [1400, 'en'], [390, 'ar']]) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(language => {
        currentLang = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
        renderPickupBoard();
      }, lang);
      await new Promise(resolve => setTimeout(resolve, 900));
      const trigger = '#pu-prep-col .pu-group-header';
      if (width === 1440) {
        await page.evaluate(() => {
          window._previewChurn = { added: 0, removed: 0 };
          new MutationObserver(records => records.forEach(record => {
            record.addedNodes.forEach(node => { if (node.id === 'order-status-preview') window._previewChurn.added++; });
            record.removedNodes.forEach(node => { if (node.id === 'order-status-preview') window._previewChurn.removed++; });
          })).observe(document.body, { childList: true, subtree: true });
        });
        await page.hover(trigger);
        await new Promise(resolve => setTimeout(resolve, 1200));
        const churn = await page.evaluate(() => window._previewChurn);
        assert.deepEqual(churn, { added: 1, removed: 0 }, `Group status preview should stay open: ${JSON.stringify(churn)}`);
        await page.evaluate(() => {
          window._previewPopup = document.querySelector('#order-status-preview');
          renderPickupBoard();
        });
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(await page.evaluate(() => document.querySelector('#order-status-preview') === window._previewPopup), true, 'Board refresh keeps the same preview open');
        assert.equal(await page.$eval(trigger, el => el.getAttribute('aria-describedby')), 'order-status-preview');
        await page.evaluate(() => document.querySelector('#pu-prep-col').dispatchEvent(new Event('scroll')));
        assert.equal(await page.evaluate(() => document.querySelector('#order-status-preview') === window._previewPopup), true, 'Column scroll repositions without recreating preview');
        assert.deepEqual(await page.evaluate(() => window._previewChurn), { added: 1, removed: 0 }, 'Preview is mounted only once through refresh and scroll');
        await page.mouse.move(0, 0);
        await new Promise(resolve => setTimeout(resolve, 220));
      }
      const measure = () => page.evaluate(() => ({
        viewport: innerWidth, client: document.documentElement.clientWidth,
        pageWidth: document.querySelector('#page-pickup-orders').getBoundingClientRect().width,
        bodyPadding: getComputedStyle(document.body).paddingInlineEnd,
        rootGutter: getComputedStyle(document.documentElement).scrollbarGutter,
        scrollY
      }));
      const beforeLayout = await measure();
      await page.click('#pu-prep-col .pu-ref-hero');
      await page.waitForSelector('#pu-card-orders-modal.active');
      const openLayout = await measure();
      assert.equal(beforeLayout.rootGutter, 'stable', `pickup page reserves scrollbar ${lang}/${width}`);
      assert.equal(openLayout.pageWidth, beforeLayout.pageWidth, `board width stays fixed on open ${lang}/${width}`);
      assert.equal(openLayout.client, beforeLayout.client, `viewport width stays fixed on open ${lang}/${width}`);
      assert.equal(openLayout.bodyPadding, beforeLayout.bodyPadding, `no extra body padding on open ${lang}/${width}`);
      assert.equal(await page.$('.pu-morph-surface'), null, `no morph surface ${lang}/${width}`);
      assert.equal(await page.$eval('body', el => el.style.overflow), 'hidden');
      assert.equal(await page.$eval('#pu-card-orders-modal .pw-shell', el => el.getAttribute('role')), 'dialog');
      assert.equal(await page.$eval(trigger, el => el.getAttribute('aria-expanded')), 'true');
      await page.evaluate(() => {
        const shell = document.querySelector('#pu-card-orders-modal .pw-shell');
        const items = [...shell.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        items.at(-1).focus();
      });
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => {
        const shell = document.querySelector('#pu-card-orders-modal .pw-shell');
        const first = [...shell.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
          .find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        return document.activeElement === first;
      }), true, 'Tab wraps inside dialog');
      await page.focus('#puco-search-input');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('#pu-card-orders-modal').style.display === 'none');
      const closedLayout = await measure();
      assert.equal(closedLayout.pageWidth, beforeLayout.pageWidth, `board width stays fixed on close ${lang}/${width}`);
      assert.equal(closedLayout.scrollY, openLayout.scrollY, `scroll position stays fixed on close ${lang}/${width}`);
      assert.equal(await page.$eval('body', el => el.style.overflow), '');
      assert.equal(await page.$eval(trigger, el => el.getAttribute('aria-expanded')), 'false');
      assert.equal(await page.$eval(trigger, el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.waitForSelector('#pu-card-orders-modal.active');
      await page.click('#pu-card-orders-modal .pw-x');
      await page.waitForFunction(() => document.querySelector('#pu-card-orders-modal').style.display === 'none');
    }

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.click('#pu-ready-col .pu-ref-hero');
    await page.waitForSelector('#pu-card-orders-modal.active');
    assert.equal(await page.$('.pu-morph-surface'), null, 'no morph surface with reduced motion');
    assert.equal(await page.$eval('#pu-card-orders-modal', el => el.dataset.workspace), 'ready');
    await page.click('#pu-card-orders-modal .pw-x');
    await page.waitForFunction(() => document.querySelector('#pu-card-orders-modal').style.display === 'none');
    assert.equal(await page.$eval('body', el => el.style.overflow), '');
    assert.deepEqual(errors, []);
    console.log('PASS pickup card workspace: direct open, stable board width and scroll position, Arabic/mobile, focus return, Escape in input, ready card and reduced motion');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
