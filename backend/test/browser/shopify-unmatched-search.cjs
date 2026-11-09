const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
      if (url.origin === 'http://soulia.test' && url.pathname === '/')
        return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(publicDir, 'index.html')) });
      const file = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file);
        return request.respond({ status: 200, contentType: ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script')
        return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'en'; currentUser = { _id: 'admin', role: 'admin', perms: [] };
      settings = { discountCodes: [] };
      products = [
        { _id: 'p1', name: 'Dining Table', code: 'DT-01', sellPrice: 1500, isActive: true },
        { _id: 'p6', name: 'Blanket darkgreen Knitted', code: 'BLANKET-DARKGREEN-DGR-S-001', sellPrice: 1350, isActive: true },
      ];
      inventoryCache = [{ _id: 'p1', code: 'DT-01', quantity: 5 }, { _id: 'p6', code: 'BLANKET-DARKGREEN-DGR-S-001', quantity: 2 }];
      _shopifyOrders = [{ _id: 'o1', ref: '3043', client: 'Alyaa Mostafa', status: 'pending',
        items: [
          { productId: 'p1', name: 'Cotton Tissue Beige', code: '30', qty: 1, price: 450 },
          { productId: 'p2', name: 'Loop Runner', code: '37', qty: 1, price: 750 },
          { name: 'Bow dining (12 pieces)', code: 'SHOPIFY', qty: 1, price: 1550 },
          { productId: 'p3', name: 'Luma Organize Set', code: '17', qty: 1, price: 890 },
          { productId: 'p4', name: 'Ghazl Rug L', code: '45', qty: 1, price: 1560 },
          { productId: 'p5', name: 'Ribbon Storage', code: '51', qty: 1, price: 700 },
        ],
        total: 1550, itemsTotal: 1550, shipCost: 0, discount: 0, depositReceipts: [] }];
      editShopifyOrder('o1');
    });
    const dialogHeight = () => page.$eval('#shopify-edit-modal [role="dialog"]', el => el.getBoundingClientRect().height);
    const initialHeight = await dialogHeight();
    await page.type('#shopify-edit-search', 'Dining');
    assert.equal(await page.$eval('#shopify-edit-picker', el => getComputedStyle(el).display), 'block');
    assert.ok(Math.abs((await dialogHeight()) - initialHeight) < 1, 'Search results do not resize the order dialog');
    await page.screenshot({ path: path.join(os.tmpdir(), 'soulia-edit-search-open.png') });
    await page.evaluate(() => {
      const input = document.querySelector('#shopify-edit-search');
      input.value = 'nothing-matches';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.ok(Math.abs((await dialogHeight()) - initialHeight) < 1, 'An empty search result does not resize the order dialog');
    await page.click('#shopify-edit-modal .sp-tabs');
    await page.evaluate(() => { inventoryCache[0].quantity = 0; _renderShopifyEditItems(); });
    const stockState = await page.$eval('#shopify-edit-item-0', row => ({
      badge: row.querySelector('.sp-edit-status-badge')?.textContent,
      icon: !!row.querySelector('.sp-edit-status-badge svg'),
      warning: row.querySelector('.sp-edit-stock-note.is-over')?.textContent,
      warningIcon: !!row.querySelector('.sp-edit-stock-note.is-over svg'),
    }));
    assert.equal(stockState.badge, 'Matched');
    assert.equal(stockState.icon, true);
    assert.match(stockState.warning, /Quantity exceeds stock.*Available: 0/);
    assert.equal(stockState.warningIcon, true);
    const input = '#shopify-edit-item-2 input[oninput^="_shopifyInlineSearch"]';
    await page.type(input, 'df');
    const result = await page.evaluate(() => {
      const picker = document.querySelector('#shopify-inline-picker-2');
      const option = picker.querySelector('.sp-pick-row') || picker.querySelector('.sp-pick-empty');
      const rect = option?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { options: picker.querySelectorAll('.sp-pick-row').length, display: getComputedStyle(picker).display,
        optionVisible: !!option && !!rect && rect.width > 0 && rect.height > 0,
        hit: hit?.className || hit?.tagName, hitOption: !!hit?.closest('.sp-pick-row,.sp-pick-empty'),
        text: picker.textContent };
    });
    assert.equal(result.options, 0, 'The arbitrary query has no matching product');
    assert.equal(result.optionVisible, true, 'The result is visible');
    assert.equal(result.hitOption, true, 'The result can be clicked');
    for (const width of [1440, 630, 390]) {
      await page.setViewport({ width, height: width === 1440 ? 900 : 700 });
      await page.evaluate(() => editShopifyOrder('o1'));
      await page.type('#shopify-edit-search', 'Dining');
      const topResultReachable = await page.$eval('#shopify-edit-picker .sp-pick-row', option => {
        const rect = option.getBoundingClientRect();
        return !!document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.sp-pick-row');
      });
      assert.equal(topResultReachable, true, `Add-item search result is clickable at ${width}px`);
      await page.click('#shopify-edit-modal .sp-tabs');
      await page.type(input, 'Blanket');
      const narrowPicker = await page.$eval('#shopify-inline-picker-2', picker => {
        const row = picker.querySelector('.sp-pick-row');
        const name = row?.querySelector('.sp-pick-name');
        const code = row?.querySelector('.sp-pick-code');
        const price = row?.querySelector('.sp-pick-price');
        const bounds = picker.getBoundingClientRect();
        const inputWidth = document.querySelector('#shopify-edit-item-2 input[oninput^="_shopifyInlineSearch"]').getBoundingClientRect().width;
        return { overflow: picker.scrollWidth > picker.clientWidth + 1,
          width: bounds.width, height: bounds.height, inputWidth,
          rowOverflow: row.scrollWidth > row.clientWidth + 1,
          contentInside: [name, code, price].every(el => {
            const rect = el.getBoundingClientRect();
            return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
          }) };
      });
      assert.equal(narrowPicker.overflow, false, `Picker has no horizontal overflow at ${width}px`);
      assert.equal(narrowPicker.rowOverflow, false, `Product row has no horizontal overflow at ${width}px`);
      assert.equal(narrowPicker.contentInside, true, `Product details fit inside picker at ${width}px`);
      assert.ok(Math.abs(narrowPicker.width - narrowPicker.inputWidth) < 2, `Picker matches search width at ${width}px`);
      assert.ok(narrowPicker.height <= 266, `Picker height stays within its scroll limit at ${width}px`);
      if (width === 390) {
        await page.screenshot({ path: path.join(os.tmpdir(), 'soulia-narrow-picker-after.png') });
      }
      await page.evaluate(sel => { const field = document.querySelector(sel); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })); }, input);
      await page.type(input, 'Dining');
      const match = await page.evaluate(() => {
        const picker = document.querySelector('#shopify-inline-picker-2');
        const option = picker.querySelector('.sp-pick-row');
        const rect = option?.getBoundingClientRect();
        const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { count: picker.querySelectorAll('.sp-pick-row').length,
          name: option?.querySelector('.sp-pick-name')?.textContent,
          reachable: !!hit?.closest('.sp-pick-row'),
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(match.count, 1, `Product search returns a match at ${width}px`);
      assert.equal(match.name, 'Dining Table');
      assert.equal(match.reachable, true, `Product match is clickable at ${width}px`);
      assert.equal(match.overflow, false, `Picker does not overflow the viewport at ${width}px`);
      if (width === 1440) await page.screenshot({ path: path.join(os.tmpdir(), 'soulia-unmatched-search-after.png') });
      if (width === 630) {
        await page.click('#shopify-edit-modal .sp-tabs');
        assert.equal(await page.$eval('#shopify-inline-picker-2', el => getComputedStyle(el).display), 'none', 'Outside click closes the inline picker');
        await page.type(input, ' ');
      }
      await page.click('#shopify-inline-picker-2 .sp-pick-row');
      assert.equal(await page.evaluate(() => _shopifyEditItems[2].productId), 'p1');
    }
    process.stdout.write('Unmatched Shopify product search and selection work at desktop and mobile widths.\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
