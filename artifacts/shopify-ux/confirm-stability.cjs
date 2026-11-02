const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('../../backend/node_modules/puppeteer');

const publicDir = path.resolve(__dirname, '../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [width, height] of [[1440, 900], [390, 900], [390, 600]]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://soulia.test' && url.pathname === '/') {
          return request.respond({ status: 200, contentType: 'text/html', body: html });
        }
        const file = path.join(publicDir, url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
          return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
        }
        if (request.resourceType() === 'script') {
          return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        }
        return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(width => {
        currentLang = width < 720 ? 'ar' : 'en';
        document.documentElement.lang = currentLang;
        document.documentElement.dir = width < 720 ? 'rtl' : 'ltr';
        currentUser = { _id: 'review-user', name: 'Reviewer', role: 'admin', perms: ['shopify-prepare-ship', 'pickup-orders'] };
        qs('#app').style.display = '';
        qs('#login-page').style.display = 'none';
        qs('#splash-screen')?.remove();
        qsa('.page').forEach(el => el.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active');
        currentPage = 'shopify-orders';
        localStorage.setItem('soulia_sp_send_preparing_v1', '1');
        _shopifyOrders = [{
          _id: 'review-order', ref: '3021', shopifyId: '50000', client: 'Shorok Herbid', phone: '01000000000',
          status: 'pending', createdAt: new Date().toISOString(), shopifyCreatedAt: new Date().toISOString(),
          items: [{ productId: 'review-product', name: 'Glam Organizer Maroon', code: '50M', qty: 1, price: 740 }],
          total: 860, itemsTotal: 740, shipCost: 120, discount: 0, manualDiscount: 0, codesDiscount: 0,
          depositReceipts: [], comments: [], shippingAddress: 'Cairo', shippingCity: 'Cairo'
        }];
        _sppLoadGroups = async () => {
          await new Promise(resolve => setTimeout(resolve, 350));
          return [{ prepRef: 'PREP-01', count: 2 }, { prepRef: 'PREP-02', count: 1 }];
        };
        approveShopifyOrder('review-order');
      }, width);
      const sizes = [];
      for (const delay of [50, 150, 200, 250, 250]) {
        await new Promise(resolve => setTimeout(resolve, delay));
        sizes.push(await page.evaluate(() => {
          const shell = qs('#shopify-confirm-modal .spd');
          const body = qs('#shopify-confirm-modal .spd-body');
          const rect = shell?.getBoundingClientRect();
          const actions = qs('#shopify-confirm-modal .spd-actions')?.getBoundingClientRect();
          return { height: Math.round(rect?.height || 0), top: Math.round(rect?.top || 0),
            actionsVisible: !!actions && actions.top >= 0 && actions.bottom <= innerHeight,
            bodyScroll: body ? body.scrollHeight > body.clientHeight : false,
            groups: qs('#sp-prep-groups')?.querySelectorAll('.spp-opt').length || 0 };
        }));
      }
      const heights = sizes.map(size => size.height);
      const stable = Math.max(...heights) - Math.min(...heights) <= 1;
      await page.screenshot({ path: path.join(__dirname, `confirm-stable-${width}x${height}.png`) });
      console.log(JSON.stringify({ width, height, stable, sizes, errors }));
      if (!stable || sizes.some(size => !size.actionsVisible) || errors.length) process.exitCode = 1;
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
