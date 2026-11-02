// Real dialog and browser; deferred HTTP responses, no live orders or payments.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/after-sales-performance');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [lang, width] of [['ar', 390], ['en', 1440]]) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport({ width, height: 1000 });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setRequestInterception(true);
      page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body><main id="main"></main></body></html>' }));
      await page.goto('http://soulia.test/');
      const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
      await page.addStyleTag({ content: html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')) });
      await page.addStyleTag({ path: path.join(publicDir, 'after-sales.css') });
      await page.evaluate(lang => {
        Object.assign(window, { currentLang: lang, currentUser: { _id: 'operator' }, currentPage: 'dashboard',
          isAdmin: () => true, hasPerm: () => true, products: [], transactions: [], returnRequests: [], inventoryCache: [],
          buildNotifications: () => {}, buildSidebar: () => {}, syncVaultState: async () => {},
          SouliaOrderStatus: { resolve: () => ({}), badge: () => '' }, calls: [], releases: [], holdRefresh: true });
        let sequence = 0;
        if (!crypto.randomUUID) crypto.randomUUID = () => 'operation-' + (++sequence);
        window.invoice = { _id: '111111111111111111111111', ref: '1001', client: 'Test customer', total: 617.9,
          items: [{ code: '27', name: 'Woven Basket', qty: 1, price: 617.9, total: 617.9 }] };
        window.row = { _id: '222222222222222222222222', originalTransactionId: invoice._id, originalRef: invoice.ref,
          client: invoice.client, requestKind: 'exchange', reason: 'defect', items: invoice.items, total: 617.9, exchangeItems: invoice.items,
          workflow: { ref: 'AS-2026-000002', version: 2, stage: 'shipping', approvedAt: new Date().toISOString(),
            fulfillmentChannel: 'bosta', shipment: { deliveryId: 'delivery', trackingNumber: 'tracking' },
            selectedLines: [{ ...invoice.items[0], lineIndex: 0, unitIds: [] }], selectedUnits: [], history: [],
            quote: { credit: 617.9, replacement: 617.9, customerFee: 0, creditApplied: 617.9, collectDue: 0, refundDue: 0 } } };
        window.api = async (url, options = {}) => {
          const body = options.body ? JSON.parse(options.body) : null;
          calls.push({ url, method: options.method || 'GET', body });
          if (['/returns', '/transactions', '/transactions/inventory'].includes(url)) {
            if (holdRefresh) await new Promise(resolve => releases.push(resolve));
            return [];
          }
          if (url.startsWith('/after-sales/invoice/')) return { invoice, prior: [], cases: [], identities: { lines: [] },
            products: [{ _id: '333333333333333333333333', code: '27', name: 'Woven Basket', sellPrice: 617.9, available: 10 }],
            policy: { customerFeesEnabled: true, returnFee: 10, exchangeFee: 10 } };
          if (url === '/after-sales/quote') {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, body.customerFee === 40 ? 500 : 30);
              options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
            });
            return { quote: { credit: 617.9, replacement: 0, customerFee: body.customerFee, refundDue: +(617.9 - body.customerFee).toFixed(2) } };
          }
          if (options.method === 'POST') {
            if (window.failSave) { window.failSave = false; throw new Error('network unavailable'); }
            if (window.holdSave) await new Promise(resolve => window.finishSave = resolve);
            if (url.endsWith('/receive')) row.workflow.receivedAt = new Date().toISOString();
            if (url.endsWith('/delivery')) row.workflow.replacementDeliveredAt = new Date().toISOString();
            if (url.endsWith('/settle')) { row.workflow.carrierSettlement = { cost: body.actualCost }; row.workflow.stage = 'closed'; }
            row.workflow.history.push({ action: url.split('/').at(-1), by: 'Operator', at: new Date().toISOString() });
            return structuredClone(row);
          }
          return structuredClone(row);
        };
      }, lang);
      await page.addScriptTag({ path: path.join(publicDir, 'after-sales.js') });
      await page.evaluate(() => AfterSales.open(row._id));
      const getCount = () => page.evaluate(() => calls.filter(call => call.url === '/after-sales/' + row._id && call.method === 'GET').length);
      const initialGets = await getCount();
      await page.$eval('[data-as-action=receive]', button => button.click());
      await page.evaluate(() => {
        holdSave = true;
        document.querySelector('[name=physicalPossessionConfirmed]').checked = true;
        const form = document.querySelector('[data-as-receive]'); form.requestSubmit(); form.requestSubmit();
      });
      await page.waitForFunction(() => typeof finishSave === 'function');
      assert.equal(await page.$eval('[type=submit]', button => button.disabled), true);
      assert.match(await page.$eval('[type=submit]', button => button.textContent), /Saving|جارٍ/);
      await page.screenshot({ path: path.join(output, `saving-${lang}.png`) });
      await page.evaluate(() => { holdSave = false; finishSave(); });
      await page.waitForSelector('[data-as-action=delivery]:not([disabled])');
      assert.equal(await page.evaluate(() => releases.length), 3, 'all slow list refreshes are still unresolved');
      assert.equal(await getCount(), initialGets, 'saved response avoids another case GET');
      assert.equal(await page.evaluate(() => calls.filter(call => call.url.endsWith('/receive')).length), 1, 'double submit cannot repeat receipt');
      await page.$eval('[data-as-action=delivery]', button => button.click());
      await page.evaluate(() => {
        const form = document.querySelector('[data-as-action-form]');
        form.elements.note.value = 'Customer received the replacement'; form.elements.confirmed.checked = true; form.requestSubmit();
      });
      await page.waitForSelector('[data-as-action=settle]:not([disabled])');
      assert.equal(await getCount(), initialGets);
      // A second committed step while refresh is pending queues one fresh pass.
      await page.evaluate(() => { holdRefresh = false; releases.splice(0).forEach(resolve => resolve()); });
      await page.waitForFunction(() => calls.filter(call => call.url === '/transactions/inventory').length === 2);
      await page.$eval('[data-as-action=settle]', button => button.click());
      const inventoryReads = await page.evaluate(() => calls.filter(call => call.url === '/transactions/inventory').length);
      await page.evaluate(() => {
        failSave = true;
        const form = document.querySelector('form'); form.elements.reference.value = 'settlement-001';
        form.elements.confirmed.checked = true; form.requestSubmit();
      });
      await page.waitForSelector('.as-error');
      assert.equal(await page.$eval('[type=submit]', button => button.disabled), false);
      assert.equal(await page.$eval('[name=reference]', input => input.value), 'settlement-001');
      await page.$eval('form', form => form.requestSubmit());
      await page.waitForSelector('[data-as-print]');
      const attempts = await page.evaluate(() => calls.filter(call => call.url.endsWith('/settle')));
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0].body, attempts[1].body, 'retry retains the same operation key and payment');
      assert.equal(await page.evaluate(() => calls.filter(call => call.url === '/transactions/inventory').length), inventoryReads, 'settlement does not reload stock');
      assert.equal(await getCount(), initialGets);
      await page.screenshot({ path: path.join(output, `completed-${lang}.png`) });

      await page.evaluate(() => AfterSales.create(invoice._id, 'return'));
      await page.$eval('[data-as-qty]', input => { input.value = '1'; input.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForSelector('[data-as-quote] .as-summary');
      const quoteCount = () => page.evaluate(() => calls.filter(call => call.url === '/after-sales/quote').length);
      const firstQuotes = await quoteCount();
      await page.$eval('[name=note]', input => { input.value = 'Customer details'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.$eval('[data-as-search]', input => { input.value = 'Basket'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
      assert.equal(await quoteCount(), firstQuotes, 'notes and product search do not request another calculation');
      await page.evaluate(() => {
        const input = document.querySelector('[name=customerFee]');
        for (const value of ['40', '20', '20']) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await page.waitForFunction(() => document.querySelector('[data-as-quote] .as-total')?.textContent.includes('597.9'));
      assert.equal(await quoteCount(), firstQuotes + 2, 'identical input/change pairs share one calculation');
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 550)));
      assert.match(await page.$eval('[data-as-quote] .as-total', node => node.textContent), /597\.9/, 'obsolete slow quotes cannot replace the latest amount');
      await page.evaluate(async () => {
        const input = document.querySelector('[name=customerFee]'); input.value = '25'; input.dispatchEvent(new Event('input', { bubbles: true }));
        await AfterSales.open(row._id);
        await new Promise(resolve => setTimeout(resolve, 250));
      });
      await page.evaluate(async () => {
        row.workflow.stage = 'shipping'; delete row.workflow.receivedAt;
        delete row.workflow.replacementDeliveredAt; delete row.workflow.carrierSettlement;
        await AfterSales.open(row._id);
        document.querySelector('[data-as-action=receive]').click();
        document.querySelector('[name=physicalPossessionConfirmed]').checked = true;
        holdSave = true; finishSave = null;
        document.querySelector('[data-as-receive]').requestSubmit();
      });
      await page.waitForFunction(() => typeof finishSave === 'function');
      await page.evaluate(() => { currentUser = { _id: 'another-operator' }; document.querySelector('dialog').close(); holdSave = false; finishSave(); });
      await page.waitForFunction(() => document.querySelector('dialog').getAttribute('aria-busy') === 'false');
      assert.equal(await page.$eval('dialog', node => node.open), false, 'saved data from the previous account cannot reopen its case');
      assert.deepEqual(errors, [], 'old form timers must not affect a different case screen');
      console.log(`PASS ${lang}/${width}: saved steps available with blocked refreshes; no redundant GET; retry safety; latest quote only`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
