const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/comment-reactions');
fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url()), file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://reactions.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/webp', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://reactions.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'ar'; document.documentElement.dir = 'rtl';
      currentUser = { _id: 'me', name: 'Fares', role: 'staff', perms: ['followups', 'shopify-orders'] };
      qs('#splash-screen')?.remove(); qs('#login-page').style.display = 'none'; qs('#app').style.display = 'block';
      users = [{ _id: 'me', name: 'Fares' }, { _id: 'malak', name: 'Malak Abbas' }];
      window.reactionRequests = []; window.reactionFailure = false; window.reactionToasts = [];
      toast = (message, error) => reactionToasts.push({ message, error });
      api = async (url, options) => {
        reactionRequests.push({ url, ...options });
        await new Promise(resolve => setTimeout(resolve, 60));
        if (reactionFailure) throw new Error('offline');
        const reaction = JSON.parse(options.body).reaction, commentId = url.split('/').at(-2);
        const target = url.startsWith('/followups/') ? followUps[0] : url.startsWith('/shopify/') ? _shopifyOrders[0] : transactions[0];
        const reactions = (target.commentReactions || []).filter(r => r.commentId === commentId && r.userId !== 'me');
        if (reaction) reactions.push({ commentId, userId: 'me', userName: 'Fares', reaction });
        return { commentId, reactions };
      };
      followUps = [{ _id: 'trail', orderRef: '2966', clientName: 'Salma Muhamed', reason: 'عملية تأكيد الطلب', comments: [
        { _id: 'c1', authorId: 'malak', authorName: 'Malak Abbas', text: 'ردت واتساب وهتحول الديبوزيت', createdAt: new Date().toISOString() },
      ], commentReactions: [{ commentId: 'c1', userId: 'other', userName: 'Salma <script>', reaction: 'applause' }] }];
      openFuCommentPopup('trail'); qs('#fu-comment-text').value = 'تعليق لسه بكتبه';
    });
    const host = '#fu-comment-thread .cmt-reactions';
    for (const [width, lang, dark] of [[390, 'ar', false], [320, 'ar', false], [1440, 'en', false], [390, 'ar', true]]) {
      await page.setViewport({ width, height: 850 });
      await page.evaluate(({ lang, dark }) => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.body.classList.toggle('dark-mode', dark); _fuRenderCommentThread();
      }, { lang, dark });
      await page.click(host + ' .cmt-reaction-add');
      assert.equal(await page.$$eval(host + ' .cmt-reaction-picker button', els => els.length), 6);
      assert(await page.$eval('.fu-thread-modal', el => el.scrollWidth <= el.clientWidth + 1));
      assert(await page.$eval(host + ' .cmt-reaction-picker', el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0));
      await page.screenshot({ path: path.join(output, `followup-${lang}-${width}${dark ? '-dark' : ''}.png`) });
      await page.keyboard.press('Escape');
      assert(await page.$eval('#fu-comment-popup', el => el.classList.contains('show')), 'Escape closes only the picker');
    }
    await page.click(host + ' .cmt-reaction-add');
    await page.$eval(host + ' .cmt-reaction-picker [data-reaction="applause"]', el => { el.click(); el.click(); });
    await page.waitForFunction(() => document.querySelector('.cmt-reaction-chip.is-mine'));
    assert.equal(await page.evaluate(() => reactionRequests.length), 1, 'Repeated taps only send once');
    assert.equal(await page.$eval(host + ' .cmt-reaction-chip', el => el.textContent.trim()), '👏2');
    assert.equal(await page.$eval('#fu-comment-text', el => el.value), 'تعليق لسه بكتبه');
    await page.click(host + ' .cmt-reaction-add'); await page.click(host + ' [data-reaction="strong"]');
    await page.waitForFunction(() => document.querySelector('.cmt-reaction-chip.is-mine')?.dataset.reaction === 'strong');
    await page.click(host + ' .cmt-reaction-chip.is-mine');
    await page.waitForFunction(() => !document.querySelector('.cmt-reaction-chip.is-mine'));
    assert.equal(await page.$eval(host + ' .cmt-reaction-chip', el => el.textContent.trim()), '👏1');
    await page.evaluate(() => { reactionFailure = true; });
    await page.click(host + ' .cmt-reaction-chip');
    await page.waitForFunction(() => reactionToasts.length);
    assert.equal(await page.$eval(host + ' .cmt-reaction-chip', el => el.disabled), false);
    assert.equal(await page.$eval(host + ' .cmt-reaction-chip', el => el.getAttribute('aria-pressed')), 'false');
    await page.evaluate(() => {
      reactionFailure = false;
      applyCommentReactionUpdate({ kind: 'followup', id: 'trail', commentId: 'c1', reactions: [
        { commentId: 'c1', userId: 'other', userName: 'Salma <script>', reaction: 'love' },
      ] });
    });
    assert.equal(await page.$eval(host + ' .cmt-reaction-chip', el => el.dataset.reaction), 'love');
    assert.equal(await page.$eval('#fu-comment-text', el => el.value), 'تعليق لسه بكتبه');
    await page.evaluate(() => {
      closeFuCommentPopup(); document.body.classList.remove('dark-mode');
      _shopifyOrders = [{ _id: 'order', ref: '2966', client: 'Salma', comments: [{ id: 123, employee: 'Malak Abbas', text: 'تم التأكيد', timestamp: new Date().toISOString() }] }];
      openShopifyCommentsModal('order'); qs('.sp-cmtwin textarea').value = 'Keep my Shopify draft';
    });
    await page.click('#sp-cmt-host .cmt-reaction-add'); await page.click('#sp-cmt-host [data-reaction="fire"]');
    await page.waitForFunction(() => document.querySelector('#sp-cmt-host .cmt-reaction-chip.is-mine'));
    assert.equal(await page.$eval('.sp-cmtwin textarea', el => el.value), 'Keep my Shopify draft');
    await page.screenshot({ path: path.join(output, 'shopify-mobile.png') });
    await page.evaluate(() => {
      transactions = [{ _id: 'tx', comments: [{ id: 123, employee: 'Malak', text: 'Ready', timestamp: new Date().toISOString() }] }];
      const fixture = document.createElement('div'); fixture.id = 'invoice-reaction-test';
      fixture.style.cssText = 'position:fixed;inset:0;z-index:99999999;background:var(--surface);padding:20px';
      fixture.innerHTML = buildInvCommentsSection(transactions[0]); document.body.append(fixture);
      fixture.querySelector('.inv-section-body').classList.add('expanded');
    });
    await page.$eval('#invoice-reaction-test .cmt-reaction-add', el => el.click());
    await page.$eval('#invoice-reaction-test [data-reaction="star"]', el => el.click());
    await page.waitForFunction(() => document.querySelector('#invoice-reaction-test .cmt-reaction-chip.is-mine'));
    assert((await page.evaluate(() => reactionRequests.at(-1).url)).startsWith('/transactions/tx/'));
    assert.deepEqual(errors, []);
    console.log('PASS: follow-up, Shopify and invoice reactions; change/remove, duplicates, errors, live updates, draft preservation, RTL/LTR, 320px layout, dark mode and keyboard.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
