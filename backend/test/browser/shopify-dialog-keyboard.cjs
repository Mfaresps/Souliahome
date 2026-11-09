/* Exercise the order details and editor as a keyboard user, with synthetic data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Number(process.env.VIEWPORT_WIDTH) || 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') {
        return request.respond({ status: 200, contentType: 'text/html', body: html });
      }
      const file = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file);
        const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream';
        return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') {
        return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      }
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'ar';
      document.documentElement.lang = 'ar';
      document.documentElement.dir = 'rtl';
      currentUser = { _id: 'staff-1', name: 'Employee', role: 'staff', perms: ['shopify-orders', 'followups', 'complaints'] };
      qs('#app').style.display = '';
      qs('#login-page').style.display = 'none';
      qs('#splash-screen')?.remove();
      window.peekFetches = 0;
      api = async url => {
        if (url === '/followups') {
          peekFetches++;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return [];
      };
      followUps = [];
      _shopifyOrders = [{
        _id: 'order-1', ref: '2913', client: 'Test Customer', phone: '01000000000',
        shopifyId: 's1', status: 'pending', createdAt: '2026-10-22T09:52:00Z',
        items: [{ productId: 'p1', name: 'Test Product', qty: 1, price: 2180 }],
        total: 2180, itemsTotal: 2180, shipCost: 0, discount: 0,
        manualDiscount: 0, codesDiscount: 0, depositReceipts: []
      }];
      const trigger = document.createElement('button');
      trigger.id = 'keyboard-test-trigger';
      trigger.textContent = 'Open order';
      document.body.appendChild(trigger);
      trigger.focus();
      window.peekOpenedAt = performance.now();
      openSpOrderPeek('order-1');
    });
    /* The window opens once its data is in (≤ SP_PEEK_OPEN_WAIT), at its final size — it
       no longer paints a partial window and re-draws it (owner request, Nov 9, 2026). */
    await page.waitForSelector('#sp-peek.is-open .sp-pk-close');
    const opened = await page.evaluate(() => ({
      title: qs('#sp-pk-title')?.textContent,
      item: qs('#sp-peek .sp-pk-item-n')?.textContent,
      loading: !!qs('#sp-peek .sp-pk-fu-skel'),
      ms: performance.now() - peekOpenedAt
    }));
    assert.match(opened.title, /2913/, 'Order identity is in the window when it opens');
    assert.match(opened.item, /Test Product/, 'Order items are in the window when it opens');
    assert.equal(opened.loading, false, 'Follow-ups are already loaded when the window opens');
    assert.ok(opened.ms < 1000, 'The window opens within a second (' + Math.round(opened.ms) + 'ms)');
    assert.equal(await page.evaluate(() => {
      const panel = qs('#sp-peek .sp-peek');
      return panel.scrollWidth > panel.clientWidth + 1;
    }), false, 'Order window stays within the viewport width');
    await page.evaluate(() => Promise.all([_spEnsureFollowUps(false), _spEnsureFollowUps(false)]));
    assert.equal(await page.evaluate(() => peekFetches), 1, 'Concurrent order windows share one follow-up request');
    // Desktop entrance: calm fade (220ms) + rise (280ms) — owner request, Nov 9, 2026.
    assert.equal(await page.evaluate(() => /0\.22s/.test(getComputedStyle(qs('#sp-peek .sp-peek')).transitionDuration)), true,
      'Order window uses the calm entrance duration');
    // Focus starts on the window itself — not on «×», which drew a focus ring on every open.
    await page.waitForFunction(() => document.activeElement === qs('#sp-peek .sp-peek'));
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('sp-pk-close')), false,
      'Opening does not focus the close button');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => qs('#sp-peek .sp-peek').contains(document.activeElement) && document.activeElement !== qs('#sp-peek .sp-peek')), true,
      'First Tab lands on a control inside the order window');
    await page.evaluate(() => {
      const controls = [...document.querySelectorAll('#sp-peek .sp-peek a[href], #sp-peek .sp-peek button:not([disabled]), #sp-peek .sp-peek summary')]
        .filter(el => el.getClientRects().length);
      controls.at(-1).focus();
    });
    await page.keyboard.press('Tab');
    const peekTab = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML.slice(0, 180),
      first: [...document.querySelectorAll('#sp-peek .sp-peek a[href], #sp-peek .sp-peek button:not([disabled]), #sp-peek .sp-peek input:not([disabled]), #sp-peek .sp-peek select:not([disabled]), #sp-peek .sp-peek textarea:not([disabled]), #sp-peek .sp-peek [tabindex]:not([tabindex="-1"])')]
        .find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')?.outerHTML.slice(0, 180)
    }));
    assert.equal(peekTab.active, peekTab.first, 'Tab wraps within order details');

    await page.evaluate(() => {
      document.querySelector('#sp-peek .sp-pk-close').focus();
      editShopifyOrder('order-1');
    });
    await page.waitForSelector('#shopify-edit-modal [role="dialog"][aria-modal="true"]');
    assert.equal(await page.$eval('#shopify-edit-modal [role="dialog"]', el => getComputedStyle(el).animationName), 'uiWindowEnter',
      'Order editor shares the window entrance');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'shopify-edit-search',
      'Order editor focuses product search');
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid',
      'Product search shows a visible focus ring');
    assert.equal(await page.$eval('#shopify-edit-search', el => el.labels?.length > 0), true,
      'Product search has a visible label');
    assert.equal(await page.$eval('#shopify-edit-modal [aria-label]', el => el.getBoundingClientRect().width >= 44), true,
      'Editor close button has a usable touch target');
    await page.evaluate(() => document.querySelector('#shopify-edit-modal [aria-label]').focus());
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => document.activeElement.closest('#shopify-edit-modal') !== null), true,
      'Shift+Tab stays inside editor');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#shopify-edit-modal'));
    assert.equal(await page.$('#sp-peek') !== null, true, 'Escape closes only the editor');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('sp-pk-close')), true,
      'Editor restores focus to order details');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#sp-peek'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'keyboard-test-trigger',
      'Order details restores focus to the opener');

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => openSpOrderPeek('order-1'));
    await page.waitForSelector('#sp-peek.is-open');
    await page.evaluate(() => closeSpOrderPeek());
    assert.equal(await page.$('#sp-peek'), null, 'Reduced-motion order window closes without a delayed exit');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

    await page.evaluate(() => { document.querySelector('#keyboard-test-trigger').focus(); openFuModal(); });
    await page.waitForSelector('#fu-modal-overlay [role="dialog"][aria-modal="true"]');
    assert.equal(await page.$eval('#fu-modal-overlay [role="dialog"]', el => getComputedStyle(el).animationName), 'uiWindowEnter',
      'Follow-up form shares the window entrance');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'fu-order-search',
      'Follow-up creation focuses order search');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#fu-modal-overlay', el => el.style.display), 'none',
      'Escape closes follow-up creation');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'keyboard-test-trigger',
      'Follow-up creation restores focus to the opener');
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'window-system-native-test';
      dialog.textContent = 'Native dialog';
      document.body.appendChild(dialog);
      dialog.showModal();
    });
    assert.equal(await page.$eval('#window-system-native-test', el => getComputedStyle(el).animationName), 'uiWindowEnter',
      'Native dialogs share the window entrance');
    await page.evaluate(() => { const dialog = qs('#window-system-native-test'); dialog.close(); dialog.remove(); });

    const immediatePage = await page.evaluate(() => {
      window.followupFetches = 0;
      api = async url => {
        if (url === '/followups') {
          followupFetches++;
          await new Promise(resolve => setTimeout(resolve, 80));
          return [{ _id: 'fu-1', orderRef: '2913', shopifyOrderId: 'order-1',
            status: 'معلق', clientName: 'Test Customer', createdAt: '2026-10-22T09:52:00Z' }];
        }
        return [];
      };
      window.followupNavPromise = openShopifyOrderFollowup('2913', 'order-1');
      return currentPage;
    });
    assert.equal(immediatePage, 'followups', 'Follow-up page opens before the network responds');
    await page.evaluate(() => window.followupNavPromise);
    assert.equal(await page.evaluate(() => followupFetches), 1,
      'Matching follow-up uses one network request');

    await page.evaluate(() => {
      window.followupFetches = 0;
      window.followupNavPromise = openShopifyOrderFollowup('9999', 'missing-order');
    });
    await page.evaluate(() => window.followupNavPromise);
    assert.equal(await page.evaluate(() => followupFetches), 1,
      'Missing follow-up also uses one network request');
    assert.equal(await page.$eval('#fu-search', el => el.value), '9999',
      'Missing follow-up filters the page to its order number');
    console.log('Shopify dialog and follow-up navigation passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
