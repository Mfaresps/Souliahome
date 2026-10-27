const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/followup-reminders');
fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(path.join(publicDir, 'followup-reminders.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'followup-reminders.css'), 'utf8');
const fixture = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><style>
body{margin:0;padding:28px;background:#f6f8fa;color:#182924;font-family:Arial,sans-serif;--surface:#fff;--text:#182924;--text-muted:#61766f}
body.dark{background:#101d19;--surface:#1b2c25;--text:#e9f3ed;--text-muted:#a3b7aa;color:var(--text)}
.btn{border:1px solid #cbd5d1;border-radius:9px;padding:10px;cursor:pointer;background:transparent;color:inherit}.btn-primary{background:#177352;color:#fff;border-color:#177352}
${css}</style><body><h2>متابعات العملاء</h2><p>تذكير الموظف بموعد التواصل مع العميل</p><script>
window.currentUser={_id:'employee'};window.currentLang='ar';window.fuCommentTargetId='';window.rows=[];window.tones=0;
window.api=async()=>rows;window._canAccessPage=()=>true;window._fuIsSettled=row=>row.status==='done';
window.escHtml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
window.myDeferReasonLabel=()=>currentLang==='en'?'Contact customer to confirm order':'إعادة التواصل لتأكيد الطلب';
window.openMyFollowUpTrail=async id=>{fuCommentTargetId=id};
const original=AudioContext.prototype.createOscillator;
AudioContext.prototype.createOscillator=function(){tones++;return original.call(this)};
</script><script>${source}</script></body></html>`;

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  async function newPage() {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: fixture }));
    await page.goto('http://localhost:43219/', { waitUntil: 'load' });
    return page;
  }
  try {
    const page = await newPage();
    console.log('Previewing reminder layouts');
    for (const [language, width, dark] of [['ar', 1440, false], ['ar', 390, false], ['en', 390, false], ['ar', 390, true]]) {
      await page.setViewport({ width, height: 850 });
      await page.evaluate(async ({ language, dark, width }) => {
        localStorage.clear(); souliaFollowUpReminder.reset(); currentLang = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; document.body.classList.toggle('dark', dark);
        await souliaFollowUpReminder.notify({ _id: language + width + dark, responsibleId: 'employee', orderRef: '2814', clientName: 'ملك عباس', deferReason: 'confirmation_contact', deferredUntil: new Date(Date.now() - 1000).toISOString() });
      }, { language, dark, width });
      await page.waitForFunction(() => tones >= 6);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.fu-reminder')).opacity === '1');
      const box = await page.$eval('.fu-reminder', element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: element.scrollWidth > element.clientWidth };
      });
      assert(box.left >= 0 && box.right <= box.width && box.bottom <= box.height && !box.overflow);
      await page.screenshot({ path: path.join(output, `${language}-${width}${dark ? '-dark' : ''}.png`) });
      await page.click('[data-open]');
      assert.equal(await page.$('.fu-reminder'), null);
    }
    const second = await newPage();
    console.log('Checking cross-tab claims');
    await page.evaluate(() => { localStorage.clear(); souliaFollowUpReminder.reset(); });
    const reminder = { _id: 'shared', responsibleId: 'employee', orderRef: '2815', deferredUntil: new Date(Date.now() - 1000).toISOString() };
    const claims = await Promise.all([page, second].map(tab => tab.evaluate(row => { rows = [row]; return souliaFollowUpReminder.notify(row); }, reminder)));
    assert.equal(claims.filter(Boolean).length, 1, 'only one tab claims the reminder');
    const winner = claims[0] ? page : second;
    await winner.bringToFront();
    console.log('Checking deadline and sound control');
    await winner.click('[data-dismiss]');
    await winner.evaluate(async () => {
      localStorage.setItem('soulia-followup-sound:employee', 'off');
      rows = [{ _id: 'scheduled', responsibleId: 'employee', orderRef: '2816', deferredUntil: new Date(Date.now() + 250).toISOString() }];
      souliaFollowUpReminder.sync(rows);
    });
    await winner.waitForSelector('.fu-reminder');
    assert((await winner.$eval('.fu-reminder-order', element => element.textContent)).includes('2816'));
    assert((await winner.$eval('[data-sound]', element => element.textContent)).match(/تشغيل|Enable/));
    const before = await winner.evaluate(() => tones);
    await winner.click('[data-sound]');
    await winner.waitForFunction(before => tones === before + 6, {}, before);
    assert.deepEqual(errors, []);
    console.log('Verified desktop/mobile RTL/LTR, dark mode, native six-note audio, open/dismiss, mute/enable, exact deadline and cross-tab deduplication.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
