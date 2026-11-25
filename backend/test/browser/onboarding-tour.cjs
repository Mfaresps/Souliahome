// First sign-in welcome + tour (frontend/public/onboarding.js). Real index.html over a mocked API.
// Needs the frontend dev server (TEST_ORIGIN, default http://127.0.0.1:8080).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const PERMS = ['dashboard', 'shopify-orders', 'shopify-cancel-request', 'pickup-orders'];

async function run(browser, { lang = 'ar', width = 1440, dark = false, pending = true }) {
  const page = await browser.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width, height: 860 });
  const me = { id: '7', username: 'nour', name: 'Nour Adel', role: 'staff', roleId: 'sales', perms: PERMS, isActive: true, onboardingPending: pending };
  await page.evaluateOnNewDocument((user, lang, dark) => {
    localStorage.setItem('token', 'onb-test');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('soulia_lang_pref', lang);
    if (dark) localStorage.setItem('darkMode', 'true');
  }, me, lang, dark);
  await page.setRequestInterception(true);
  page.on('request', r => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith('/api/')) return r.continue();
    if (r.method() === 'POST') posts.push(path);
    if (path === '/api/auth/me') return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
    if (path === '/api/users/me/onboarding-done') { me.onboardingPending = false; return r.respond({ status: 201, contentType: 'application/json', body: '{"ok":true}' }); }
    const body = path === '/api/transactions/startup-overview' ? '{"rows":[],"activeCount":0}' : /\/(users|mentionable|tags|products|followups)$/.test(path) ? '[]' : '{}';
    return r.respond({ status: 200, contentType: 'application/json', body });
  });
  await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, errors, posts, me };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  let n = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
  try {
    // 1. Arabic, first sign-in: the welcome opens by itself.
    {
      const { page, errors, posts } = await run(browser, {});
      await page.waitForSelector('.onb-dialog[open]', { timeout: 20000 });
      const t = await page.$eval('.onb-title', el => el.textContent);
      ok(/أهلًا بك في SOULIA، Nour/.test(t), 'welcome names the user');
      ok(await page.$eval('.onb-body', el => /مبيعات/.test(el.textContent)), 'welcome states the role');
      ok(await page.$eval('.onb-dialog', el => el.dir === 'rtl'), 'Arabic is RTL');
      await page.click('[data-act="next"]'); // → what is SOULIA
      ok(await page.$$eval('.onb-pillars li', l => l.length) === 4, 'system intro has 4 pillars');
      await page.click('[data-act="next"]'); // → sections
      const secs = await page.$$eval('.onb-sec', l => l.map(b => b.dataset.go));
      ok(secs.includes('dashboard') && secs.includes('shopify-orders') && secs.includes('pickup-orders'), 'allowed sections listed');
      ok(!secs.includes('vault') && !secs.includes('settings') && !secs.includes('suppliers'), 'sections without permission are not listed');
      await page.click('[data-act="next"]'); // → permissions
      const perms = await page.$eval('.onb-perms', el => el.textContent);
      ok(/طلب إلغاء طلب Shopify/.test(perms) && /يبقى الطلب قائمًا/.test(perms), 'permission names + their limits');
      ok(!/إلغاء طلبات Shopify مباشرة/.test(perms), 'a permission the user lacks is not listed');
      await page.click('[data-act="back"]');
      ok(await page.$eval('.onb-step', el => /3 من 5/.test(el.textContent)), 'back works');
      await page.click('[data-act="next"]'); await page.click('[data-act="next"]'); // → tips
      ok(await page.$$eval('.onb-tips li', l => l.length) === 4, 'tips step');
      ok(!posts.includes('/api/users/me/onboarding-done'), 'nothing saved before finishing');
      await page.click('[data-act="done"]');
      await new Promise(r => setTimeout(r, 400));
      ok(!(await page.$('.onb-dialog')), 'dialog closed');
      ok(posts.filter(p => p === '/api/users/me/onboarding-done').length === 1, 'finish marks it seen once');
      // Reload: not shown again.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 4000));
      ok(!(await page.$('.onb-dialog[open]')), 'not shown again after it was seen');
      // Replay from the profile menu: shown, but writes nothing.
      const doneCount = () => posts.filter(p => p === '/api/users/me/onboarding-done').length; const before = doneCount();
      await page.evaluate(() => window.SouliaOnboarding.start());
      await page.waitForSelector('.onb-dialog[open]');
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));
      ok(!(await page.$('.onb-dialog')) && doneCount() === before, 'replay + Escape writes nothing');
      ok(await page.$('#pm-tour') !== null, 'profile menu has the tour item');
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    // 2. Existing account (no flag): nothing shown.
    {
      const { page } = await run(browser, { pending: false });
      await new Promise(r => setTimeout(r, 5000));
      ok(!(await page.$('.onb-dialog[open]')), 'existing accounts never see it');
      await page.close();
    }
    // 3. English, dark, phone width: fits, skip marks it seen, a section card navigates.
    {
      const { page, posts, errors } = await run(browser, { lang: 'en', width: 390, dark: true });
      await page.waitForSelector('.onb-dialog[open]', { timeout: 20000 });
      ok(await page.$eval('.onb-title', el => /Welcome to SOULIA, Nour/.test(el.textContent)), 'English welcome');
      ok(await page.$eval('.onb-card', el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), 'card fits a 390px screen');
      await page.click('[data-act="next"]'); await page.click('[data-act="next"]');
      await page.click('[data-go="pickup-orders"]');
      await new Promise(r => setTimeout(r, 500));
      ok(!(await page.$('.onb-dialog')) && posts.includes('/api/users/me/onboarding-done'), 'section card closes and marks seen');
      ok(await page.evaluate(() => currentPage) === 'pickup-orders', 'section card opens that page');
      ok(errors.length === 0, 'no page errors (en): ' + errors.join(' | '));
      await page.close();
    }
    console.log(`PASS: onboarding tour — ${n} checks`);
  } catch (e) {
    console.error(`FAIL after ${n} checks:`, e.message);
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
