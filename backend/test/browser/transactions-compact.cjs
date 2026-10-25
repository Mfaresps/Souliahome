// Offline UI verification; no live data or shipment writes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');
const output = path.join(root, 'artifacts/transactions-compact');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    for (const lang of ['en', 'ar']) for (const width of [1440, 390, 320]) {
      await page.setViewport({ width, height: 950 });
      await page.evaluate(({lang,width}) => {
        currentUser = { _id: 'admin', role: 'admin', perms: ['movements'] }; currentLang = lang;
        document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelector('#splash-screen')?.remove();
        const make = (id, extra = {}) => ({ _id: id, ref: '2928', client: 'Alaa Abdelsatar', type: 'مبيعات',
          date: '2026-10-24', createdAt: '2026-10-24T10:40:00Z', total: 1850, deposit: 500, remaining: 1350,
          payStatus: 'معلق', phone: '01000000000', employee: 'Fares', shipCo: 'Bosta', pickupStatus: 'Ready',
          items: [{ name: 'Mocha Blanket throw', qty: 1, price: 1850, total: 1850 }], ...extra });
        transactions = [make('ready'), make('transit', { bostaOrderId: 'b-1', bostaStatus: 'OUT_FOR_DELIVERY', pickupStatus: 'Shipped' }),
          make('long', { client: 'A very long customer name with several family names', ref: '2928-EXC-LONG', shipCo: 'A very long shipping company name', bostaStatus: 'VALIDATION_ERROR' }),
          make('empty', { client: '', shipCo: '', pickupStatus: 'Pending' }),
          make('purchase', { type: 'مشتريات', shipCo: '', purchaseDetailsHidden: true }), make('cancelled', { cancelled: true })];
        let preview = document.querySelector('#compact-preview');
        if (!preview) { preview = document.createElement('main'); preview.id = 'compact-preview'; document.body.appendChild(preview); }
        [...document.body.children].forEach(el => { if (el !== preview && !['SCRIPT','STYLE','LINK'].includes(el.tagName)) el.style.display = 'none'; });
        preview.style.cssText = 'padding:24px;max-width:1200px;margin:auto';
        preview.innerHTML = width > 700 ? `<div id="mov-grid-list">${transactions.map(renderMovGridCard).join('')}</div>` : `<div id="mov-mobile-list" style="display:block">${transactions.map(renderMovMobileCard).join('')}</div>`;
        window.openOrderView = id => { window.openedOrder = id; };
      }, {lang,width});
      const bounds = await page.$eval('#compact-preview', el => ({ scroll: el.scrollWidth, available: el.getBoundingClientRect().width }));
      await page.screenshot({path:path.join(output, `${lang}-${width}.png`)});
      assert.ok(bounds.scroll <= bounds.available, 'No horizontal overflow: '+JSON.stringify({lang,width,...bounds}));
      const card = '#compact-preview .mov-compact-card';
      assert.ok(await page.$eval(card, el => el.getBoundingClientRect().height < 190), 'Card stays compact');
      const text = await page.$eval(card, el => el.innerText);
      assert.ok(text.includes('#2928') && text.includes('Bosta') && text.includes('Pick-Up'));
      assert.ok(!text.includes('1,850') && !text.includes('Mocha'), 'Financials and products stay in menu');
      await page.click(card + ' .dd-toggle');
      await page.waitForSelector('.dd-menu-portal.show');
      await new Promise(resolve => setTimeout(resolve, 220));
      const menu = await page.$eval('.dd-menu-portal.show', el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,text:el.innerText}; });
      assert.ok(menu.left >= 0 && menu.right <= width && menu.top >= 0 && menu.bottom <= 950, 'Menu fits viewport');
      assert.ok(menu.text.includes('1,850'), 'Amounts available in menu');
      await page.$eval('.dd-menu-portal .mov-compact-menu', el => el.dispatchEvent(new Event('scroll')));
      assert.ok(await page.$('.dd-menu-portal.show'), 'Scrolling menu preserves it');
      assert.equal(await page.evaluate(() => window.openedOrder), undefined, 'Menu does not open order');
      await page.screenshot({path:path.join(output, `${lang}-${width}-menu.png`)});
      await page.click('.dd-menu-portal .dd-item');
      assert.equal(await page.evaluate(() => window.openedOrder), 'ready', 'View action opens the correct order');
      await page.evaluate(() => { closeAllMenus(); window.openedOrder = undefined; document.querySelectorAll('.dd-menu-portal').forEach(el=>el.remove()); });
      await page.screenshot({path:path.join(output, `${lang}-${width}.png`)});
    }
    console.log('Compact transaction cards passed: Arabic/English, 1440/390/320px, hidden details, menu bounds, and view action.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
