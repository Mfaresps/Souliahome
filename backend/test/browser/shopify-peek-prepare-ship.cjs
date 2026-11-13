// The quick view carries «تحضير وشحن» for a pending order (Nov 13, 2026); none without the perm or once confirmed.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const outDir = path.resolve(__dirname, '../../../artifacts/shopify-peek-prepare-ship');
fs.mkdirSync(outDir, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  let failures = 0; const check = (ok, name) => { console.log((ok ? '✓ ' : '✗ ') + name); if (!ok) failures++; };
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = new URL(r.url()), file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return r.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
      return r.respond({ status: 200, contentType: r.resourceType() === 'script' ? 'text/javascript' : 'application/json', body: r.resourceType() === 'script' ? '' : '[]' });
    });
    for (const [width, lang] of [[1440, 'ar'], [390, 'ar'], [1440, 'en']]) {
      await page.setViewport({ width, height: 900 });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      const r = await page.evaluate(async lang => {
        currentUser = { _id: 'u1', name: 'Review', role: 'admin', perms: [] };
        currentLang = lang; document.documentElement.dir = document.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
        document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active'); currentPage = 'shopify-orders';
        followUps = [];
        _shopifyOrders = [{ _id: 'o1', ref: '3080', client: 'Momen Helmy', phone: '01124535353', total: 3582, status: 'pending',
          createdAt: '2026-11-07T11:07:00Z', items: [{ name: 'NEST Organizer', qty: 1, price: 3582 }], depositReceipts: [], comments: [] }];
        api = () => Promise.resolve({});
        window.called = null; approveShopifyOrder = id => { window.called = id; };
        openSpOrderPeek('o1');
        await new Promise(res => setTimeout(res, 400));
        const btn = qs('#sp-peek .sp-pk-foot-go'), panel = qs('#sp-peek .sp-peek');
        const b = btn?.getBoundingClientRect(), p = panel?.getBoundingClientRect();
        btn?.click();
        return { has: !!btn, text: btn?.textContent.trim(), called: window.called,
          inside: !!b && b.bottom <= p.bottom + 0.5 && b.top >= p.top && b.left >= p.left - 0.5 && b.right <= p.right + 0.5, h: b?.height };
      }, lang);
      await page.screenshot({ path: path.join(outDir, `${lang}-${width}.png`) });
      check(r.has, `${lang} ${width}: button present`);
      check(/تحضير وشحن|Prepare & Ship/.test(r.text || ''), `${lang} ${width}: label «${r.text}»`);
      check(r.called === 'o1', `${lang} ${width}: opens the prepare-and-ship dialog for this order`);
      check(r.inside, `${lang} ${width}: inside the window (h ${Math.round(r.h || 0)})`);
    }
    const none = await page.evaluate(async () => {
      closeSpOrderPeek(); await new Promise(r => setTimeout(r, 300));
      currentUser = { _id: 'u2', name: 'Staff', role: 'staff', perms: ['shopify-orders'] };
      openSpOrderPeek('o1'); await new Promise(r => setTimeout(r, 300));
      const noPerm = !qs('#sp-peek .sp-pk-foot-go');
      currentUser = { _id: 'u1', name: 'Review', role: 'admin', perms: [] };
      _shopifyOrders[0].status = 'approved'; _spPeekRender();
      return { noPerm, approved: !qs('#sp-peek .sp-pk-foot-go') };
    });
    check(none.noPerm, 'no button without shopify-prepare-ship');
    check(none.approved, 'no button once the order is confirmed');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } finally { await browser.close(); }
  console.log(failures ? `${failures} failed` : 'all passed'); process.exitCode = failures ? 1 : 0;
})();
