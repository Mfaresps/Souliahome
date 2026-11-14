// Compact prep header + one-row scan station: products get the height.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const path = require('path');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements', 'inventory-units-view', 'inventory-units-allocate'] };
const order = n => ({
  _id: String(n).padStart(24, '0'), ref: '3146', type: 'مبيعات', client: 'FARES ISMAEL', date: '2026-11-13',
  total: 3000, remaining: 3000, discount: 120, payStatus: 'معلق', shipCo: 'Bosta', employee: 'Malak Abbas',
  pickupStatus: 'Preparing', pickupRef: 'PREP-C', prepCreatedAt: '2026-11-13', phone: '01000000001',
  items: [{ lineId: 'l1', code: '10', name: 'Boho Charm Basket L', qty: 1, price: 1302.75 },
          { lineId: 'l2', code: 'HB-1', name: 'Hearth Blanket Throw', qty: 1, price: 1697.25 }],
});
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width, dark] of [['ar', 1440, false], ['en', 1440, true], ['ar', 1024, false], ['ar', 390, false]]) {
      const orders = [order(1)];
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width, height: 900 });
      page.on('pageerror', e => errors.push(e.message));
      await page.evaluateOnNewDocument((user, lang) => {
        localStorage.clear(); localStorage.setItem('token', 'preview'); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', lang);
      }, user, lang);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
        if (!url.pathname.startsWith('/api/')) return request.continue();
        const route = url.pathname.slice(4);
        if (route.endsWith('/picking')) return respond({ lines: orders[0].items.map(i => ({ lineId: i.lineId, qty: i.qty, units: [], skippedCount: 0 })) });
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
          ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
      });
      await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pu-prep-col .pu-group');
      await page.evaluate(d => { document.body.classList.toggle('dark-mode', d); openPuCardOrdersModal('PREP-C', 'prep'); }, dark);
      await page.waitForSelector('#pw-work .pw-scan-station');
      if (width < 860) await page.evaluate(() => pwSelectOrder(_pwSelId));
      await new Promise(r => setTimeout(r, 400));
      const m = await page.evaluate(() => {
        const r = s => document.querySelector(s)?.getBoundingClientRect();
        const head = r('#pw-work .pw-work-head'), st = r('#pw-work .pw-scan-station'), tick = r('#pw-work .pw-head-tick');
        const btn = document.querySelector('#pw-work .pw-head-tick'), probe = document.createElement('span');
        document.querySelector('#pu-card-orders-modal').append(probe); probe.style.color = 'var(--accent)';
        const accent = getComputedStyle(probe).color; probe.remove();
        const work = document.querySelector('#pw-work');
        return { head: head.height, station: st.height, tickW: tick.width, tickH: tick.height,
          tickBg: getComputedStyle(btn).backgroundColor, tickColor: getComputedStyle(btn).color, accent,
          locked: btn.disabled && btn.classList.contains('is-locked'), tickText: btn.innerText,
          tiles: document.querySelectorAll('#pw-work .pw-mtile').length,
          money: document.querySelector('#pw-work .pw-cust-money')?.innerText || '',
          overflow: work.scrollWidth > work.clientWidth + 1,
          firstItemTop: r('#pw-work .pw-item').top - head.top };
      });
      ok(m.tiles === 0, 'no money tiles');
      ok(/3,000/.test(m.money) && /120/.test(m.money), 'money is one quiet line (total, remaining, discount)');
      // Nothing scanned yet → locked (grey, with the piece counter); the green state is covered by pickup-prep-lock.cjs
      ok(m.locked && m.tickBg !== m.accent && /0\/2/.test(m.tickText), `prepare button is locked until the pieces are handled (${m.tickBg})`);
      ok(m.tickH >= 40, 'prepare button is a full-size target');
      if (width >= 1024) {
        ok(m.head < 110, `header is slim (${Math.round(m.head)}px)`);
        ok(m.station < (width >= 1101 ? 80 : 120), `scan station is compact (${Math.round(m.station)}px)`);
        if (width > 1100) ok(m.firstItemTop < 300, `products start high (${Math.round(m.firstItemTop)}px below the header top)`);
      }
      ok(!m.overflow, 'no sideways overflow');
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-compact-${lang}-${width}${dark ? '-dark' : ''}.png`) }).catch(() => {});
      console.log(lang, width, dark ? 'dark' : '', JSON.stringify({ head: Math.round(m.head), station: Math.round(m.station), firstItem: Math.round(m.firstItemTop) }));
      await page.close();
    }
    console.log(`prep-workspace-compact: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
