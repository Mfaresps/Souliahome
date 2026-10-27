// Local QA only. Uses the browser already installed in the parent workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(path.resolve(__dirname, '../../backend/node_modules/puppeteer'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const failed = [];
  const requests = [];
  const report = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => failed.push(request.url()));
  page.on('request', (request) => requests.push(request.url()));
  try {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto('http://localhost:4173', { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await wait(1400);
    assert.equal(await page.evaluate(() => document.fonts.check('500 20px Cairo')), true);
    await page.screenshot({ path: path.join(__dirname, 'desktop-hero.png') });
    for (const width of [1440, 1024, 768, 600, 390, 360, 320]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await wait(150);
      const measure = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(measure.document <= width, `Horizontal overflow at ${width}: ${JSON.stringify(measure)}`);
      report.push({ width, noHorizontalOverflow: true });
    }
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.evaluate(() => document.querySelector('#features').scrollIntoView({ behavior: 'instant' }));
    await wait(1100);
    await page.screenshot({ path: path.join(__dirname, 'desktop-features.png') });
    for (let stage = 0; stage < 4; stage++) {
      await page.evaluate((index) => {
        const section = document.querySelector('#journey');
        const sticky = document.querySelector('.journey-sticky');
        window.scrollTo({ top: section.offsetTop + (section.offsetHeight - sticky.offsetHeight) * ((index + 0.3) / 4), behavior: 'instant' });
      }, stage);
      await wait(650);
      assert.equal(await page.$eval('.journey-step.active', (el) => Number(el.dataset.step)), stage);
      if (stage === 1) await page.screenshot({ path: path.join(__dirname, 'desktop-journey.png') });
    }
    report.push({ scrollStages: 'all four stages verified' });
    await page.click('.journey-step[data-step="0"]');
    await wait(1200);
    assert.equal(await page.$eval('.journey-step.active', (el) => el.dataset.step), '0');
    await page.click('.nav-cta');
    assert.equal(await page.$eval('dialog', (el) => el.open), true);
    await page.click('#tab-finance');
    assert.equal(await page.$eval('#demo-panel', (el) => el.getAttribute('aria-labelledby')), 'tab-finance');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.$eval('[role=tab][aria-selected=true]', (el) => el.dataset.tab), 'team');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('dialog', (el) => el.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.className), 'nav-cta');
    report.push({ dialog: 'open, tabs, RTL keyboard navigation, Escape, focus restoration passed' });
    await page.$eval('#faq', (el) => el.scrollIntoView({ behavior: 'instant' }));
    await wait(1100);
    await page.click('.faq-list details:first-child summary');
    await wait(100);
    assert.equal(await page.$$eval('.faq-list details[open]', (els) => els.length), 1);
    await page.click('.faq-list details:nth-child(2) summary');
    await wait(100);
    assert.equal(await page.$$eval('.faq-list details[open]', (els) => els.length), 1);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await wait(700);
    await page.screenshot({ path: path.join(__dirname, 'mobile-hero.png') });
    await page.click('.menu-toggle');
    assert.equal(await page.$eval('#mobile-nav', (el) => el.hidden), false);
    await page.click('#mobile-nav a');
    assert.equal(await page.$eval('#mobile-nav', (el) => el.hidden), true);
    await wait(1000);
    await page.screenshot({ path: path.join(__dirname, 'mobile-features.png') });
    await page.evaluate(() => {
      const section = document.querySelector('#journey');
      window.scrollTo({ top: section.offsetTop + 150, behavior: 'instant' });
    });
    await wait(700);
    await page.screenshot({ path: path.join(__dirname, 'mobile-journey.png') });
    const mobileStage = await page.$eval('.stage-bottom', (el) => el.getBoundingClientRect().bottom);
    assert.ok(mobileStage <= 844, `Mobile stage cut off at ${mobileStage}`);
    await page.click('.nav-cta');
    await page.screenshot({ path: path.join(__dirname, 'mobile-demo.png') });
    assert.ok(await page.$eval('dialog', (el) => el.getBoundingClientRect().right <= innerWidth));
    await page.keyboard.press('Escape');
    report.push({ mobile: 'navigation, sticky journey visibility, modal passed' });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.$eval('.journey-sticky', (el) => getComputedStyle(el).position), 'relative');
    await page.click('.journey-step[data-step="3"]');
    assert.equal(await page.$eval('.journey-step.active', (el) => el.dataset.step), '3');
    assert.equal(await page.$eval('.reveal', (el) => getComputedStyle(el).opacity), '1');
    report.push({ reducedMotion: 'no pinned scroll, content visible, manual stages work' });
    assert.equal(requests.some((url) => /^https?:/.test(url) && !url.startsWith('http://localhost:4173/')), false, 'Unexpected external request');
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    const result = { passed: true, report, browserErrors: errors, failedRequests: failed, externalRequests: 0 };
    fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
