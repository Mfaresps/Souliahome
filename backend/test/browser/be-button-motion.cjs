const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer');

const script = path.resolve(__dirname, '../../../frontend/public/be-button-motion.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<button id="first" onclick="window.clicks=(window.clicks||0)+1">Save</button><button id="disabled" disabled>Disabled</button>');
    await page.addScriptTag({ path: script });
    const first = await page.$('#first');
    const box = await first.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pause(260);
    assert.ok(await page.evaluate(() => Math.abs(Number(getComputedStyle(document.querySelector('#first')).scale) - 1.01) < 0.005), 'Hover should scale subtly');
    await page.mouse.down();
    await pause(160);
    assert.ok(await page.evaluate(() => Math.abs(Number(getComputedStyle(document.querySelector('#first')).scale) - 0.97) < 0.005), 'Press should scale subtly');
    await page.mouse.up();
    await pause(260);
    assert.equal(await page.evaluate(() => window.clicks), 1, 'Original click handler should still run');
    const releaseState = await page.evaluate(() => ({ scale: getComputedStyle(document.querySelector('#first')).scale, hover: document.querySelector('#first').matches(':hover'), animations: document.querySelector('#first').getAnimations().length }));
    assert.ok(Math.abs(Number(releaseState.scale) - 1.01) < 0.005, `Release should restore subtle hover state: ${JSON.stringify(releaseState)}`);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'dynamic';
      button.textContent = 'New';
      document.body.appendChild(button);
    });
    const dynamic = await page.$('#dynamic');
    const dynamicBox = await dynamic.boundingBox();
    await page.mouse.move(dynamicBox.x + dynamicBox.width / 2, dynamicBox.y + dynamicBox.height / 2);
    await pause(260);
    assert.ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('#dynamic')).scale) > 1), 'Dynamic buttons should receive feedback');
    await page.mouse.down();
    await page.evaluate(() => { document.querySelector('#dynamic').disabled = true; });
    await page.mouse.up();
    await pause(260);
    assert.equal(await page.evaluate(() => Number(getComputedStyle(document.querySelector('#dynamic')).scale)), 1, 'Disabled during press should return to rest');
    await page.mouse.move(0, 0);
    await pause(260);
    await first.focus();
    await page.keyboard.down('Space');
    await pause(160);
    assert.ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('#first')).scale) < 1), 'Keyboard press should shrink the button');
    await page.keyboard.up('Space');
    await pause(260);
    assert.equal(await page.evaluate(() => window.clicks), 2, 'Keyboard activation should still run');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.className = 'btn'; link.id = 'link'; link.href = '#ok'; link.textContent = 'Open';
      document.body.appendChild(link);
      const input = document.createElement('input');
      input.type = 'button'; input.id = 'input-button'; input.value = 'Apply';
      document.body.appendChild(input);
    });
    for (const selector of ['#link', '#input-button']) {
      const control = await page.$(selector);
      const controlBox = await control.boundingBox();
      await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2);
      await pause(260);
      assert.ok(await page.evaluate(sel => Number(getComputedStyle(document.querySelector(sel)).scale) > 1, selector), `${selector} should receive hover feedback`);
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#disabled')).scale), 'none');
    assert.deepEqual(errors, []);

    const reduced = await browser.newPage();
    await reduced.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await reduced.setContent('<button id="quiet">Save</button>');
    await reduced.addScriptTag({ path: script });
    await reduced.click('#quiet');
    assert.equal(await reduced.evaluate(() => getComputedStyle(document.querySelector('#quiet')).scale), 'none', 'Reduced motion should skip scaling');
    console.log('PASS button motion: hover, press, keyboard, dynamic buttons, disabled and reduced motion');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
