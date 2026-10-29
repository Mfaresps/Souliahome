const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements', 'inventory', 'inventory-units-view', 'inventory-units-allocate'] };
const product = { _id: 'a'.repeat(24), code: 'TEST', name: 'Basket', price: 100 };
const base = { type: 'مبيعات', client: 'Pickup customer', date: '2026-10-20', total: 100, remaining: 100,
  pickupStatus: 'Preparing', pickupRef: 'PREP-FLOW', prepCreatedAt: '2026-10-20', shipCo: 'Bosta',
  shippingAddress: 'Test street', shippingGov: 'Cairo', phone: '01000000000',
  items: [{ lineId: 'line', productId: product._id, code: 'TEST', name: 'Basket', qty: 1, price: 100 }] };
(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width] of [['en', 1500], ['ar', 390]]) {
      const orders = [1, 2].map(n => ({ ...base, _id: String(n).padStart(24, '0'), ref: '310' + n }));
      const summaries = Object.fromEntries(orders.map(o => [o._id, { lines: [{ lineId: 'line', productId: product._id, qty: 1, units: [], availableCount: 1 }] }]));
      const page = await browser.newPage(), errors = [];
      let rejectCoverage = true;
      await page.setViewport({ width, height: 1000 });
      page.on('pageerror', e => errors.push(e.message));
      await page.evaluateOnNewDocument((user, lang) => {
        localStorage.clear(); localStorage.setItem('token', 'preview'); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', lang);
      }, user, lang);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
        if (!url.pathname.startsWith('/api/')) return request.continue();
        const route = url.pathname.slice(4), body = request.postData() ? JSON.parse(request.postData()) : {};
        if (route.endsWith('/picking')) return respond(summaries[route.split('/')[3]]);
        if (route.endsWith('/picking/scans')) {
          if (rejectCoverage) {
            rejectCoverage = false;
            return respond({ code: 'PURCHASE_RECEIPT_RECONCILIATION_REQUIRED', message: 'Purchase receipt needs reconciliation before picking',
              purchaseTransactionId: '6ad6bf985124d5601b2b3d35', purchaseRef: '900016', invoiceQuantity: 10, registeredQuantity: 12 }, 409);
          }
          const unit = { unitId: 'unit', barcode: body.identifier, status: 'picking', version: 1 };
          summaries[route.split('/')[3]].lines[0].units.push(unit);
          return respond({ unit });
        }
        if (route.endsWith('/actions')) {
          summaries[body.transactionId].lines[0].units[0].status = 'prepared'; return respond({ ok: true });
        }
        if (route.endsWith('/prep-check')) {
          const order = orders.find(o => route.includes(o._id)); order.prepChecked = body.prepChecked;
          summaries[order._id].prepChecked = body.prepChecked; return respond({ ok: true, updated: true });
        }
        if (route.startsWith('/shipping/create-order/')) {
          Object.assign(orders.find(o => route.endsWith(o._id)), { bostaOrderId: 'shipment', bostaTrackingNumber: 'TR-1', bostaStatus: 'CREATED' });
          return respond({ bostaOrderId: 'shipment', trackingNumber: 'TR-1' });
        }
        if (route.startsWith('/inventory-units/')) return respond({ unit: { productId: product._id, status: 'available' } });
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } : route === '/products' ? [product] :
          route === '/transactions/inventory' ? [{ ...product, current: 10 }] :
          ['/transactions', '/transactions/pickup-orders'].includes(route) ? orders : route === '/shipping/pickup-preview' ? { requests: [] } : []);
      });
      await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pu-prep-col .pu-group');
      await page.evaluate(() => {
        // Isolate the native print boundary; the real confirmation UI remains under test.
        _awbPrepareSoon = () => {}; _awbForget = () => {};
        printBostaAwb = async () => _awbConfirmPrinted();
        openPuCardOrdersModal('PREP-FLOW', 'prep');
      });
      await page.waitForFunction(() => !!_pwPickState(_pwSelId).summary);
      if (width < 700) await page.evaluate(() => pwSelectOrder(_pwSelId));
      assert.equal(await page.$('#pw-order-scan'), null);
      assert.match(await page.$eval('.pw-cust-meta', el => el.textContent), /20.*2026/);
      // Use real Shift key events, as a USB HID reader does, without focusing the input.
      if (lang === 'ar') {
        await page.click('.pw-manual-toggle');
        await page.click('.pw-reader-bar strong');
        assert.notEqual(await page.evaluate(() => document.activeElement.id), 'pw-order-scan');
      }
      const hardwareScan = async () => {
        for (const char of 'SU-6AD6BF985124D5601B2B3ED5') {
          if (/[A-Z]/.test(char)) { await page.keyboard.down('Shift'); await page.keyboard.press('Key' + char); await page.keyboard.up('Shift'); }
          else await page.keyboard.press(/\d/.test(char) ? 'Digit' + char : 'Minus');
        }
      };
      await page.evaluate(() => { window._testKeys = []; window.addEventListener('keydown', e => _testKeys.push({ key: e.key, target: e.target.id, before: _pwReaderKeys }), true); });
      await hardwareScan();
      await page.waitForSelector('.pw-scan-feedback.is-error').catch(async error => {
        console.log(await page.evaluate(() => ({ active: document.activeElement?.id, keys: _testKeys, reader: _pwReaderKeys,
          state: _pwPickState(_pwSelId), blocking: [...document.querySelectorAll('#soulia-modal-overlay.active, #bsf-overlay:not(.is-out), #inv-detail-overlay.active, dialog[open]')].map(e => e.outerHTML.slice(0, 150)) })), errors);
        throw error;
      });
      const reason = await page.$eval('.pw-scan-feedback.is-error', el => el.textContent);
      assert(reason.includes('900016') && reason.includes('10') && reason.includes('12'), 'shows the actual purchase mismatch');
      assert(await page.$('[onclick*="pucoShowInvoice(\'6ad6bf985124d5601b2b3d35"]'));
      assert.equal(await page.$eval('#puco-progress-fill', el => el.style.width), '0%');
      if (!(await page.$('#pw-order-scan'))) await page.click('.pw-manual-toggle');
      await page.type('#pw-order-scan', 'draft');
      await page.waitForFunction(() => !document.querySelector('[data-pw-scan-result]'), { timeout: 10000 });
      assert.equal(await page.$eval('#pw-order-scan', el => el.value), 'draft', 'expiry preserves typed input');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'pw-order-scan', 'expiry preserves focus');
      assert.equal(await page.$('.pw-unit-scan-row.has-error'), null);
      await page.evaluate(() => { document.querySelector('#pw-order-scan').value = ''; _pwPickState(_pwSelId).orderScanDraft = ''; });
      await page.click('.pw-reader-bar strong');
      await hardwareScan();
      await page.waitForSelector('#bsf-overlay [data-stage="ask"]').catch(async error => {
        console.log(await page.evaluate(() => ({ active: document.activeElement?.outerHTML?.slice(0, 300),
          reader: _pwReaderKeys, state: _pwPickState(_pwSelId), order: _pucoGetGroup()?.orders[0],
          shipping: _bsfState?.stage, modal: document.querySelector('#soulia-modal-overlay.active')?.textContent })), errors);
        throw error;
      });
      const centered = () => page.waitForFunction(() => {
        const el = document.querySelector('#bsf-overlay .bsf-card');
        if (!el) return false;
        const r = el.getBoundingClientRect(); return Math.abs(r.x + r.width / 2 - innerWidth / 2) < 4 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 4;
      });
      await centered();
      assert.equal(await page.evaluate(() => _pwSelId), orders[0]._id);
      assert.equal(await page.$eval('#puco-progress-fill', el => el.style.width).catch(() => page.$eval('#puco-progress-wrap', el => el.textContent)), '50%');
      await page.click('[data-bsf="send"]');
      await page.waitForSelector('#bsf-overlay [data-stage="sent"]'); await centered();
      assert.equal(await page.evaluate(() => _pwSelId), orders[0]._id);
      assert(await page.$eval(`.pw-ocard[data-order-id="${orders[0]._id}"]`, el => el.classList.contains('is-done') && el.textContent.includes(document.documentElement.lang === 'en' ? 'With Bosta' : 'أُرسل لبوسطة')));
      await page.click('[data-bsf="print"]');
      await page.waitForSelector('#soulia-modal-overlay.active');
      await page.click('#soulia-modal-cancel');
      await page.waitForSelector('#bsf-overlay [data-stage="sent"]');
      assert.equal(await page.evaluate(() => _pwSelId), orders[0]._id);
      await page.click('[data-bsf="print"]');
      await page.waitForSelector('#soulia-modal-overlay.active');
      await page.click('#soulia-modal-confirm');
      await page.waitForSelector('#bsf-overlay [data-stage="printed"] .bsf-ps-feed'); await centered();
      assert.equal(await page.evaluate(() => _pwSelId), orders[0]._id);
      await page.waitForFunction(id => _pwSelId !== id, {}, orders[0]._id);
      assert.equal(await page.evaluate(() => _pucoColType), 'prep');
      assert.equal(orders[0].pickupStatus, 'Preparing');
      assert.deepEqual(errors, []);
      console.log(`${lang}: automatic scan/preparation, progress, date, centered shipping/printing, cancellation, success animation and gated advancement passed`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
