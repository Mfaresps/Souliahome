const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

async function measure(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('#nc-overlay');
    const modal = overlay.querySelector('.nc-modal');
    const header = document.querySelector('#header');
    const rect = element => {
      const { x, width } = element.getBoundingClientRect();
      return { x, width };
    };
    return {
      rootWidth: document.documentElement.clientWidth,
      body: rect(document.body),
      header: rect(header),
      overlay: rect(overlay),
      modal: rect(modal),
      scrollWidth: document.documentElement.scrollWidth,
      visibility: getComputedStyle(overlay).visibility,
      transition: getComputedStyle(overlay).transitionDuration,
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const width of [390, 1440]) {
      for (const direction of ['rtl', 'ltr']) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 800 });
        await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof openNotifCenter === 'function');
        await page.evaluate(dir => {
          document.documentElement.dir = dir;
          document.body.style.minHeight = '1600px';
        }, direction);
        const before = await measure(page);
        await page.evaluate(() => openNotifCenter());
        await new Promise(resolve => setTimeout(resolve, 250));
        const open = await measure(page);
        assert.equal(open.visibility, 'visible', `${width}px ${direction}: notification page visible`);
        assert.notEqual(open.transition, '0s', `${width}px ${direction}: notification page animates`);
        assert.deepEqual(open.body, before.body, `${width}px ${direction}: body stays in place`);
        assert.deepEqual(open.header, before.header, `${width}px ${direction}: header stays in place`);
        assert.equal(open.rootWidth, before.rootWidth, `${width}px ${direction}: document width stays fixed`);
        assert.equal(open.scrollWidth, before.scrollWidth, `${width}px ${direction}: no horizontal expansion`);
        assert.ok(open.modal.width <= width, `${width}px ${direction}: modal fits viewport`);
        await page.evaluate(() => closeNotifCenter());
        await new Promise(resolve => setTimeout(resolve, 250));
        const closed = await measure(page);
        assert.equal(closed.visibility, 'hidden', `${width}px ${direction}: notification page hides`);
        assert.deepEqual(closed.body, before.body, `${width}px ${direction}: body stays in place on close`);
        assert.equal(closed.scrollWidth, before.scrollWidth, `${width}px ${direction}: no expansion on close`);
        await page.close();
      }
    }
    console.log('PASS: notifications open smoothly without resizing the page in RTL or LTR.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
