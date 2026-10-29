const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const status = require(path.join(publicDir, 'order-status.js'));
const output = path.join(root, 'artifacts/order-status-preview');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 860, height: 620 });
    for (const lang of ['en', 'ar']) {
      const badges = ['Preparing', 'Ready', 'NEW_CARRIER_STATUS'].map(key => status.badge(status.resolve(
        key === 'NEW_CARRIER_STATUS' ? { hasShipment: true, bostaStatus: key } : { pickupStatus: key }, 'transaction', lang
      ), { compact: true, preview: true }));
      await page.setContent(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif"><main style="margin:170px auto;width:340px"><table style="width:100%;border-collapse:collapse;background:white"><thead><tr><th style="padding:14px">#</th><th>Order status</th></tr></thead><tbody>${badges.map((badge, i) => `<tr onclick="window.rowClicks++"><td style="padding:18px;border-top:1px solid #e7ebee">#${2950 + i}</td><td style="text-align:center;border-top:1px solid #e7ebee">${badge}</td></tr>`).join('')}</tbody></table></main><script>window.rowClicks=0</script></body></html>`);
      await page.addStyleTag({ path: path.join(publicDir, 'order-status.css') });
      await page.addStyleTag({ path: path.join(publicDir, 'order-status-preview.css') });
      await page.addScriptTag({ path: path.join(publicDir, 'order-status-preview.js') });
      assert.equal(await page.$$eval('[data-state-preview]', nodes => nodes.length), 2);
      for (const state of ['Preparing', 'Ready']) {
        const selector = `[data-order-state="${state}"]`;
        await page.hover(selector);
        assert.equal(await page.$('#order-status-preview'), null, 'No popup on a passing hover');
        await page.waitForSelector('#order-status-preview');
        await pause(state === 'Preparing' ? 2300 : 900);
        assert.equal(await page.$eval('#order-status-preview', el => el.dataset.state), state);
        assert.equal(await page.$eval('#order-status-preview', el => el.dir), lang === 'ar' ? 'rtl' : 'ltr');
        assert.equal(await page.$$eval('#order-status-preview', nodes => nodes.length), 1);
        assert.ok(await page.$eval('#order-status-preview', el => el.getAnimations({ subtree: true }).length > 0));
        await page.screenshot({ path: path.join(output, `${state}-${lang}.png`) });
        await page.hover('#order-status-preview');
        await pause(250);
        assert.ok(await page.$('#order-status-preview'), 'Hoverable popup stays open');
        await page.keyboard.press('Escape');
        assert.equal(await page.$('#order-status-preview'), null);
        await page.mouse.move(0, 0);
      }
      await page.keyboard.press('Tab');
      await page.waitForSelector('#order-status-preview');
      assert.equal(await page.$eval('[data-order-state="Preparing"]', el => el.getAttribute('aria-expanded')), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('[data-order-state="Preparing"]', el => el.getAttribute('aria-expanded')), 'false');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#order-status-preview');
      await page.keyboard.press('Escape');
      await page.click('[data-order-state="Ready"]');
      await page.waitForSelector('#order-status-preview');
      assert.equal(await page.evaluate(() => window.rowClicks), 0, 'Preview does not open its row');
      await page.evaluate(() => document.body.classList.add('dark-mode'));
      await pause(250);
      await page.screenshot({ path: path.join(output, `Ready-${lang}-dark.png`) });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      assert.equal(await page.$eval('#order-status-preview', el => el.getAnimations({ subtree: true }).length), 0);
      await page.emulateMediaFeatures([]);
      await page.evaluate(() => document.querySelector('[data-order-state="Ready"]').remove());
      await page.waitForFunction(() => !document.querySelector('#order-status-preview'));
      await page.hover('[data-order-state="NEW_CARRIER_STATUS"]');
      await pause(350);
      assert.equal(await page.$('#order-status-preview'), null, 'Unknown carrier states do not invent a scene');
    }
    const mobileHtml = (await page.content()).replace('<head>', '<head><meta name="viewport" content="width=device-width,initial-scale=1">');
    await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true });
    await page.setContent(mobileHtml);
    await page.evaluate(() => {
      document.querySelector('main').style.cssText = 'width:100%;margin:0';
      const badge = document.querySelector('[data-order-state="Preparing"]');
      badge.style.cssText = 'position:fixed;bottom:5px;right:5px';
    });
    await page.tap('[data-order-state="Preparing"]');
    await page.waitForSelector('#order-status-preview');
    assert.ok(await page.$eval('#order-status-preview', el => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    }), 'Mobile popup fits the viewport at the bottom corner');
    await page.screenshot({ path: path.join(output, 'Preparing-mobile.png') });
    await page.tap('th');
    assert.equal(await page.$('#order-status-preview'), null, 'Outside tap closes');
    assert.deepEqual(errors, []);

    const stateCodes = ['Pending', 'Preparing', 'Ready', 'Shipped', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CUSTOMER_POSTPONED', 'FAILED_ATTEMPT', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED'];
    const scenesPage = await browser.newPage();
    scenesPage.on('pageerror', error => errors.push(error.message));
    await scenesPage.setViewport({ width: 1200, height: 900 });
    await scenesPage.setContent('<html><body style="font-family:Arial,sans-serif;background:#f4f6f8"><main id="state-root" style="position:fixed;top:330px;left:570px"></main></body></html>');
    await scenesPage.addStyleTag({ path: path.join(publicDir, 'order-status.css') });
    await scenesPage.addStyleTag({ path: path.join(publicDir, 'order-status-preview.css') });
    await scenesPage.addScriptTag({ path: path.join(publicDir, 'order-status-preview.js') });
    const gallery = [];
    for (const lang of ['en', 'ar']) {
      const fixtures = stateCodes.map(key => ({ row: { pickupStatus: key }, kind: 'transaction', scene: null }));
      fixtures.push(
        { row: { hasShipment: true, bostaStatus: 'IN_TRANSIT', bostaDeliveryException: { code: 3 }, bostaLastTrackingUpdate: { status: 'IN_TRANSIT', reason: '<img src=x onerror=alert(1)>', reasonAr: '<img src=x onerror=alert(1)>' } }, kind: 'transaction', scene: 'postponed' },
        { row: { pickupStatus: 'Ready', shipmentAttempts: [{}] }, kind: 'transaction', scene: 'waiting' },
        { row: { status: 'pending' }, kind: 'shopify', scene: 'waiting' },
        { row: { status: 'pending', confirmationApproved: true }, kind: 'shopify', scene: 'confirmed' },
        { row: { status: 'rejected' }, kind: 'shopify', scene: 'cancelled' },
        { row: { followUpOutcome: 'cancelled' }, kind: 'shopify', scene: 'cancelled' },
      );
      for (const [i, fixture] of fixtures.entries()) {
        const meta = status.resolve(fixture.row, fixture.kind, lang);
        await scenesPage.evaluate(html => { document.querySelector('#state-root').innerHTML = html; }, status.badge(meta, { preview: true }));
        await scenesPage.hover('[data-state-preview]');
        await scenesPage.waitForSelector('#order-status-preview');
        await pause(350);
        const detail = await scenesPage.$eval('#order-status-preview', el => ({ width: el.getBoundingClientRect().width, scene: el.dataset.scene, lang: el.lang, copy: el.querySelector('p').textContent, animations: el.getAnimations({ subtree: true }).length, unsafeImage: !!el.querySelector('img') }));
        assert.equal(detail.width, 200, 'Smaller popup width');
        assert.equal(detail.lang, lang);
        assert.ok(detail.copy && detail.animations > 0, `${meta.key} has a description and animation`);
        assert.equal(detail.unsafeImage, false, 'Carrier notes remain text');
        if (fixture.scene) assert.equal(detail.scene, fixture.scene, 'Exception and reshipment scenes respect resolved status');
        if (i < stateCodes.length && lang === 'en') gallery.push(await scenesPage.$eval('#order-status-preview', el => el.outerHTML));
        await scenesPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        assert.equal(await scenesPage.$eval('#order-status-preview', el => el.getAnimations({ subtree: true }).length), 0, `${meta.key} respects reduced motion`);
        await scenesPage.emulateMediaFeatures([]);
        await scenesPage.keyboard.press('Escape');
        await scenesPage.mouse.move(0, 0);
      }
    }
    await scenesPage.evaluate(html => {
      document.querySelector('#state-root').remove();
      document.body.innerHTML = `<main class="scene-gallery">${html.join('')}</main>`;
      const style = document.createElement('style');
      style.textContent = '.scene-gallery{display:grid;grid-template-columns:repeat(4,200px);gap:18px;padding:24px;justify-content:center}.scene-gallery .order-status-preview{position:relative;top:auto!important;left:auto!important;align-self:start}';
      document.head.append(style);
    }, gallery);
    await pause(800);
    await scenesPage.screenshot({ path: path.join(output, 'all-scenes-en.png'), fullPage: true });
    await scenesPage.evaluate(() => document.body.classList.add('dark-mode'));
    await scenesPage.screenshot({ path: path.join(output, 'all-scenes-en-dark.png'), fullPage: true });
    await scenesPage.close();
    assert.deepEqual(errors, []);

    // Verify the production transaction renderer opts in, while search/filter
    // badges keep their original passive behavior.
    await page.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
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
    const integration = await page.evaluate(stateCodes => {
      currentLang = 'en';
      currentUser = { _id: 'admin', role: 'admin', perms: [] };
      const rows = stateCodes.map((pickupStatus, i) => ({ _id: `preview-${i}`, ref: `${2950+i}`, type: 'مبيعات', client: 'Preview', pickupStatus, date: '2026-10-29', total: 100, remaining: 100, deposit: 0, payStatus: 'معلق', items: [] }));
      transactions = rows;
      const table = document.createElement('table');
      table.innerHTML = `<tbody>${rows.map(renderMovementTxRow).join('')}</tbody>`;
      return {
        states: [...table.querySelectorAll('[data-state-preview]')].map(el => el.dataset.orderState),
        passive: !_puStatusBadge('Ready', rows[1], true).includes('data-state-preview'),
        script: !!document.querySelector('script[src*="order-status-preview.js"]'),
      };
    }, stateCodes);
    assert.deepEqual(integration, { states: stateCodes, passive: true, script: true });
    await page.evaluate(() => {
      document.documentElement.dir = 'ltr';
      const root = document.createElement('main');
      root.id = 'group-preview-test';
      root.style.cssText = 'position:fixed;inset:40px;z-index:5000;display:flex;gap:20px;background:var(--bg,#fff);align-items:start;padding:30px';
      const row = { _id: 'gp', ref: '3000', type: 'مبيعات', total: 100, items: [], pickupStatus: 'Preparing', pickupRef: 'PREP', shipCo: 'Bosta' };
      const prep = _puBuildPrepGroupCard({ prepRef: 'PREP', orders: [row] });
      const ready = _puBuildGroupCard({ key: 'READY', orders: [{ ...row, pickupStatus: 'Ready' }] }, 'ready');
      const daily = _puDailyGroupCard({ key: 'DAILY', stage: 'shipped', shipCo: 'Bosta', orders: [{ ...row, hasShipment: true, bostaStatus: 'IN_TRANSIT' }] });
      const mixed = _puDailyGroupCard({ key: 'MIXED', stage: 'shipped', shipCo: 'Bosta', orders: [
        { ...row, hasShipment: true, bostaStatus: 'DELIVERED' }, { ...row, _id: 'gp2', hasShipment: true, bostaStatus: 'IN_TRANSIT' }] });
      [prep, ready, daily, mixed].forEach((card, i) => { card.id = `group-preview-${i}`; card.style.width = '240px'; root.append(card); });
      document.body.append(root);
      window._groupPreviewOpened = [];
      openPuCardOrdersModal = key => _groupPreviewOpened.push(key);
      openPuDailyShippingGroup = key => _groupPreviewOpened.push(key);
    });
    for (const [i, scene] of ['Preparing', 'Ready', 'transit', 'delivered'].entries()) {
      const header = `#group-preview-${i} .pu-group-header`;
      await page.hover(header);
      await page.waitForSelector('#order-status-preview');
      assert.equal(await page.$eval('#order-status-preview', el => el.dataset.scene), scene);
      assert.equal(await page.$('.pu-quick-tip.show'), null, 'Only one hover preview is shown');
      if (i === 3) assert.match(await page.$eval('#order-status-preview', el => el.textContent), /Mixed shipment statuses/);
      await page.click(header);
      assert.equal(await page.$('#order-status-preview'), null, 'Header click closes the preview and retains its original action');
      await page.mouse.move(0, 0);
    }
    assert.deepEqual(await page.evaluate(() => _groupPreviewOpened), ['PREP', 'READY', 'DAILY', 'MIXED']);
    await page.hover('#group-preview-0 .pu-group-header');
    await page.waitForSelector('#order-status-preview');
    await page.$eval('#group-preview-0 .pu-group-header', el => el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })));
    assert.equal(await page.$('#order-status-preview'), null, 'Dragging dismisses the preview');
    await page.$eval('#group-preview-0 .pu-group-header', el => el.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    await page.keyboard.press('Tab');
    await page.$eval('#group-preview-1 .pu-group-header', el => el.focus());
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => _groupPreviewOpened.at(-1)), 'READY', 'Keyboard still opens the group');
    console.log('Passed: Pickup group header hover, mixed-state summary, original click/keyboard actions, and drag dismissal.');
    console.log('Passed: all lifecycle scenes, smaller popup, exceptions/reshipments, safe notes, hover/keyboard/touch, row click isolation, Arabic/English, reduced motion, dark mode, mobile bounds, and production transaction rendering.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
