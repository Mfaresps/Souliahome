/* Exercise the real case print action with local fixtures; no server or database writes. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'artifacts/after-sales-print');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.evaluate(() => {
      window.currentLang = 'en';
      window.currentUser = {_id:'print-operator',role:'admin'};
      window.currentPage = 'returns';
      window.isAdmin = () => true;
      window.testCase = {
        _id: 'print-case', originalRef: '2845', returnTxRef: 'RET-2845', client: 'MARWA MOHAMEDNAEL', phone: '01012345678', requestedBy: 'Customer care',
        requestKind: 'exchange', reason: 'customer-choice', createdAt: '2026-10-24T11:34:00Z',
        addressHint: { firstLine: 'مدينة نصر، القاهرة' },
        items: [{ name: 'Loop Runner', code: 'LOOP-01', qty: 1, price: 718.01, total: 718.01 }],
        exchangeItems: [{ name: 'المنتج البديل', code: 'NEW-01', qty: 1, price: 715, total: 715 }],
        workflow: {
          ref: 'AS-2026-000004', stage: 'requested', history: [], replacementRef: 'EX-2845',
          shipment: { trackingNumber: '9528380106' },
          quote: { credit: 718.01, replacement: 715, customerFee: 0, refundDue: 3.01, collectDue: 0 },
        },
      };
      window.api = async () => testCase;
      const open = window.open.bind(window);
      window.open = (...args) => {
        const popup = open(...args);
        popup.printCalls = 0;
        popup.print = () => popup.printCalls++;
        return popup;
      };
    });
    await page.addScriptTag({ path: path.join(root, 'frontend/public/after-sales.js') });

    async function print(lang, kind, mode = 'refund') {
      await page.evaluate(async ({ lang, kind, mode }) => {
        currentLang = lang;
        testCase.requestKind = kind;
        testCase.workflow.quote = kind === 'return'
          ? { credit: 718.01, replacement: 0, customerFee: 50, refundDue: 668.01, collectDue: 0 }
          : mode === 'collect'
            ? { credit: 718.01, replacement: 800, customerFee: 50, refundDue: 0, collectDue: 131.99 }
            : { credit: 718.01, replacement: 715, customerFee: 0, refundDue: 3.01, collectDue: 0 };
        testCase.workflow.refund = { amount: kind === 'return' ? 100 : 0, method: 'Instapay', reference: 'REFUND-2845' };
        testCase.workflow.collection = { amount: mode === 'collect' ? 30 : 0, method: 'Cash', reference: 'COLLECT-2845' };
        await AfterSales.open(testCase._id);
      }, { lang, kind, mode });
      const target = browser.waitForTarget(t => t.opener() === page.target());
      await page.click('[data-as-print]');
      const popup = await (await target).page();
      await popup.waitForFunction(() => window.printCalls === 1);
      assert.equal(await popup.$eval('html', e => e.dir), lang === 'ar' ? 'rtl' : 'ltr');
      assert.equal(await popup.$$eval('.items', e => e.length), kind === 'exchange' ? 2 : 1);
      assert.match(await popup.$eval('.shipping', e => e.textContent), /9528380106/);
      const expected = kind === 'return' ? '568.01' : mode === 'collect' ? '101.99' : '3.01';
      assert.match(await popup.$eval('.balance', e => e.textContent), new RegExp(expected.replace('.', '\\.')));
      await popup.setViewport({ width: mode==='mobile'?390:900, height: 1150 });
      await popup.emulateMediaType('print');
      assert.equal(await popup.$eval('.toolbar', e => getComputedStyle(e).display), 'none');
      assert.equal(await popup.$eval('.sheet',sheet=>sheet.scrollWidth<=sheet.clientWidth+1),true);
      const name = `${kind}-${lang}-${mode}`;
      const pdf=await popup.pdf({ path: path.join(output, `${name}.pdf`), preferCSSPageSize: true, printBackground: true });
      const pageCount=(Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
      const dimensions=await popup.$eval('.sheet',sheet=>({scale:sheet.dataset.printScale,height:sheet.getBoundingClientRect().height,layoutHeight:sheet.offsetHeight,scrollHeight:sheet.scrollHeight,pageHeight:sheet.parentElement.getBoundingClientRect().height}));
      assert.equal(pageCount,1,`${name}: the actual A4 PDF must contain one page ${JSON.stringify(dimensions)}`);
      assert(await popup.$eval('.sheet',sheet=>sheet.getBoundingClientRect().height<=277*96/25.4),`${name}: all invoice content fits the printable height`);
      assert.equal(await popup.$$eval('.items tbody tr',rows=>rows.length),await page.evaluate(kind=>testCase.items.length+(kind==='exchange'?testCase.exchangeItems.length:0),kind),'all products are retained');
      assert.match(await popup.$eval('.details',e=>e.textContent),/RET-2845/);
      assert.match(await popup.$eval('.payment-details',e=>e.textContent),/REFUND-2845/);
      const notes=await page.evaluate(()=>[testCase.reasonDetails,testCase.workflow.feeBasis,testCase.workflow.deliveryEvidence].filter(Boolean));
      if(notes.length){
        const printedNotes=await popup.$eval('.invoice-notes',e=>e.textContent);
        for(const note of notes)assert(printedNotes.includes(note),'notes and delivery evidence remain complete');
      }
      await popup.$eval('.print-page',e=>e.setAttribute('data-pdf-pages','1'));
      await (await popup.$('.print-page')).screenshot({path:path.join(output,`${name}-print.png`)});
      await popup.emulateMediaType('screen');
      await popup.setViewport({width:900,height:1150});
      await popup.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await popup.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
      assert.equal(await popup.$eval('.sheet', e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), true);
      assert.equal(await popup.$$eval('.sheet script,.sheet img', elements => elements.length), 0, 'customer and product text stays escaped');
      await popup.click('#print-invoice');
      assert.equal(await popup.evaluate(() => printCalls), 2);
      await popup.close();
    }
    for (const lang of ['ar', 'en']) {
      await print(lang, 'exchange');
      await print(lang, 'return');
      await print(lang, 'exchange', 'collect');
    }
    await print('ar','return','mobile');
    await page.evaluate(() => {
      testCase.items = Array.from({ length: 65 }, (_, i) => ({ name: `Long product ${i} <script>bad()</script>`, qty: 1, price: 10, total: 10 }));
      testCase.client = '<img src=x onerror=bad()>';
    });
    await print('ar', 'return', 'many-items');
    await print('en', 'return', 'many-items');
    await page.evaluate(()=>{
      testCase.client='عميل الاستبدال';
      testCase.items=Array.from({length:12},(_,i)=>({name:`منتج راجع ${i+1}`,code:`OLD-${i+1}`,qty:1,price:10,total:10}));
      testCase.exchangeItems=Array.from({length:12},(_,i)=>({name:`منتج بديل ${i+1}`,code:`NEW-${i+1}`,qty:1,price:10,total:10}));
      testCase.reasonDetails='تفاصيل الطلب كاملة بدون حذف. '.repeat(30);
      testCase.workflow.feeBasis='رسوم متفق عليها مع العميل. '.repeat(30);
      testCase.workflow.deliveryEvidence='Signed handover reference DELIVERY-2845';
      testCase.workflow.receivedAt='2026-10-25T10:00:00Z';
      testCase.workflow.replacementDeliveredAt='2026-10-26T10:00:00Z';
    });
    await print('ar','exchange','full-details');
    await print('en','exchange','full-details');
    await page.evaluate(()=>{
      testCase.items=Array.from({length:65},(_,i)=>({name:`Returned product ${i+1}`,code:`OLD-${i+1}`,qty:1,price:10,total:10}));
      testCase.exchangeItems=Array.from({length:65},(_,i)=>({name:`Replacement product ${i+1}`,code:`NEW-${i+1}`,qty:1,price:10,total:10}));
    });
    await print('ar','exchange','many-items');
    console.log('PASS: one-page A4 PDFs for Arabic/English return and exchange invoices, all products and notes retained, refund/collection balances, payment references, waybill and reprint.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
