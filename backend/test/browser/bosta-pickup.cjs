const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
assert.ok(html.includes('onclick="openBostaPickup(this)"'));
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Browser error:', error.message));
    await page.setViewport({ width: 390, height: 844 });
    await page.setContent('<html dir="rtl"><body><div id="modal-content"></div></body></html>');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.addStyleTag({ path: path.join(publicDir, 'bosta-pickup.css') });
    await page.evaluate(() => {
      window.currentLang = 'ar'; window.qs = s => document.querySelector(s);
      window.esc = window.escHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      window.openModal = (html, style) => { qs('#modal-content').innerHTML = html; qs('#modal-content').className = 'modal'; qs('#modal-content').style.cssText = style; };
      window.closeModal = () => { qs('#modal-content').innerHTML = ''; };
      window.toast = message => { window.toastMessage = message; };
      window.orders = [{ id: '507f1f77bcf86cd799439011' }, { id: '507f1f77bcf86cd799439012' }];
      window.calls = []; window.requests = [];
      window.mockSchedule = { today: '2099-10-13', cutoffTime: '16:00', timezone: 'Africa/Cairo', earliestDate: '2099-10-13', dates: [
        { date: '2099-10-13', reason: '' }, { date: '2099-10-14', reason: '' },
        { date: '2099-10-16', reason: 'friday' }, { date: '2099-10-17', reason: 'holiday' }, { date: '2099-10-18', reason: '' },
      ] };
      window.api = async (url, options) => {
        if (url.startsWith('/shipping/pickup-schedule')) return JSON.parse(JSON.stringify(mockSchedule));
        if (url === '/settings') { window.savedPolicy = JSON.parse(options.body); return {}; }
        if (url.endsWith('pickup-preview')) return { orders, numberOfParcels: orders.length, requests };
        if (url.endsWith('pickup-locations')) { if (window.failLocations) throw new Error('Warehouse unavailable'); return [{ id: 'warehouse', name: '<Warehouse>', contactName: 'Contact', contactPhone: '01114701237' }]; }
        if (options?.method === 'POST') {
          calls.push(JSON.parse(options.body));
          if (window.fail) throw new Error('Date unavailable');
          if (window.failHoliday) {
            mockSchedule.dates.find(d => d.date === calls.at(-1).scheduledDate).reason = 'holiday';
            mockSchedule.earliestDate = '2099-10-18';
            const e = new Error('Holiday'); e.pickupReason = 'holiday'; throw e;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          requests = [{ scheduledDate: calls.at(-1).scheduledDate, numberOfParcels: 2, status: 'created', orderIds: orders.map(o => o.id), requestedBy: '<Mona>', createdAt: '2026-10-13T10:00:00Z', bostaPickupId: 'B-1' }]; orders = [];
          return { success: true, scheduledDate: calls.at(-1).scheduledDate, numberOfParcels: 2 };
        }
        throw new Error('Unexpected request');
      };
    });
    await page.addScriptTag({ path: path.join(publicDir, 'bosta-pickup.js') });
    await page.evaluate(() => openBostaPickup());
    assert.equal(await page.$eval('#bp-name', el => el.value), 'Contact');
    assert.equal(await page.$eval('#bp-location', el => el.textContent), '<Warehouse>');
    assert.equal(await page.$eval('#modal-content strong', el => el.textContent), '2');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.$eval('#bp-date option[value="2099-10-16"]', el => el.disabled), true);
    assert.equal(await page.$eval('#bp-date option[value="2099-10-17"]', el => el.disabled), true);
    assert.equal(await page.$eval('#bp-date', el => el.value), '2099-10-13');
    assert.ok((await page.$eval('#bp-schedule-hint', el => el.textContent)).includes('16:00'));
    // A form opened before cutoff must not submit today's pickup after cutoff.
    await page.evaluate(() => { mockSchedule.dates[0].reason = 'cutoff'; mockSchedule.earliestDate = '2099-10-14'; });
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#bp-date').value === '2099-10-14');
    assert.equal(await page.evaluate(() => calls.length), 0);
    assert.ok((await page.$eval('#bp-error', el => el.textContent)).includes('راجعه'));
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    await page.evaluate(() => { fail = true; }); await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#bp-error').textContent === 'Date unavailable');
    assert.equal(await page.$eval('button[type="submit"]', el => el.disabled), false);
    // An unannounced holiday returned by Bosta suggests a new date without auto-retrying.
    await page.evaluate(() => { fail = false; failHoliday = true; calls = []; });
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#bp-date').value === '2099-10-18');
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    assert.equal(await page.evaluate(() => calls.length), 1);
    assert.ok((await page.$eval('#bp-error', el => el.textContent)).includes('إجازة'));
    await page.evaluate(() => { failHoliday = false; });
    await page.evaluate(() => { fail = false; calls = []; const form = qs('#bosta-pickup-form'); submitBostaPickup(form); submitBostaPickup(form); });
    await page.waitForFunction(() => document.querySelector('#modal-content').textContent.includes('تم طلب الاستلام'));
    assert.ok(await page.$('.bp-success-icon svg'));
    assert.equal(await page.evaluate(() => calls.length), 1);
    const sent = await page.evaluate(() => calls[0]);
    assert.equal(sent.orderIds.length, 2); assert.equal(sent.businessLocationId, 'warehouse');
    assert.equal(sent.numberOfParcels, undefined);
    assert.equal(sent.scheduledDate, '2099-10-18');
    await page.evaluate(() => { currentLang = 'en'; }); await page.evaluate(() => openBostaPickup());
    assert.ok((await page.$eval('#modal-content', el => el.textContent)).includes('Pickup requested'));
    assert.ok((await page.$eval('.bp-history', el => el.textContent)).includes('<Mona>'));
    assert.equal(await page.$('.bp-history Mona'), null);
    assert.ok((await page.evaluate(() => bostaPickupCardBadge([{ _id: '507f1f77bcf86cd799439011' }]))).includes('Pickup requested'));
    assert.ok((await page.evaluate(() => bostaPickupCardBadge([{ _id: '507f1f77bcf86cd799439011' }, { _id: 'new' }]))).includes('(1/2)'));
    assert.equal(await page.evaluate(() => bostaPickupCardBadge([{ _id: 'new' }])), '');
    assert.ok(await page.evaluate(() => { _bpSetRequests([{ status: 'pending', orderIds: ['uncertain'], scheduledDate: '2099-10-18' }]); return bostaPickupCardBadge([{ _id: 'uncertain' }]).includes('awaiting confirmation'); }));
    assert.equal(await page.$('#bosta-pickup-form'), null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => { failLocations = true; });
    await page.evaluate(() => openBostaPickup());
    assert.ok((await page.$eval('.bp-history', el => el.textContent)).includes('<Mona>'));
    assert.ok((await page.$eval('#modal-content', el => el.textContent)).includes('Warehouse unavailable'));
    await page.evaluate(() => { failLocations = false; });
    await page.evaluate(() => {
      orders = [{ id: 'new' }]; mockSchedule.dates.forEach(d => d.reason = 'holiday'); mockSchedule.earliestDate = '';
    });
    await page.evaluate(() => openBostaPickup());
    assert.equal(await page.$eval('button[type="submit"]', el => el.disabled), true);
    assert.ok((await page.$eval('#bp-error', el => el.textContent)).includes('No dates available'));
    await page.evaluate(() => {
      closeModal(); document.body.insertAdjacentHTML('beforeend', '<div id="stg-bosta-pickup-policy"></div>');
      window.settings = {}; window.isAdmin = () => true; renderBostaPickupPolicy();
    });
    await page.$eval('#bp-holidays-setting', el => { el.value = '2026-02-31'; });
    await page.click('#stg-bosta-pickup-policy button[type="submit"]');
    assert.equal(await page.evaluate(() => window.savedPolicy), undefined);
    assert.ok((await page.$eval('#bp-policy-error', el => el.textContent)).includes('valid'));
    await page.$eval('#bp-holidays-setting', el => { el.value = '2026-10-17\n2026-10-18'; });
    await page.$eval('#bp-cutoff-setting', el => { el.value = '14:00'; });
    await page.click('#stg-bosta-pickup-policy button[type="submit"]');
    await page.waitForFunction(() => window.savedPolicy);
    assert.deepEqual(await page.evaluate(() => savedPolicy), { bostaPickupCutoffTime: '14:00', bostaPickupHolidayDates: ['2026-10-17', '2026-10-18'] });
    console.log('Bosta pickup browser checks passed: disabled Friday/holiday dates, cutoff while open, suggested-date review, no automatic retry, count, mobile, Arabic/English, saved requests and policy settings.');
  } finally { await browser.close(); }
})();
