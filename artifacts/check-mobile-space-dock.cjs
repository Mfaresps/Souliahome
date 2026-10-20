const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('../backend/node_modules/puppeteer');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
const dock = html.match(/<nav id="mobile-bottom-nav"[\s\S]*?<\/nav>/)[0].replace('style="display:none"', 'style="display:flex"');
(async () => {
  const browser = await puppeteer.launch({headless:true, pipe:true});
  try {
    const page = await browser.newPage();
    for (const width of [320, 390, 430, 768]) {
      await page.setViewport({width, height:844, isMobile:true, hasTouch:true});
      await page.setContent(`<html dir="rtl"><head><base href="http://localhost:8080/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><nav id="sidebar"></nav>${dock}<main id="main" style="min-height:2600px"><h2>SPACE · المعاملات</h2><p>محتوى الصفحة</p></main></body></html>`);
      await page.addStyleTag({path:path.join(root, 'frontend/public/navigation-shell.css')});
      await page.evaluate(() => {
        document.getElementById('mnav-movements').classList.add('active');
        document.getElementById('mnav-fab-icon').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 13a8 8 0 0 1 16 0v6h-4v-7h4M4 12v7H1v-7h3"/></svg>';
      });
      const measure = () => page.$eval('#mobile-bottom-nav', el => {
        const r = el.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,position:getComputedStyle(el).position,
          buttons:[...el.querySelectorAll('button')].map(b => {const r=b.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};})};
      });
      const before = await measure();
      assert.equal(before.position, 'fixed');
      assert(before.x >= 0 && before.right <= width);
      for (const b of before.buttons) assert(b.width >= 44 && b.height >= 44 && b.left >= before.x && b.right <= before.right);
      await page.evaluate(() => scrollTo(0, 1000));
      const after = await measure();
      assert.equal(after.y, before.y, 'Dock stays anchored during vertical scroll');
      assert.equal(after.x, before.x);
      await page.evaluate(() => {document.documentElement.dir='ltr';document.body.classList.add('dark-mode');});
      assert.equal((await measure()).y, before.y);
      if (width === 390) {
        await page.evaluate(() => {document.body.classList.remove('dark-mode');document.documentElement.dir='rtl';});
        await page.screenshot({path:path.join(__dirname,'mobile-space-dock.png')});
      }
    }
    await page.setViewport({width:1280,height:900,isMobile:true,hasTouch:true});
    assert.equal(await page.$eval('#mobile-bottom-nav', el => getComputedStyle(el).display), 'none');
    console.log('PASS: fixed mobile dock at 320/390/430/768px, 44px touch targets, scroll stability, RTL/LTR, dark mode, desktop hidden.');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
