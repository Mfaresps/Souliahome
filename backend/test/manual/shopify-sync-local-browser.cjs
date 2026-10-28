// Full local application check. Browser POST/PUT/PATCH/DELETE requests are blocked.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const mongoose = require('mongoose'), puppeteer = require('puppeteer');
const { JwtService } = require('@nestjs/jwt');
const env = require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../../.env')));
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27018\/soulia(?:\?|$)/.test(env.MONGODB_URI || '')) throw new Error('Local database required');
(async () => {
  const db = await mongoose.createConnection(env.MONGODB_URI).asPromise(); let browser;
  try {
    const admin = await db.collection('users').findOne({ role: 'admin', isActive: { $ne: false } });
    const token = new JwtService({ secret: env.JWT_SECRET || 'soulia_jwt_default_secret' }).sign({ sub: String(admin._id), username: admin.username }, { expiresIn: '5m' });
    browser = await puppeteer.launch({ headless: true }); const page = await browser.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    await page.setViewport({ width: 1440, height: 980 });
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = new URL(r.url());
      if (['GET','HEAD','OPTIONS'].includes(r.method()) && ['localhost','127.0.0.1'].includes(url.hostname)) r.continue();
      else r.respond({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluateOnNewDocument((token, user) => { localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); }, token, { _id: String(admin._id), username: admin.username, name: admin.name, role: 'admin', perms: admin.perms || [] });
    await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof navigateTo === 'function' && typeof isAdmin === 'function' && isAdmin(), { timeout: 30000 });
    await page.evaluate(() => navigateTo('shopify-orders'));
    await page.waitForFunction(() => {const b=document.querySelector('#sp-sync-old');return b && !b.hidden;});
    await page.$eval('#sp-tools-menu', el => { el.open = true; });
    await page.waitForFunction(() => { const b=document.querySelector('#sp-sync-old'); const r=b.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === b; }, { timeout: 10000 });
    await page.click('#sp-sync-old');
    await page.waitForSelector('.ss-dialog[open] #ss-rows tr', { timeout: 30000 }).catch(async e => {
      console.error('Sync UI:', await page.evaluate(() => ({ message: document.querySelector('#ss-message')?.textContent, status: document.querySelector('#ss-status')?.textContent, open: !!document.querySelector('.ss-dialog[open]') })));
      console.error('Page errors:', pageErrors);
      throw e;
    });
    assert.ok(await page.$eval('#ss-status', el => el.textContent.includes('متوقفة') || el.textContent.includes('off')));
    const dir = path.resolve(__dirname, '../../../artifacts/shopify-sync'); fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'local-app-sync.png') });
    await page.click('[data-ss-action="close"]');
    await page.evaluate(() => { navigateTo('settings'); renderShopifySettings(); });
    await page.waitForSelector('#ss-auto');
    assert.equal(await page.$eval('#ss-auto', el => el.checked), false);
    const report = { fullLocalApp: true, headerButton: true, persistedStatusLoaded: true, settingsDefaultOff: true, browserWritesBlocked: true };
    fs.writeFileSync(path.join(dir, 'local-browser-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser?.close(); await db.close(); }
})().catch(e => { console.error(e.message); process.exitCode=1; });
