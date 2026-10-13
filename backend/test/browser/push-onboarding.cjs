const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    async function fixture(userId, iphone = false, installed = false) {
      const page = await browser.newPage(); await page.setViewport({ width: 390, height: 844 });
      if (iphone) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
      else await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36');
      await page.setRequestInterception(true);
      page.on('request', r => r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html dir="rtl"><body><div id="page-settings"><section id="notification-settings"></section></div><div id="page-userhub"><button id="push-profile-shortcut" onclick="souliaOpenPushSettings()">الإشعارات</button></div><div id="notif-panel"><div class="notif-header"></div></div></body></html>' }));
      await page.goto('https://soulia.test/');
      await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir, 'notification-settings.css'), 'utf8') });
      await page.evaluate(({ userId, installed }) => {
        localStorage.clear(); localStorage.setItem('token', userId);
        window.currentUser = { role: 'staff', userId }; window.currentLang = 'ar'; window.souliaPushAppReady = true;
        window.permissionCalls = 0; window.subscriptionExists = false; window.permissionResult = 'granted'; window.activationAtRequest = false;
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = query => query === '(display-mode: standalone)' ? { matches: installed } : nativeMatchMedia(query);
        const publicKey = btoa(String.fromCharCode(...new Uint8Array(65).fill(4))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        window.state = { configured: true, preferences: { enabled: false, comment: true, followup: true, order: true, deliveryProblem: true, delivered: true, mention: true }, allowedTypes: ['comment','followup','order','deliveryProblem','delivered','mention'], language: 'ar', devices: 0, publicKey };
        window.requests = [];
        window.api = async (url, options) => {
          requests.push({ url, body: options?.body });
          if (options?.method === 'PATCH') Object.assign(state.preferences, JSON.parse(options.body));
          if (url === '/notifications/subscriptions' && options?.method === 'POST') state.devices = 1;
          return JSON.parse(JSON.stringify(state));
        };
        Notification.requestPermission = async () => { permissionCalls++; activationAtRequest = navigator.userActivation.isActive; return permissionResult; };
        const subscription = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/fixture', keys: { p256dh: 'fixture', auth: 'fixture' } }), unsubscribe: async () => { subscriptionExists = false; } };
        window.nativeConfirmations = [];
        const registration = { showNotification: async (title, options) => nativeConfirmations.push({ title, options }), pushManager: { getSubscription: async () => subscriptionExists ? subscription : null, subscribe: async () => { subscriptionExists = true; return subscription; } } };
        navigator.serviceWorker.getRegistration = async () => subscriptionExists ? registration : null;
        navigator.serviceWorker.register = async () => registration;
        Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(registration) });
      }, { userId, installed });
      await page.addScriptTag({ path: path.join(publicDir, 'notification-settings.js') });
      await page.waitForSelector('#push-onboarding[open]');
      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: 844 });
        const centered = await page.$eval('#push-onboarding', el => { const box = el.getBoundingClientRect(); return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2 && Math.abs(box.y + box.height / 2 - innerHeight / 2) < 2; });
        assert.ok(centered, 'Activation guide is centered on phone and desktop');
      }
      await page.setViewport({ width: 390, height: 844 });
      assert.ok((await page.$eval('#push-onboarding', el => el.textContent)).includes('STEP 01'));
      assert.ok((await page.$eval('#push-onboarding', el => el.textContent)).includes('STEP 02'));
      assert.equal(await page.evaluate(() => permissionCalls), 0, 'Opening the app must not request native permission automatically');
      return page;
    }
    const ignored = await fixture('staff-ignore');
    await ignored.click('#push-onboarding-later');
    assert.equal(await ignored.evaluate(() => localStorage.getItem('soulia-push-prompt:staff-ignore')), 'dismissed');
    await ignored.click('#push-profile-shortcut'); await ignored.waitForSelector('.push-settings-dialog:not(#push-onboarding)[open]');
    for (const width of [360, 1280]) {
      await ignored.setViewport({ width, height: 844 });
      const centered = await ignored.$eval('.push-settings-dialog:not(#push-onboarding)', el => { const box = el.getBoundingClientRect(); return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2 && Math.abs(box.y + box.height / 2 - innerHeight / 2) < 2 && box.width <= innerWidth; });
      assert.ok(centered, 'Settings dialog is centered and fits the viewport');
    }
    await ignored.setViewport({ width: 390, height: 844 });
    assert.equal(await ignored.$('#push-language'), null, 'Staff cannot change notification language');
    assert.equal(await ignored.$$eval('#notification-settings input[role="switch"]', els => els.length), 7);
    assert.equal(await ignored.$('#notification-settings input[aria-label="عربون جديد"]'), null);
    await ignored.click('[data-push-action="enable"]');
    await ignored.waitForFunction(() => state.preferences.enabled && state.devices === 1);
    await ignored.waitForFunction(() => nativeConfirmations.length === 1);
    assert.ok((await ignored.evaluate(() => nativeConfirmations[0].title)).includes('سوليا بنجاح'));
    await ignored.waitForFunction(() => document.querySelector('[data-push-action="enable"]').hidden);
    await ignored.evaluate(() => document.querySelector('[data-push-action="enable"]').click());
    assert.equal(await ignored.evaluate(() => nativeConfirmations.length), 1, 'Enabling an already active device must not repeat confirmation');
    assert.equal(await ignored.evaluate(() => activationAtRequest), true);
    assert.ok((await ignored.$eval('#push-feedback', el => el.textContent)).includes('تم تفعيل'));
    await ignored.close();

    const granted = await fixture('staff-home-screen', true, true);
    await granted.click('#push-onboarding-enable');
    await granted.waitForSelector('#push-onboarding-done');
    assert.equal(await granted.evaluate(() => permissionCalls), 1);
    assert.equal(await granted.evaluate(() => activationAtRequest), true);
    assert.equal(await granted.evaluate(() => localStorage.getItem('soulia-push-prompt:staff-home-screen')), 'enabled');
    assert.ok((await granted.$eval('#push-onboarding', el => el.textContent)).includes('تم تفعيل إشعارات سوليا بنجاح'));
    assert.equal(await granted.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await granted.click('#push-onboarding-done'); await granted.close();

    const iosBrowser = await fixture('staff-ios-browser', true, false);
    assert.ok((await iosBrowser.$eval('#push-onboarding', el => el.textContent)).includes('إضافة إلى الشاشة الرئيسية'));
    await iosBrowser.click('#push-onboarding-enable');
    await iosBrowser.waitForSelector('.push-settings-dialog:not(#push-onboarding)[open]');
    assert.equal(await iosBrowser.evaluate(() => permissionCalls), 0);
    await iosBrowser.close();

    const denied = await fixture('staff-denied'); await denied.evaluate(() => permissionResult = 'denied');
    await denied.click('#push-onboarding-enable');
    await denied.waitForFunction(() => document.querySelector('#push-onboarding-feedback').textContent.includes('لم يتم منح'));
    assert.equal(await denied.evaluate(() => state.devices), 0);
    assert.equal(await denied.evaluate(() => state.preferences.enabled), false);
    assert.equal(await denied.$eval('#push-onboarding-enable', el => el.disabled), false);
    await denied.close();
    console.log('Staff onboarding browser checks passed: first-open invitation, ignore/profile activation, explicit user gesture, iPhone Home Screen, iPhone browser installation help, permission denial, confirmation and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
