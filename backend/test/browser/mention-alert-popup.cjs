// «Mentions and requests awaiting you» popup (first-login alert) over the SHIPPED index.html (API mocked).
//   node test/browser/mention-alert-popup.cjs        screenshots → artifacts/mention-alert-*.png
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const day = 86400000, now = Date.now();
const carrier = ['تحديث بوسطة: خارج للتسليم', 'آخر سبب مسجل لدى بوسطة: العميل طلب تأجيل الاستلام',
  'نص شركة الشحن: Postponed - the customer requested', 'كود السبب: 3', 'موعد إعادة المحاولة حسب بوسطة: 2026-11-28T10:00:00.000Z',
  'وقت التحديث: 2026-11-26T09:00:00Z', 'البوليصة: 12345'].join('\n');
const mentions = [
  { id: 'm1', fromUserId: 'system', fromName: 'تذكير المتابعة', txId: '6630aa84f65f', txRef: '3203', commentId: 0,
    commentText: 'تذكير متابعة: طلب #3203 بدون تحديث منذ 12 ساعة — أجل الاستلام', read: false, ts: new Date(now - day).toISOString() },
  { id: 'm2', fromUserId: 'system', fromName: 'متابعة تلقائية', txId: '6630aa84f65f', txRef: '3203', commentId: 0,
    commentText: `متابعة تأجيل استلام الطلب #3203 (${carrier})`, read: false, ts: new Date(now - day).toISOString() },
  { id: 'm3', fromUserId: 'system', fromName: 'نظام التوزيع', txId: 'shopify:abc', txRef: '3276', commentId: 0,
    commentText: 'أوردر جديد مُسند إليك: #3276\nالعميل: سمر حمدي صلاح\nالإجمالي: 1010 EGP', read: false, ts: new Date(now - 2 * day).toISOString() },
  { id: 'm4', fromUserId: 'u2', fromName: 'Malak Abbas', txId: 'tx9', txRef: '3190', commentId: 3,
    commentText: '@Admin راجع العنوان قبل الشحن', read: false, ts: new Date(now - 3 * day).toISOString() },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
  try {
    for (const [lang, dark] of [['ar', false], ['en', true]]) {
      console.log(lang + (dark ? ' dark' : ''));
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 900 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUB, 'index.html'), 'utf8') });
        const local = path.join(PUB, url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && /\.(js|css|png)$/.test(url.pathname) && fs.existsSync(local))
          return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript', body: fs.readFileSync(local) });
        if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
        if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate((ms, lng, dk) => {
        currentUser = { _id: 'u1', role: 'admin', perms: [], name: 'Admin' }; currentLang = lng;
        document.documentElement.dir = lng === 'en' ? 'ltr' : 'rtl';
        document.body.classList.toggle('dark-mode', dk);
        if (typeof applyLang === 'function') try { applyLang(); } catch (_) {}
        users = [{ _id: 'u2', name: 'Malak Abbas', username: 'malak' }];
        showMentionAlert(ms);
      }, mentions, lang, dark);
      await new Promise(r => setTimeout(r, 400));
      const r = await page.evaluate(() => {
        const list = document.querySelector('#mention-alert-list');
        const cards = [...list.children];
        return { title: document.querySelector('#mention-alert-title').textContent,
          texts: cards.map(c => c.textContent.replace(/\s+/g, ' ').trim()),
          initials: cards.slice(0, 2).map(c => !!c.querySelector('svg')),
          heights: cards.map(c => Math.round(c.getBoundingClientRect().height)),
          dots: list.querySelectorAll('span[style*="border-radius:50%"][style*="width:6px"]').length };
      });
      const [rem, post, ord, men] = r.texts;
      ok(lang === 'ar' ? /متابعة متأخرة/.test(rem) : /Overdue follow-up/.test(rem), 'reminder has a clear title: ' + rem.slice(0, 70));
      ok(/#3203/.test(rem) && !/84f65f/.test(rem + post), 'order number shown, never the internal id tail');
      ok(lang === 'ar' ? /العميل أجّل الاستلام/.test(post) : /Customer postponed delivery/.test(post), 'postponement has a clear title: ' + post.slice(0, 90));
      ok(/العميل طلب تأجيل الاستلام/.test(post) && !/Postponed - the customer/.test(post) && !/كود السبب/.test(post), 'one short reason line, carrier English text and codes left out');
      ok(r.initials.every(Boolean), 'system notices show an icon, not initials');
      ok(/#3276/.test(ord) && /سمر حمدي صلاح/.test(ord) && r.heights[2] < 70, 'new order is one line (' + r.heights[2] + 'px)');
      ok(/3190/.test(men) && !/#tx9/.test(men), 'person mention shows the order number');
      ok(r.dots === 0, 'no second unread dot beside the titles');
      ok(lang === 'ar' ? /4 تنبيهات جديدة/.test(r.title) : /4 new updates/.test(r.title), 'popup title fits the content: ' + r.title);
      const order = await page.evaluate(() => { const d = document.querySelectorAll('#mention-alert-list > *')[1].querySelector('div[style*="line-clamp"]'); return [...d.querySelectorAll('bdi')].map(b => Math.round(b.getBoundingClientRect().left)); });
      ok(lang === 'ar' ? order[0] > order[1] : order[0] < order[1], 'reason comes before the carrier status in reading order (' + order.join(',') + ')');
      await page.screenshot({ path: path.join(root, `artifacts/mention-alert-${lang}${dark ? '-dark' : ''}.png`) });
      ok(!errors.length, 'no page errors ' + errors.join(' | '));
      await page.close();
    }
  } catch (e) { failed = true; console.error(e.message); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
