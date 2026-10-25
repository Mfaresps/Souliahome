const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');
const extract = name => html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'))[0];
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><head>${[...html.matchAll(/<style[^>]*>[^]*?<\/style>/g)].map(m => m[0]).join('')}</head><body><div id="modal-overlay" class="modal-overlay"><div id="modal-content" class="modal"></div></div></body></html>`);
    await page.evaluate(source => {
      window.currentLang = 'en'; window.qs = selector => document.querySelector(selector);
      window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
      window.fmtN = String; window.t = String; window.hasPerm = () => true;
      window._invLogDateTime = value => String(value).replace('T', ' ').replace('Z', '');
      window._invLogTypeLabel = value => value; window._invLogNoteHtml = esc;
      window.INV_LOG_TYPE_BADGE = {}; window.SouliaWarehouses = { name: () => currentLang === 'en' ? 'Main warehouse' : 'المخزن الرئيسي' };
      window.inventoryLogCache = { items: [{ _id:'000000000000000000000001', productName:'Infinity runner', productCode:'Code 40',
        type:'Sale', movementId:'440995', qtyDelta:-1, qtyBefore:1, qtyAfter:0, by:'Fares', sourceTransactionRef:'2924' }] };
      window.openModal = markup => { qs('#modal-content').innerHTML = markup; qs('#modal-overlay').classList.add('active'); };
      window.closeModal = () => {};
      window.navigateTo = () => {}; window.showInvoiceDetail = id => { window.openedInvoice = id; };
      window.api = async () => ({ total:1, page:1, limit:30, items:[{
        unitId:'000000000000000000000004', manualCode:'U-0000-0001-7', barcode:'SU-000000000000000000000004', registeredAtReceipt:true,
        purchase:{ id:'000000000000000000000005', ref:'900016', date:'2026-10-20' },
        history:[{ action:'registered', date:'2026-10-20T01:10:00Z', toWarehouseCode:'MAIN' },
          { action:'shipped', date:'2026-10-24T10:40:00Z', fromWarehouseCode:'MAIN' }],
      }] });
      (0, eval)(source);
    }, extract('openInventoryMovementDetail') + '\n' + extract('loadInventoryMovementPieces'));
    const output = path.join(root, 'artifacts/inventory-movement-pieces');
    fs.mkdirSync(output, { recursive:true });
    for (const [width, lang] of [[1440,'en'], [390,'ar']]) {
      await page.setViewport({ width, height:900 });
      await page.evaluate(lang => { currentLang=lang; document.documentElement.dir=lang==='ar'?'rtl':'ltr'; openInventoryMovementDetail('000000000000000000000001'); }, lang);
      await page.waitForSelector('[data-piece-invoice]');
      const state = await page.evaluate(() => ({ text:qs('#modal-content').textContent, overflow:document.documentElement.scrollWidth > innerWidth,
        modalOverflow:qs('#modal-content').scrollWidth > qs('#modal-content').clientWidth }));
      assert(state.text.includes('900016')); assert(state.text.includes('U-0000-0001-7'));
      assert(state.text.includes('2026-10-24 10:40:00')); assert(!state.overflow); assert(!state.modalOverflow);
      await page.screenshot({ path:path.join(output, `movement-${width}-${lang}.png`) });
      await page.click('[data-piece-invoice]');
      assert.equal(await page.evaluate(() => openedInvoice), '000000000000000000000005');
    }
    console.log('Movement details passed at desktop and mobile sizes; source invoice link passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
