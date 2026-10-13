const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
assert.ok(html.includes('id="notification-settings"')); assert.ok(html.includes('/manifest.webmanifest'));
const script = fs.readFileSync(path.join(publicDir, 'notification-settings.js'), 'utf8');
const previewDir = require('node:os').tmpdir();
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  let checks = 0;
  try {
    const page = await browser.newPage(); page.on('pageerror', e => console.error('UI error:', e.message)); page.on('console', m => console.log(m.text())); await page.setViewport({ width: 390, height: 844 });
    await page.setRequestInterception(true);
    page.on('request', req => req.respond({ status: 200, contentType: 'text/html', body: '<html lang="ar" dir="rtl"><body><div id="notif-panel"><div class="notif-header"></div></div><div id="page-settings" class="active"><section id="notification-settings"></section></div></body></html>' }));
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir, 'notification-settings.css'), 'utf8') });
    await page.evaluate(() => {
      window.currentUser = { role: 'admin' }; localStorage.setItem('token', 'fixture');
      window.currentLang = 'ar';
      window.state = { preferences: { enabled: true, deposit: true, comment: true, followup: true, order: true, deliveryProblem: true, delivered: true, mention: true, performance: true, otp: true, approval: true, shopifyChange: true, security: true }, allowedTypes: ['deposit', 'comment', 'followup', 'order', 'deliveryProblem', 'delivered', 'mention', 'performance', 'otp', 'approval', 'shopifyChange', 'security'], configured: true, publicKey: 'fixture', devices: 0 };
      window.api = async (url, options) => {
        if (window.failSave) throw new Error('fixture save failure');
        if (options?.method === 'PATCH') { const body = JSON.parse(options.body); if (body.employeeLanguage) state.employeeLanguage = body.employeeLanguage; else if (body.language) state.language = body.language; else Object.assign(state.preferences, body); }
        return JSON.parse(JSON.stringify(state));
      };
      window.permissionCalls = 0;
      Notification.requestPermission = async () => { permissionCalls++; return 'denied'; };
      navigator.serviceWorker.getRegistration = async () => null;
    });
    await page.addScriptTag({ content: script }); await page.waitForSelector('input[role="switch"]');
    assert.equal(await page.$$eval('input[role="switch"]', els => els.length), 13); checks++;
    await page.select('#push-employee-language', 'en'); await page.waitForFunction(() => state.employeeLanguage === 'en'); checks++;
    for (const category of ['otp', 'approval', 'shopifyChange', 'security']) {
      await page.click(`input[data-preference="${category}"]`);
      await page.waitForFunction(key => state.preferences[key] === false, {}, category); checks++;
      assert.equal(await page.evaluate(key => Object.entries(state.preferences).filter(([name]) => ['otp', 'approval', 'shopifyChange', 'security'].includes(name) && name !== key).every(([, enabled]) => enabled), category), true); checks++;
      await page.click(`input[data-preference="${category}"]`);
      await page.waitForFunction(key => state.preferences[key] === true, {}, category); checks++;
    }
    assert.equal(await page.evaluate(() => permissionCalls), 0); checks++;
    assert.equal(await page.$eval('[data-push-action="test"]', el => el.disabled), true); checks++;
    await page.click('input[aria-label="عربون جديد"]');
    await page.waitForFunction(() => state.preferences.deposit === false); checks++;
    await page.click('input[aria-label="تفعيل جميع الإشعارات"]'); await page.waitForFunction(() => state.preferences.enabled === false);
    await page.click('input[aria-label="تفعيل جميع الإشعارات"]'); await page.waitForFunction(() => state.preferences.enabled === true);
    assert.equal(await page.evaluate(() => state.preferences.deposit), false); checks++;
    await page.evaluate(() => { failSave = true; }); await page.click('input[aria-label="تعليق أو تعليق متابعة"]');
    await page.waitForFunction(() => document.getElementById('push-feedback').textContent.includes('fixture save failure'));
    assert.equal(await page.$eval('input[aria-label="تعليق أو تعليق متابعة"]', el => el.checked), true); checks++;
    await page.evaluate(() => { failSave = false; });
    await page.$$eval('button', buttons => buttons.find(b => b.textContent === 'تفعيل إشعارات هذا الجهاز').click());
    await page.waitForFunction(() => permissionCalls === 1); checks++;
    await page.waitForFunction(() => document.getElementById('push-feedback').textContent.includes('لم يتم منح')); checks++;
    await page.evaluate(() => {
      Notification.requestPermission = async () => 'granted';
      navigator.serviceWorker.register = async () => ({});
      Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve({ pushManager: {
        getSubscription: async () => null,
        subscribe: async () => { throw new DOMException('Registration failed - push service error', 'AbortError'); },
      } }) });
      state.publicKey = btoa(String.fromCharCode(...new Uint8Array(65))).replace(/=/g, '');
    });
    await page.click('[data-push-action="enable"]');
    await page.waitForFunction(() => document.getElementById('push-feedback').textContent.includes('تعذر تسجيل الجهاز')); checks++;
    assert.equal(await page.$eval('[data-push-action="test"]', el => el.disabled), true); checks++;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); checks++;
    await page.select('#push-language', 'en'); await page.waitForFunction(() => state.language === 'en'); checks++;
    await page.evaluate(() => { currentLang = 'en'; }); await page.waitForSelector('input[aria-label="New deposit"]');
    assert.equal(await page.$eval('#notification-settings', el => el.dir), 'ltr'); checks++;
    assert.ok((await page.$eval('#notification-settings', el => el.textContent)).includes('Notification settings')); checks++;
    await page.setViewport({ width: 1280, height: 900 });
    assert.equal(await page.$eval('.push-category-grid', el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2); checks++;
    await page.screenshot({ path: path.join(previewDir, 'soulia-push-settings-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); checks++;
    assert.equal(await page.$eval('.push-category-grid', el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1); checks++;
    await page.screenshot({ path: path.join(previewDir, 'soulia-push-settings-mobile.png'), fullPage: true });
    await page.evaluate(() => { currentLang = 'ar'; }); await page.waitForSelector('input[aria-label="إشارة إليك (منشن)"]');
    await page.screenshot({ path: path.join(previewDir, 'soulia-push-settings-mobile-ar.png'), fullPage: true });
    await page.click('input[aria-label="إشارة إليك (منشن)"]');
    await page.waitForFunction(() => state.preferences.mention === false); checks++;
    await page.evaluate(() => { state.configured = false; localStorage.setItem('token', 'unconfigured'); });
    await page.waitForFunction(() => document.querySelector('#push-device-status').dataset.state === 'unconfigured'); checks++;
    assert.equal(await page.$eval('[data-push-action="enable"]', el => el.disabled), false); checks++;
    assert.equal(await page.$eval('[data-push-action="test"]', el => el.disabled), true); checks++;
    const permissionCount = await page.evaluate(() => permissionCalls);
    await page.click('[data-push-action="enable"]');
    await page.waitForFunction(() => document.querySelector('#push-feedback').textContent.includes('الخادم')); checks++;
    assert.equal(await page.evaluate(() => permissionCalls), permissionCount); checks++;
    await page.evaluate(() => { state.configured = true; });
    await page.click('[data-push-action="enable"]');
    await page.waitForFunction(() => document.querySelector('#push-feedback').textContent.includes('جاهزة الآن')); checks++;
    assert.equal(await page.evaluate(() => permissionCalls), permissionCount); checks++;
    assert.equal(await page.$eval('[data-push-action="enable"]', el => el.disabled), false); checks++;
    await page.evaluate(() => { currentUser = { role: 'viewer' }; state.allowedTypes = ['comment', 'followup', 'order', 'deliveryProblem', 'delivered', 'mention']; localStorage.setItem('token', 'viewer'); });
    await page.waitForFunction(() => document.querySelectorAll('input[role="switch"]').length === 7); checks++;
    await page.click('#push-settings-shortcut'); await page.waitForFunction(() => document.querySelector('dialog').open); checks++;
    await page.evaluate(() => { currentUser = null; localStorage.removeItem('token'); });
    await page.waitForFunction(() => document.getElementById('notification-settings').hidden && !document.querySelector('dialog').open); checks++;
    console.log(`${checks} notification UI checks passed (mobile layout, toggles, master, save error, explicit permission, denial, role visibility).`);
  } catch (error) { console.error(`Failed after ${checks} checks`); throw error; } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
