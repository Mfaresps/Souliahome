/* The manager's bell card for «عربون بدون صورة تحويل»: the 4-digit code sits in the code box,
   followed by employee / order / client / amount / vault / reason. Also covers requests sent
   before the kind had its own sender, and the row in «سجل عمليات التحقق». Shipped index.html. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/deposit-noimage-otp');

const body = code => [
  `🔐 كود التحقق: ${code}`, 'طلب إضافة عربون بدون صورة تحويل يحتاج موافقتك', 'الموظف: Malak Abbas',
  'الأوردر: #3021', 'العميل: مروى عبد الحليم', 'المبلغ: EGP 300', 'الخزنة: فودافون كاش',
  'السبب: دفع كاش في المحل', `صالح حتى: ${new Date(Date.now() + 9 * 60000).toISOString()}`,
].join('\n');
// What the first build sent: the sentence first, under the discount sender.
const legacy = code => ['🧾 طلب إضافة عربون بدون صورة تحويل يحتاج موافقتك', `🔐 كود التحقق: ${code}`,
  'الموظف: Malak Abbas', 'الأوردر: #3021', 'العميل: مروى عبد الحليم', 'المبلغ: EGP 300', 'الخزنة: فودافون كاش',
  `صالح حتى: ${new Date(Date.now() + 9 * 60000).toISOString()}`].join('\n');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
        return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: '' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.setViewport({ width: 520, height: 900 });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    for (const lang of ['ar', 'en']) {
      const result = await page.evaluate((lang, fresh, old) => {
        currentLang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#login-page').style.display = 'none';
        qs('#splash-screen')?.remove();
        const mk = (id, fromName, text) => ({ id, txId: 'otp' + id, commentId: 0, fromName, commentText: text, read: false, ts: new Date().toISOString() });
        const html = _buildMentionCardHtml(mk('1', 'نظام عربون بدون صورة', fresh), 'nc-mention-card')
          + _buildMentionCardHtml(mk('2', 'نظام التحقق', old), 'nc-mention-card');
        document.getElementById('fx')?.remove();
        document.body.insertAdjacentHTML('beforeend', `<div id="fx" style="position:fixed;inset:16px;z-index:5000;background:var(--bg);overflow:auto;width:440px">${html}</div>`);
        const cards = [...document.querySelectorAll('#fx .nc-mention-card')];
        const row = { kind: 'deposit-no-image', txRef: '3021', client: 'مروى عبد الحليم', itemsTotal: 300, txType: 'فودافون كاش', txId: 'dr_1', status: 'used', requestReason: 'دفع كاش في المحل' };
        return {
          texts: cards.map(c => c.innerText),
          log: _otpDetailText(row), rows: _otpDetailRows(row, 0), hasDetail: !!_otpHasDetail(row),
          meta: otpKindMeta('deposit-no-image').label,
          option: !!document.querySelector('#otp-audit-kind option[value="deposit-no-image"]'),
        };
      }, lang, body('4821'), legacy('7390'));
      await page.screenshot({ path: path.join(out, `card-${lang}.png`), clip: { x: 0, y: 0, width: 480, height: 640 } });
      const [fresh, old] = result.texts;
      for (const [text, code] of [[fresh, '4821'], [old, '7390']]) {
        assert.match(text, new RegExp(code), `${lang}: the 4-digit code is shown`);
        assert.doesNotMatch(text, /كود تحقق خصم|Discount verification/, `${lang}: not labelled as a discount`);
        assert.match(text, /3021/); assert.match(text, /300/); assert.match(text, /مروى/);
      }
      assert.match(fresh, lang === 'ar' ? /عربون بدون صورة تحويل/ : /without transfer image/i);
      assert.match(fresh, lang === 'ar' ? /دفع كاش في المحل/ : /دفع كاش في المحل/);
      assert.equal(result.meta, 'عربون بدون صورة');
      assert.ok(result.option, 'filter option exists');
      assert.ok(result.hasDetail, 'row expands');
      assert.match(result.log, /3021/); assert.match(result.log, /سُجّل العربون/);
      assert.match(result.rows, /دفع كاش في المحل/);
    }
    // Exercise the unified inbox used by the bell, rather than only the old mentions renderer.
    await page.evaluate((fresh, old) => {
      document.getElementById('fx')?.remove();
      currentUser = { _id: '111111111111111111111111', role: 'admin', name: 'Manager' };
      qs('#app').style.display = '';
      window.testOtpId = '222222222222222222222222';
      window.testOrderId = '333333333333333333333333';
      window.testMentions = [
        { id: '444444444444444444444444', txId: testOtpId, fromName: 'نظام عربون بدون صورة', commentId: 0, commentText: fresh, read: false, ts: new Date().toISOString() },
        { id: '555555555555555555555555', txId: testOtpId, fromName: 'نظام التحقق', commentId: 0, commentText: old, read: false, ts: new Date().toISOString() },
      ];
      window.testOtp = { _id: testOtpId, otp: '0482', kind: 'deposit-no-image', editTxId: testOrderId, txRef: '3021', client: 'مروى عبد الحليم', itemsTotal: 300, txType: 'فودافون كاش', status: 'unused', attempts: 0, createdAt: new Date().toISOString(), requestReason: 'دفع كاش في المحل' };
      testMentions.forEach(m => { m.targetUserId = currentUser._id; });
      window.testCalls = []; window.testNavigation = []; window.testCopied = '';
      api = async (url, options = {}) => {
        testCalls.push({ url, method: options.method || 'GET' });
        if (url === '/discount-otp/record/' + testOtpId) return { ...testOtp };
        if (url === '/shopify/orders/detail/' + testOrderId) return { _id: testOrderId, ref: '3021' };
        if (url === '/notifications/read-state') return { ids: [] };
        if (url === '/discount-otp') return [{ ...testOtp }];
        if (url === '/mentions') return testMentions;
        return {};
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { testCopied = value; } } });
      _requirePageAccess = () => true;
      navigateTo = value => { testNavigation.push(value); currentPage = value; };
      openSpOrderPeek = async value => { window.testOpenedOrder = value; };
      refreshMentionsFromServer = async () => {};
      window.souliaHistoryNotifs = () => [];
      window.souliaRefreshNotificationHistory = async () => {};
      saveMentionNotifs(testMentions);
      window.souliaPushAppReady = true;
    }, body('0482'), legacy('7390'));
    for (const [lang, width] of [['ar', 390], ['en', 1440]]) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(lang => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        window.testOpenedOrder = ''; testNavigation.length = 0; saveMentionNotifs(testMentions);
        openNotifCenter();
      }, lang);
      await page.waitForSelector('#nc-main .notification-otp-copy');
      assert.deepEqual(await page.$$eval('#nc-main .notification-otp-code', nodes => nodes.map(n => n.textContent)), ['0482', '7390']);
      assert(await page.$eval('#nc-main .notification-otp-copy', e => e.getBoundingClientRect().height >= 44));
      await page.click('#nc-main .notification-otp-copy');
      await page.waitForFunction(() => testCopied === '0482');
      assert.equal(await page.evaluate(() => testOpenedOrder), '', 'copy does not open the order');
      // Keyboard activation on a nested copy button must not activate its parent notification.
      await page.focus('#nc-main .notification-otp-copy'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => testOpenedOrder), '');
      assert(await page.$eval('#nc-main', e => e.scrollWidth <= e.clientWidth + 1));
      await page.screenshot({ path: path.join(out, `inbox-${lang}-${width}.png`) });
      await page.click('#nc-main .nc-item-title');
      await page.waitForFunction(() => testOpenedOrder === testOrderId);
      assert.deepEqual(await page.evaluate(() => testNavigation), ['shopify-orders']);
      assert.equal(await page.evaluate(() => testCalls.some(c => c.url.startsWith('/transactions/'))), false);
      assert.equal(await page.evaluate(() => testCalls.some(c => c.url === '/shopify/orders/detail/' + testOrderId)), true, 'loads an order absent from the current list');
    }
    // Old notifications follow their persisted OTP-to-order link too, without using the OTP id as an order id.
    await page.evaluate(async () => { testOpenedOrder = ''; await onMentionNotifClick(testMentions[1].id, testOtpId, 0); });
    assert.equal(await page.evaluate(() => testOpenedOrder), await page.evaluate(() => testOrderId));
    // OS/push OTP notifications open this same order; other OTP kinds keep their verification-log destination.
    await page.evaluate(async () => { testOpenedOrder = ''; await souliaNavigateNotification('/?pushRecord=otp:' + testOtpId + '&pushType=otp'); });
    assert.equal(await page.evaluate(() => testOpenedOrder), await page.evaluate(() => testOrderId));
    await page.evaluate(() => {
      _otpAuditAllRows = [testOtp]; _otpAuditPage = 1; renderOtpTablePage();
    });
    assert.equal(await page.$$eval('#otp-audit-list .otp-audit-copy', nodes => nodes.length), 2, 'desktop and mobile verification records both offer copying');
    assert((await page.$eval('#otp-audit-list', e => e.textContent)).includes('0482'));
    await page.$eval('#otp-audit-list .otp-audit-order', e => e.click());
    await page.waitForFunction(() => testOpenedOrder === testOrderId);
    assert.deepEqual(errors, []);
    console.log('deposit no-image OTP card + log: passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
