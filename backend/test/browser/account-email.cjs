// Employee account email (frontend/public/account-email.js). Real index.html over a mocked API.
// Needs the frontend dev server (TEST_ORIGIN, default http://127.0.0.1:8080).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const json = (r, status, body) => r.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function run(browser, { lang = 'ar', width = 1440, dark = false, role = 'staff', state, startPage = 'dashboard', users = [], plain = false }) {
  const page = await browser.newPage();
  const errors = [], calls = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width, height: 860 });
  const me = { id: '7', _id: '7', username: 'nour', name: 'Nour Adel', role, perms: ['dashboard'], isActive: true, onboardingPending: false, email: '', emailVerified: false };
  const S = { st: state, code: '482913' };
  await page.evaluateOnNewDocument((user, lang, dark) => {
    localStorage.setItem('token', 'ae-test');
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('soulia_lang_pref', lang);
    localStorage.setItem('soulia-push-prompt:7', 'dismissed');
    if (dark) localStorage.setItem('darkMode', 'true');
  }, me, lang, dark);
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith('/api/')) return r.continue();
    const body = (() => { try { return JSON.parse(r.postData() || '{}'); } catch { return {}; } })();
    if (path.startsWith('/api/auth/security/account-email')) calls.push([r.method(), path.replace('/api/auth/security/account-email', ''), body]);
    if (path === '/api/auth/me') return json(r, 200, me);
    if (path === '/api/auth/security/account-email' && r.method() === 'GET') return json(r, 200, S.st);
    if (path === '/api/auth/security/account-email/request') {
      if (body.email === 'taken@example.com') return json(r, 409, { message: 'x', code: 'EMAIL_TAKEN' });
      S.st = { ...S.st, pending: { email: body.email, codeLive: true, byAdmin: false, expiresAt: new Date(Date.now() + 300000).toISOString() } };
      return json(r, 201, { sentTo: body.email, expiresInMin: 5, resendIn: 60, state: S.st });
    }
    if (path === '/api/auth/security/account-email/confirm') {
      if (body.code !== S.code) return json(r, 400, { message: 'الرمز غير صحيح', code: 'CODE_WRONG', attemptsLeft: 4 });
      S.st = { ...S.st, email: S.st.pending.email, verifiedAt: new Date().toISOString(), pending: null, required: false };
      return json(r, 201, { success: true, email: S.st.email, state: S.st });
    }
    if (path.startsWith('/api/auth/security/account-email/user/')) return json(r, 201, { sentTo: body.email, expiresInMin: 2880, resendIn: 60 });
    if (path === '/api/users') return json(r, 200, users);
    if (path === '/api/roles') return json(r, 200, { roles: [], unassigned: [], canManage: true });
    if (path.startsWith('/api/security-audit/')) return json(r, 200, []);
    const fallback = path === '/api/transactions/startup-overview' ? { rows: [], activeCount: 0 } : !plain && /\/(mentionable|tags|products|followups)$/.test(path) ? [] : {};
    return json(r, 200, fallback);
  });
  await page.goto(origin + '/#' + startPage, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, errors, calls, S };
}

const base = (over = {}) => ({ email: '', verifiedAt: null, unverifiedEmail: '', pending: null, resendIn: 0, admin: false, securityEmail: '', required: true, mailConfigured: true, ...over });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  let n = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
  try {
    // 1. Staff without an email: the mandatory window, then code → done.
    {
      const { page, errors, calls } = await run(browser, { state: base({ unverifiedEmail: 'old@typed.com' }) });
      await page.waitForSelector('#ae-ov .sv-card #ae-email', { timeout: 25000 });
      ok(await page.$eval('#ae-title', (el) => el.textContent === 'أضف بريدك الإلكتروني'), 'mandatory window titled «أضف بريدك الإلكتروني»');
      ok(await page.$eval('#ae-email', (el) => el.value === 'old@typed.com'), 'an address typed before is offered');
      ok(!(await page.$('#ae-pass')), 'no password asked for the first address');
      ok(await page.$('[data-act="logout"]') && !(await page.$('[data-act="close"]')), 'only «تسجيل الخروج», no cancel');
      await page.keyboard.press('Escape'); await wait(200);
      ok(await page.$('#ae-ov'), 'Escape does not close the mandatory window');
      await page.$eval('#ae-email', (el) => { el.value = 'bad'; });
      await page.click('[data-act="send"]');
      ok(await page.$eval('#ae-err', (el) => !el.hidden && /غير صحيح/.test(el.textContent)), 'invalid address refused in place');
      ok(!calls.some((c) => c[1] === '/request'), 'nothing sent for an invalid address');
      await page.$eval('#ae-email', (el) => { el.value = 'taken@example.com'; });
      await page.click('[data-act="send"]'); await wait(300);
      ok(await page.$eval('#ae-err', (el) => /حساب آخر/.test(el.textContent)), 'address of another account refused');
      await page.$eval('#ae-email', (el) => { el.value = 'Nour@Example.com'; });
      await page.click('[data-act="send"]');
      await page.waitForSelector('#ae-otp');
      ok(await page.$eval('#ae-title', (el) => el.textContent === 'تحقق من بريدك الإلكتروني'), 'code step');
      ok(await page.$eval('.sv-sub bdi', (el) => el.textContent === 'nour@example.com'), 'states where the code went');
      ok(await page.$eval('.ae-spam', (el) => /Spam/.test(el.textContent) && /غير المرغوب/.test(el.textContent)), 'spam note shown');
      ok(await page.$eval('#ae-resend', (el) => el.disabled && /بعد \d+ ث/.test(el.textContent)), 'resend waits 60 s');
      await wait(200);
      ok(await page.evaluate(() => document.activeElement?.classList.contains('sv-otp-box')), 'focus in the first box: ' + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
      await page.keyboard.type('111111'); await wait(400);
      ok(await page.$eval('#ae-err', (el) => /تبقّت 4/.test(el.textContent)), 'wrong code → attempts left: ' + await page.$eval('#ae-err', (el) => el.hidden + '|' + el.textContent) + ' calls=' + JSON.stringify(calls.slice(-2)));
      await page.keyboard.type('482913'); await wait(500);
      await page.waitForSelector('.ae-done-ic');
      ok(await page.$eval('#ae-title', (el) => el.textContent === 'تم تأكيد بريدك الإلكتروني'), 'done step');
      ok(await page.evaluate(() => currentUser.email === 'nour@example.com' && currentUser.emailVerified === true), 'signed-in user now carries the email');
      await page.click('[data-act="finish"]'); await wait(200);
      ok(!(await page.$('#ae-ov')), 'window closes after done');
      ok(calls.filter((c) => c[1] === '/confirm').length === 2, 'two confirm calls (wrong, right)');
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    // 2. Not gated: an admin, and a staff member who already confirmed.
    for (const [label, opts] of [['admin', { role: 'admin', state: base({ admin: true, required: false }) }], ['confirmed staff', { state: base({ email: 'a@b.co', verifiedAt: new Date().toISOString(), required: false }) }]]) {
      const { page, errors } = await run(browser, opts);
      await wait(4500);
      ok(!(await page.$('#ae-ov')), `${label}: no mandatory window`);
      ok(errors.length === 0, `${label}: no page errors`);
      await page.close();
    }
    // 3. An address an admin already sent: straight to the code, says who sent it.
    {
      const { page } = await run(browser, { state: base({ pending: { email: 'nour@work.com', codeLive: true, byAdmin: true, requestedBy: 'Owner', expiresAt: new Date(Date.now() + 40 * 3600000).toISOString() } }) });
      await page.waitForSelector('#ae-otp', { timeout: 25000 });
      ok(await page.$eval('.sv-sub', (el) => /مدير النظام \(Owner\)/.test(el.textContent) && /48 ساعة/.test(el.textContent)), 'admin-sent code: who and 48 hours');
      await page.close();
    }
    // 4. «حسابي» card + change needs the password; English, dark, phone.
    {
      const { page, errors, calls } = await run(browser, { lang: 'en', dark: true, width: 390, startPage: 'userhub', state: base({ email: 'nour@example.com', verifiedAt: '2026-11-20T10:00:00Z', required: false }) });
      try { await page.waitForSelector('#uh-email-card .ae-chip.is-ok', { timeout: 25000 }); }
      catch (e) { console.log('DUMP', await page.evaluate(() => [currentPage, document.getElementById('uh-email-card')?.outerHTML.slice(0, 600)]), calls, errors); throw e; }
      ok(await page.$eval('#uh-email-card', (el) => /Confirmed/.test(el.textContent) && /nour@example.com/.test(el.textContent)), 'card shows the confirmed address');
      await page.click('#uh-email-card .uh-actions .uh-btn');
      await page.waitForSelector('#ae-ov #ae-pass');
      ok(await page.$eval('#ae-title', (el) => el.textContent === 'Change your email'), 'English change window');
      ok(await page.$eval('#ae-ov', (el) => el.dir === 'ltr'), 'English is LTR');
      ok(await page.$('[data-act="close"]'), 'change window can be cancelled');
      await page.$eval('#ae-email', (el) => { el.value = 'new@example.com'; });
      await page.click('[data-act="send"]');
      ok(await page.$eval('#ae-err', (el) => /current password/.test(el.textContent)), 'password required to change');
      const w = await page.$eval('#ae-ov .sv-card', (el) => el.getBoundingClientRect().width);
      ok(w <= 390 - 20, 'card fits a phone: ' + w);
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page overflow at 390');
      await page.keyboard.press('Escape'); await wait(200);
      ok(!(await page.$('#ae-ov')), 'Escape closes the optional window');
      ok(errors.length === 0, 'no page errors (en/dark/390): ' + errors.join(' | '));
      await page.close();
    }
    // 5. Users page (admin): status marks; user window sends a code for an employee.
    {
      const users = [
        { _id: 'a1', username: 'admin', name: 'Owner', role: 'admin', isActive: true, securityEmail: 'owner@soulia.co', securityEmailVerifiedAt: '2026-11-01' },
        { _id: 'u1', username: 'reem', name: 'Reem', role: 'staff', isActive: true, email: 'reem@soulia.co', emailVerifiedAt: '2026-11-02' },
        { _id: 'u2', username: 'mona', name: 'Mona', role: 'staff', isActive: true, emailPending: { email: 'mona@soulia.co', requestedBy: { name: 'Owner' } } },
        { _id: 'u3', username: 'sara', name: 'Sara', role: 'viewer', isActive: true },
      ];
      const { page, errors, calls } = await run(browser, { role: 'admin', state: base({ admin: true, required: false }), users });
      await page.waitForFunction(() => typeof openUserModal === 'function' && window.SouliaAccountEmail && Array.isArray(users) && users.length === 4, { timeout: 30000 });
      const tags = await page.evaluate(() => users.map((u) => /class="ae-tag ([a-z-]+)"/.exec(SouliaAccountEmail.statusHtml(u))?.[1] || ''));
      ok(tags.join(',') === 'is-ok,is-ok,is-wait,is-none', 'confirmed / waiting / none marks: ' + tags.join(','));
      await page.evaluate(() => openUserModal('u3'));
      await page.waitForSelector('#um-email-new');
      await page.$eval('#um-email-new', (el) => { el.value = 'Sara@Soulia.co'; });
      await page.click('#um-email-send'); await wait(500);
      ok(calls.some((c) => c[0] === 'POST' && c[1] === '/user/u3' && c[2].email === 'sara@soulia.co'), 'user window asks the server to send the code');
      await page.evaluate(() => closeModal());
      await page.evaluate(() => openUserModal(null));
      await page.waitForSelector('#um-email');
      ok(await page.$eval('#um-email', (el) => el.closest('.form-group').textContent.includes('أول تسجيل دخول')), 'new account: field explains the employee confirms it');
      ok(errors.length === 0, 'no page errors (users page): ' + errors.join(' | '));
      await page.close();
    }
    console.log(`account-email: ${n} checks passed`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
