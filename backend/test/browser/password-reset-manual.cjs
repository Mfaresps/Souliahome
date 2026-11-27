// Staff password reset, «تعيين كلمة مرور» mode: «متابعة» enables once both fields match (password-policy.js).
// Real index.html over a mocked API. Needs the frontend dev server (TEST_ORIGIN, default http://127.0.0.1:8080).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  try {
    const page = await browser.newPage(); const errors = [], posts = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const me = { id: '1', _id: '1', username: 'admin', name: 'Owner', role: 'admin', perms: [], isActive: true };
    await page.evaluateOnNewDocument((u) => { localStorage.setItem('token', 't'); localStorage.setItem('user', JSON.stringify(u)); localStorage.setItem('soulia-push-prompt:1', 'dismissed'); }, me);
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (!p.startsWith('/api/')) return r.continue();
      if (r.method() === 'POST') posts.push([p, r.postData()]);
      const body = p === '/api/auth/me' ? me : p === '/api/auth/security/staff-password/allowed' ? { allowed: true }
        : p === '/api/auth/security/password/validate' ? { ok: true } : p === '/api/auth/security/account-email' ? { admin: true, required: false }
        : p === '/api/transactions/startup-overview' ? { rows: [], activeCount: 0 } : /\/(users|mentionable|tags|products|followups)$/.test(p) ? [] : p === '/api/roles' ? { roles: [], unassigned: [] } : {};
      r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.SouliaPassword && typeof openModal === 'function' && typeof currentUser !== 'undefined' && !!currentUser, { timeout: 30000 });
    await page.evaluate(() => SouliaPassword.openResetStaff({ _id: 'u9', username: 'Hassan', name: 'Hassan Ammar', role: 'staff' }));
    await page.waitForSelector('#pwp-next');
    ok(await page.$eval('#pwp-next', (b) => !b.disabled), 'generate mode: «متابعة» enabled');
    await page.click('input[name="pwp-mode"][value="manual"]');
    await page.waitForSelector('#pwp-new');
    ok(await page.$$eval('#pwp-next', (l) => l.length) === 1, 'one «متابعة» button');
    ok(await page.$eval('#pwp-next', (b) => b.disabled), 'manual mode: disabled while empty');
    await page.type('#pwp-new', 'Hassan#soulia2000');
    await page.type('#pwp-new2', 'Hassan#soulia200');
    ok(await page.$eval('#pwp-next', (b) => b.disabled), 'disabled while they differ');
    await page.type('#pwp-new2', '0');
    ok(await page.$eval('#pwp-match', (el) => /متطابقتان/.test(el.textContent)), 'match message');
    ok(await page.$eval('#pwp-next', (b) => !b.disabled), 'manual mode: «متابعة» enabled once both match');
    await page.click('#pwp-next');
    await new Promise((r) => setTimeout(r, 800));
    const v = posts.find(([p]) => p === '/api/auth/security/password/validate');
    ok(v && JSON.parse(v[1]).newPassword === 'Hassan#soulia2000' && JSON.parse(v[1]).userId === 'u9', 'click sends the typed password for checking');
    await page.click('input[name="pwp-mode"][value="generate"]').catch(() => {});
    ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
    console.log(`password-reset-manual: ${n} checks passed`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
