const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<span id="number">0</span>');
    await page.addScriptTag({ path: path.resolve(__dirname, '../../../frontend/public/animated-number.js') });
    const staticResult = await page.evaluate(() => {
      const element = document.querySelector('#number');
      AnimatedNumber.set(element, 1234, { duration: 0, decimals: 2, prefix: '$' });
      return { visible: element.querySelector('[aria-hidden]')?.textContent,
        accessible: element.querySelector('.animated-number-sr')?.textContent };
    });
    assert.deepEqual(staticResult, { visible: '$1,234.00', accessible: '$1,234.00' });

    await page.evaluate(() => AnimatedNumber.set(document.querySelector('#number'), 2000,
      { duration: 50, suffix: ' orders' }));
    await page.waitForFunction(() => document.querySelector('#number [aria-hidden]')?.textContent === '2,000 orders');

    await page.evaluate(() => {
      const element = document.querySelector('#number');
      AnimatedNumber.set(element, 3000, { duration: 700 });
      AnimatedNumber.set(element, 4000, { duration: 0 });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.$eval('#number [aria-hidden]', node => node.textContent), '4,000');

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => AnimatedNumber.set(document.querySelector('#number'), 5000));
    assert.equal(await page.$eval('#number [aria-hidden]', node => node.textContent), '5,000');
    await page.close();
    console.log('PASS: formatting, accessibility, animation completion, interruption, reduced motion.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
