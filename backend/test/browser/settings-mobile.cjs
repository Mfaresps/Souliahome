const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const start = html.indexOf('<div class="page" id="page-settings">');
const end = html.indexOf('</div><!-- /page-settings -->', start) + '</div><!-- /page-settings -->'.length;
assert.ok(start > 0 && end > start);
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html dir="rtl"><body><div id="main">${html.slice(start, end)}</div></body></html>` }));
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir, 'navigation-shell.css'), 'utf8') });
    await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir, 'notification-settings.css'), 'utf8') });
    await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir, 'settings-responsive.css'), 'utf8') });
    await page.evaluate(() => {
      document.querySelector('#page-settings').classList.add('active');
      window.currentUser = { role: 'admin' }; window.currentLang = 'ar'; localStorage.setItem('token', 'fixture');
      window.api = async () => ({ configured: true, preferences: { enabled: true, deposit: true, comment: true, order: true, deliveryProblem: true, delivered: true, mention: true }, allowedTypes: ['deposit','comment','order','deliveryProblem','delivered','mention'], language: 'ar' });
      navigator.serviceWorker.getRegistration = async () => null;
    });
    await page.addScriptTag({ path: path.join(publicDir, 'notification-settings.js') });
    await page.waitForSelector('#push-device-status');
    for (const width of [320, 360, 390, 430, 768, 1440]) {
      await page.setViewport({ width, height: 844 });
      for (const dir of ['rtl', 'ltr']) {
        await page.evaluate(dir => { document.documentElement.dir = dir; currentLang = dir === 'ltr' ? 'en' : 'ar'; }, dir);
        await page.waitForFunction(dir => document.querySelector('#notification-settings').lang === (dir === 'ltr' ? 'en' : 'ar'), {}, dir);
        await new Promise(resolve => setTimeout(resolve, 350)); // Let the shell's sidebar-margin transition finish.
        const failures = await page.evaluate(() => {
          const out = [];
          const selectors = ['#page-settings', '.settings-page-inner', '.stg-layout', '.stg-panels', '#notification-settings', '#notification-settings .push-setting-row', '#notification-settings .push-switch', '#notification-settings .push-action', '#set-lang'];
          for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
            if (!el.getClientRects().length) continue;
            const r = el.getBoundingClientRect();
            if (r.left < -1 || r.right > innerWidth + 1) out.push({ selector, left: r.left, right: r.right, viewport: innerWidth });
          }
          const card = document.querySelector('#notification-settings');
          if (card.scrollWidth > card.clientWidth + 1) out.push({ selector: '#notification-settings overflow', scroll: card.scrollWidth, client: card.clientWidth });
          return out;
        });
        assert.deepEqual(failures, [], `Settings clipped at ${width}px ${dir}: ${JSON.stringify(failures)}`);
      }
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; currentLang = 'ar'; });
    await page.waitForFunction(() => document.querySelector('#notification-settings').lang === 'ar');
    await new Promise(resolve => setTimeout(resolve, 350));
    await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'soulia-settings-mobile-fixed.png'), fullPage: true });
    console.log('Settings layout passed at 320, 360, 390, 430, 768 and 1440px in RTL/LTR: full page, cards, switches, actions and language input remain visible.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
