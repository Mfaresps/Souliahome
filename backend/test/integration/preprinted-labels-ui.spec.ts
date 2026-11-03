import { createServer, Server } from 'http';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import * as QRCode from 'qrcode';
import { createHash } from 'crypto';

describe('Preprinted supplier labels in actual Chromium', () => {
  let browser: Browser, server: Server, page: Page, origin: string;
  const productId = '507f1f77bcf86cd799439011', invoiceId = '507f1f77bcf86cd799439022', batchId = '507f1f77bcf86cd799439033';
  let batches: any[], links: any[], issues: any[], prints: any[], productCatalog: any[];
  let failIssueOnce: boolean, failListOnce: boolean;
  let failLinkOnce: boolean, rejectLinkOnce: boolean, linkAttempts: any[];
  let optionLines: any[] | null;
  let bulkRows: any[] | null, bulkAttempts: any[], bulkResults: Map<string, any>, failBulkResponse: boolean;
  const publicDir = resolve(__dirname, '../../../frontend/public');
  const artifactDir = resolve(__dirname, '../../../artifacts/preprinted-labels');
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--primary:#14563f;--border:#dce6df;--surface:#fff;--text:#18392e;--muted:#66786d}body{font:14px Arial;background:#f5f7f6;padding:20px}input,select,textarea{width:100%;padding:8px 12px}</style><link rel="stylesheet" href="/supplier-labels.css"><link rel="stylesheet" href="/preprinted-labels.css"><link rel="stylesheet" href="/inventory-units.css"></head><body><button id="open-issue" onclick="PreprintedLabels.openIssue()">طباعة مسبقة</button><button id="open-link" onclick="PreprintedLabels.openLink('${invoiceId}')">ربط</button><div class="page" id="page-barcodes"></div><div id="label-check"></div><script>let currentLang='ar';function navigateTo(id,updateHash=true){if(updateHash)history.pushState(null,'','#'+id);document.getElementById('page-barcodes').classList.toggle('active',id==='barcodes');if(id==='barcodes')renderBarcodeManagement()}window.addEventListener('popstate',()=>renderBarcodeManagement());function hasPerm(){return true}async function api(path,options={}){const response=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const data=await response.json();if(!response.ok){const error=new Error(data.message);error.status=response.status;throw error}return data}</script><script src="/inventory-units.js"></script><script src="/preprinted-labels.js"></script><script src="/supplier-labels.js"></script></body></html>`;
  beforeAll(async () => {
    mkdirSync(artifactDir, { recursive: true });
    browser = await puppeteer.launch({ headless: true, timeout: 20000, ...(process.platform === 'win32' ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
    server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
      if (['/supplier-labels.js', '/supplier-labels.css', '/preprinted-labels.js', '/preprinted-labels.css', '/inventory-units.js', '/inventory-units.css', '/soulia-label-logo.svg'].includes(url.pathname)) {
        response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/css');
        response.end(readFileSync(publicDir + url.pathname)); return;
      }
      response.setHeader('Content-Type', 'application/json');
      let body = ''; for await (const chunk of request) body += chunk;
      const data = body ? JSON.parse(body) : null;
      if (url.pathname.startsWith('/api/inventory-units/prelabels/bulk/')) {
        if (!bulkRows) bulkRows = batches.flatMap((b, bi) => Array.from({ length: b.quantity }, (_, i) => ({
          unitId: (10000 * (bi + 1) + i).toString(16).padStart(24, '0'), batchId: b.batchId, ordinal: i + 1,
          printCount: b.printedOrdinals ? Number(b.printedOrdinals.includes(i + 1)) : Number(i < b.printed), linked: i < b.linked,
          productName: b.productName, sku: b.sku,
        })));
        const matching = bulkRows.filter(l => data.batchIds.includes(l.batchId));
        const selected = matching.filter(l => !l.linked && (data.mode === 'all-unused' || !l.printCount));
        const summary = data.batchIds.map((id: string) => { const b = batches.find(b => b.batchId === id), rows = selected.filter(l => l.batchId === id); return { ...b, printable: rows.length, reprints: rows.filter(l => l.printCount > 0).length }; });
        const hash = createHash('sha256').update(JSON.stringify([matching, data.mode, data.sizeId])).digest('hex');
        const size = { id: data.sizeId, widthMm: 50, heightMm: data.sizeId === '50x25' ? 25 : 30, qrMm: 17, marginMm: 1.5 };
        if (url.pathname.endsWith('/preview')) { response.end(JSON.stringify({ labels: selected, summary, selectionHash: hash, size, total: selected.length, reprints: selected.filter(l => l.printCount > 0).length, maxLabels: 1000 })); return; }
        if (url.pathname.endsWith('/labels')) {
          const labels = await Promise.all(selected.map(async (l,i) => ({...l,barcode:'SU-'+l.unitId.toUpperCase(),manualCode:'U-0000-'+String(i+1).padStart(4,'0')+'-8',svg:await QRCode.toString('SU-'+l.unitId.toUpperCase(),{type:'svg',margin:4})})));
          response.end(JSON.stringify({size,labels,selectionHash:hash})); return;
        }
        bulkAttempts.push(data);
        if (bulkResults.has(data.operationKey)) { response.end(JSON.stringify(bulkResults.get(data.operationKey))); return; }
        if (data.selectionHash !== hash || (!data.allowReprint && selected.some(l => l.printCount > 0))) { response.statusCode = 409; response.end(JSON.stringify({ message: 'Review changed' })); return; }
        const labels = await Promise.all(selected.map(async (l, i) => {
          l.printCount++;
          const barcode = 'SU-' + l.unitId.toUpperCase();
          return { ...l, barcode, manualCode: 'U-0000-' + String(i + 1).padStart(4,'0') + '-8', svg: await QRCode.toString(barcode, { type: 'svg', margin: 4 }) };
        }));
        const result = { size, labels, summary }; bulkResults.set(data.operationKey, result);
        if (failBulkResponse) { failBulkResponse = false; response.statusCode = 503; response.end(JSON.stringify({ message: 'Lost print response' })); return; }
        response.end(JSON.stringify(result)); return;
      }
      if (url.pathname === '/api/products') response.end(JSON.stringify(productCatalog));
      else if (url.pathname === '/api/inventory-units/config') response.end(JSON.stringify({ labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25, qrMm: 17, marginMm: 1.5 }, { id: '50x30', widthMm: 50, heightMm: 30, qrMm: 18, marginMm: 1.5 }] }));
      else if (url.pathname === '/api/inventory-units/prelabels/batches' && request.method === 'POST') {
        if (failIssueOnce) { failIssueOnce = false; issues.push(data); response.statusCode = 503; response.end(JSON.stringify({ message: 'Temporary issue failure' })); return; }
        issues.push(data); batches.unshift({ batchId, productId, sku: 'BASKET-1', productName: 'Basket', quantity: data.quantity, unused: data.quantity, linked: 0,
          printed: 0, printRequests: 0, createdAt: '2026-11-03T10:00:00Z', createdBy: 'Receiver', source: 'internal-prepurchase' });
        response.end(JSON.stringify({ batchId, quantity: data.quantity }));
      } else if (url.pathname === '/api/inventory-units/prelabels/batches/page') {
        if (failListOnce) { failListOnce = false; response.statusCode = 503; response.end(JSON.stringify({ message: 'Temporary list failure' })); return; }
        const page = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 12), q = (url.searchParams.get('q') || '').toLowerCase();
        const filtered = batches.filter(batch => !q || `${batch.productName} ${batch.sku} ${batch.batchId}`.toLowerCase().includes(q));
        response.end(JSON.stringify({ batches: filtered.slice((page - 1) * limit, page * limit), page, limit,
          total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / limit)) }));
      } else if (url.pathname === '/api/inventory-units/prelabels/batches') response.end(JSON.stringify(batches));
      else if (url.pathname === '/api/inventory-units/prelabels/lookup') {
        const identifier = url.searchParams.get('identifier') || '';
        if (identifier === 'INVALID') { response.statusCode = 404; response.end(JSON.stringify({ message: 'QR label not found' })); return; }
        const ordinal = Number(identifier.match(/(\d{2})$/)?.[1] || 44) - 40;
        response.end(JSON.stringify({ batchId, batchQuantity: 10, sku: identifier === 'WRONG-PRODUCT' ? 'OTHER' : 'BASKET-1',
          productId, productName: 'Basket', ordinal, state: links.some(link => link.start === ordinal) ? 'linked' : 'unused',
          printCount: identifier === 'NOT-PRINTED' ? 0 : 1 }));
      }
      else if (url.pathname.endsWith('/range')) response.end(JSON.stringify({ labels: Array.from({ length: Number(url.searchParams.get('quantity') || 1) }, (_, index) => ({
        unitId: '507f1f77bcf86cd7994390' + String(40 + index), state: 'unused', printCount: batches[0].printed ? 1 : 0,
      })) }));
      else if ((url.pathname.endsWith('/print') || url.pathname.endsWith('/preview')) && request.method === 'POST') {
        const preview = url.pathname.endsWith('/preview');
        if(!preview) { prints.push(data); batches[0].printed += data.quantity; batches[0].printRequests++; }
        const size = data.sizeId === '50x25' ? { id: '50x25', widthMm: 50, heightMm: 25, qrMm: 17, marginMm: 1.5 } : { id: '50x30', widthMm: 50, heightMm: 30, qrMm: 18, marginMm: 1.5 };
        const labels = await Promise.all(Array.from({ length: data.quantity }, async (_, index) => {
          const unitId = '507f1f77bcf86cd7994390' + String(40 + index), barcode = 'SU-' + unitId.toUpperCase();
          return { unitId, barcode, manualCode: index ? 'U-0000-0002-6' : 'U-0000-0001-8', batchId, ordinal: data.start + index,
            printCount: Number(batches[0].printed > 0), productName: batches[0].productName, sku: batches[0].sku, svg: await QRCode.toString(barcode, { type: 'svg', margin: 4 }) };
        }));
        response.end(JSON.stringify({ size, labels, selectionHash: 'a'.repeat(64) }));
      }
      else if (/^\/api\/inventory-units\/prelabels\/batches\/[a-f\d]{24}$/i.test(url.pathname)) {
        const batch = batches.find(row => row.batchId === url.pathname.split('/').pop());
        if (!batch) { response.statusCode = 404; response.end(JSON.stringify({ message: 'Batch not found' })); return; }
        const linkedPurchases = links.length ? [{ transactionId: invoiceId, ref: 'P-100', supplier: 'Supplier',
          invoiceDate: '2026-11-03', lastLinkedAt: '2026-11-03T11:00:00Z', quantity: batch.linked }] : [];
        response.end(JSON.stringify({ batch, linkedPurchases, linkedPurchasePage: 1, linkedPurchaseLimit: 20,
          linkedPurchaseTotal: linkedPurchases.length }));
      }
      else if (url.pathname === `/api/inventory-units/purchases/${invoiceId}/prelabels/options`) response.end(JSON.stringify({
        receipt: { transactionId: invoiceId, ref: 'P-100', supplier: 'Supplier', cancelled: false,
          lines: optionLines || [{ lineIndex: 0, sku: 'BASKET-1', name: 'Basket', quantity: 10, createdUnits: batches[0]?.linked || 0 }] }, batches }));
      else if (url.pathname.endsWith('/prelabels/link')) {
        linkAttempts.push(data);
        if (failLinkOnce) { failLinkOnce = false; response.statusCode = 503; response.end(JSON.stringify({ message: 'Temporary receiving failure' })); return; }
        if (rejectLinkOnce) { rejectLinkOnce = false; response.statusCode = 409; response.end(JSON.stringify({ message: 'This label cannot be linked' })); return; }
        links.push(data); batches[0].unused -= data.quantity; batches[0].linked += data.quantity;
        response.end(JSON.stringify({ linked: data.quantity, status: data.inspectionPassed ? 'available' : 'inspection-required', unitIds: ['507f1f77bcf86cd799439044'] }));
      } else { response.statusCode = 404; response.end(JSON.stringify({ message: 'Unknown test endpoint' })); }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 30000);
  beforeEach(async () => {
    bulkRows = null; bulkAttempts = []; bulkResults = new Map(); failBulkResponse = false;
    failIssueOnce = false; failListOnce = false; failLinkOnce = false; rejectLinkOnce = false; linkAttempts = [];
    optionLines = null;
    productCatalog = [{ _id: productId, name: 'Basket', code: 'BASKET-1', isActive: true }];
    batches = [{ batchId, productId, sku: 'BASKET-1', productName: 'Basket', quantity: 10, unused: 10, linked: 0,
      printed: 10, printRequests: 1, lastPrintRequestedAt: '2026-11-03T08:30:00Z', createdAt: '2026-11-03T08:00:00Z',
      createdBy: 'Receiver', source: 'internal-prepurchase' }]; links = []; issues = []; prints = [];
    page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900 }); await page.goto(origin);
    await page.evaluate(id => localStorage.removeItem('soulia_supplier_batch_cover:' + id), batchId);
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); await new Promise<void>(done => server.close(() => done())); });
  async function capturePrints() {
    await page.evaluate(() => { (window as any).__bulkWindows=0; window.open=()=>{ (window as any).__bulkWindows++; return null; }; });
  }
  async function readyPreview() {
    await page.waitForFunction(() => {
      const status=document.querySelector('#slp-status');
      return status?.getAttribute('data-error')==='true' || status?.textContent?.includes('المعاينة وحدها') || status?.textContent?.includes('نفس الطلب دون');
    });
    expect(await page.$eval('#slp-status',el=>el.getAttribute('data-error'))).toBe('false');
    await page.$eval('#slp-frame',(frame: HTMLIFrameElement)=>{
      frame.contentWindow!.print=()=>{
        (window as any).__bulkPrinted=frame.contentDocument!.querySelectorAll('.iu-label:not(.iu-label-batch-cover)').length;
        (window as any).__printedSheets=frame.contentDocument!.querySelectorAll('.slp-paper').length;
        (window as any).__printedLabels=frame.contentDocument!.body.innerText;
      };
    });
  }
  it('selects across pages and prints only unprinted gaps from several batches in one window', async () => {
    const seed = batches[0];
    batches = Array.from({length:13}, (_,i) => ({ ...seed, batchId: String(i + 1).padStart(24,'0'), productName: 'Ribbon Storage', quantity: 5, unused: 5, printed: 2, printedOrdinals: [2,4] }));
    await capturePrints();
    await page.click('#open-issue'); await page.waitForSelector('[data-select-batch]');
    await page.click('[data-select-batch]'); await page.click('#sl-next');
    await page.waitForFunction(() => document.querySelectorAll('[data-select-batch]').length === 1);
    await page.click('[data-select-batch]'); await page.click('#sl-review-print');
    await page.waitForSelector('.sl-bulk-rows article');
    expect(await page.$$('.sl-bulk-rows article')).toHaveLength(2);
    expect(await page.$eval('#sl-bulk-mode', (e: HTMLSelectElement) => e.value)).toBe('unprinted');
    expect(await page.$('#sl-reprint-confirm')).toBeNull();
    await page.click('#sl-bulk-print'); await readyPreview(); expect(bulkAttempts).toHaveLength(0);
    const sheets = await page.$eval('#slp-frame',(f:HTMLIFrameElement)=>[...f.contentDocument!.querySelectorAll('.slp-paper')].map(el=>({
      batch:el.getAttribute('data-batch-cover'),count:el.querySelector('.iu-cover-count b')?.textContent,code:el.querySelector('.iu-cover-top code')?.textContent,
      batchNumber:el.querySelector('.iu-cover-batch-number')?.textContent,
    })));
    expect(sheets).toHaveLength(8);
    expect(sheets[0]).toMatchObject({batch:batches[0].batchId,count:'3',code:expect.stringMatching(/^B-[A-Z0-9]{6}$/),batchNumber:batches[0].batchId.slice(-8).toUpperCase()});
    expect(sheets[4]).toMatchObject({batch:batches[12].batchId,count:'3',code:expect.stringMatching(/^B-[A-Z0-9]{6}$/),batchNumber:batches[12].batchId.slice(-8).toUpperCase()});
    expect(sheets.filter(s=>s.batch)).toHaveLength(2);
    const paper = await browser.newPage();
    try {
      await paper.setContent(await page.$eval('#slp-frame',(f:HTMLIFrameElement)=>f.contentDocument!.documentElement.outerHTML),{waitUntil:'networkidle0'});
      const pdf=await paper.pdf({preferCSSPageSize:true,printBackground:true});
      const boxes=[...Buffer.from(pdf).toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
      expect(boxes).toHaveLength(8);
      for(const box of boxes) {expect(Math.abs(Number(box[1])-50*72/25.4)).toBeLessThan(.6);expect(Math.abs(Number(box[2])-25*72/25.4)).toBeLessThan(.6);}
      writeFileSync(resolve(artifactDir,'supplier-batch-separators.pdf'),pdf);
    } finally {await paper.close();}
    await page.screenshot({path:resolve(artifactDir,'supplier-batch-separators.png')});
    await page.click('#slp-print'); await page.waitForFunction(() => (window as any).__bulkPrinted === 6);
    expect(await page.evaluate(()=>(window as any).__printedSheets)).toBe(8);
    expect(bulkAttempts).toHaveLength(1); expect(bulkAttempts[0].allowReprint).toBe(false);
    expect(await page.evaluate(() => (window as any).__bulkWindows)).toBe(0);
    const result = [...bulkResults.values()][0];
    expect(result.labels.map((l: any) => l.ordinal)).toEqual([1,3,5,1,3,5]);
    await page.click('#slp-close');
    await page.waitForFunction(() => (document.querySelector('#sl-bulk-print') as HTMLButtonElement)?.disabled);
    expect(bulkRows!.filter(l => bulkAttempts[0].batchIds.includes(l.batchId)).every(l => l.printCount === 1)).toBe(true);
  },20000);
  it('requires explicit reprint confirmation and retries an uncertain response without a second print record', async () => {
    await capturePrints(); failBulkResponse = true;
    await page.click('#open-issue'); await page.waitForSelector('[data-select-batch]');
    await page.click('#sl-select-page'); await page.click('#sl-review-print');
    await page.waitForSelector('.sl-bulk-rows article');
    expect(await page.$eval('#sl-bulk-print',(e: HTMLButtonElement)=>e.disabled)).toBe(true);
    await page.select('#sl-bulk-mode','all-unused'); await page.waitForSelector('#sl-reprint-confirm');
    expect(await page.$eval('#sl-bulk-print',(e: HTMLButtonElement)=>e.disabled)).toBe(true);
    await page.click('#sl-reprint-confirm'); await page.click('#sl-bulk-print'); await readyPreview(); await page.click('#slp-print');
    await page.waitForFunction(() => document.querySelector('#slp-status')?.textContent?.includes('Lost print response'));
    expect(await page.$eval('#slp-size',(e: HTMLSelectElement)=>e.disabled)).toBe(true);
    await page.click('#slp-close'); await page.waitForSelector('#sl-bulk-print');
    await page.click('#sl-bulk-print'); await readyPreview(); await page.click('#slp-print');
    await page.waitForFunction(() => (window as any).__bulkPrinted === 10);
    expect(bulkAttempts).toHaveLength(2); expect(bulkAttempts[0].operationKey).toBe(bulkAttempts[1].operationKey);
    expect(bulkResults.size).toBe(1); expect(bulkRows!.every(l => l.printCount === 2)).toBe(true);
  },20000);
  it('reopens an uncertain unprinted-only preview even after all its labels have been recorded', async () => {
    batches[0].printed=0; failBulkResponse=true;
    await page.click('#open-issue'); await page.waitForSelector('[data-select-batch]');
    await page.click('#sl-select-page'); await page.click('#sl-review-print'); await page.waitForSelector('.sl-bulk-rows article');
    await page.click('#sl-bulk-print'); await readyPreview(); await page.click('#slp-print');
    await page.waitForFunction(()=>document.querySelector('#slp-status')?.textContent?.includes('Lost print response'));
    await page.click('#slp-close'); await page.waitForSelector('#sl-bulk-print:not(:disabled)');
    await page.click('#sl-bulk-print'); await readyPreview(); await page.click('#slp-print');
    await page.waitForFunction(()=>(window as any).__bulkPrinted===10);
    expect(bulkAttempts).toHaveLength(2);
    expect(bulkAttempts[0].operationKey).toBe(bulkAttempts[1].operationKey);
    expect(bulkRows!.every(l=>l.printCount===1)).toBe(true);
  },20000);
  it('changes preview size and zoom without recording prints, and restores focus when closed', async () => {
    batches[0].printed=0;
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]'); await page.click('[data-batch]'); await page.waitForSelector('#sl-print');
    await page.click('#sl-print'); await readyPreview();
    await page.select('#slp-size','50x30');
    await page.waitForFunction(()=>document.querySelector('#slp-summary')?.textContent?.includes('30'));
    await page.select('#slp-zoom','2');
    expect(await page.$eval('#slp-frame',(f:HTMLIFrameElement)=>f.contentDocument!.body.style.zoom)).toBe('2');
    await page.emulateMediaType('print');
    expect(await page.$eval('#slp-frame',(f:HTMLIFrameElement)=>f.contentWindow!.getComputedStyle(f.contentDocument!.body).zoom)).toBe('1');
    await page.emulateMediaType('screen');
    expect(prints).toHaveLength(0);
    await page.keyboard.press('Escape'); await page.waitForSelector('#sl-print-preview',{hidden:true});
    expect(await page.evaluate(()=>document.activeElement?.id)).toBe('sl-print');
  });
  it('blocks printing before recording when the label layout cannot be prepared', async () => {
    await page.evaluate(()=>{ (window as any).InventoryUnitLabels.waitForLayout=async()=>{throw new Error('Layout unavailable');}; });
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]'); await page.click('[data-batch]'); await page.waitForSelector('#sl-print');
    await page.click('#sl-print'); await page.waitForFunction(()=>document.querySelector('#slp-status')?.textContent==='Layout unavailable');
    expect(await page.$eval('#slp-print',(el:HTMLButtonElement)=>el.disabled)).toBe(true);
    expect(prints).toHaveLength(0);
  });
  it('keeps bulk selection through navigation and respects reduced motion at mobile widths', async () => {
    batches[0].printed = 3;
    await page.click('#open-issue'); await page.waitForSelector('[data-select-batch]'); await page.click('[data-select-batch]');
    await page.click('[data-batch]'); await page.waitForSelector('#sl-back'); await page.click('#sl-back');
    await page.waitForSelector('[data-select-batch]:checked');
    await page.click('#sl-review-print'); await page.waitForSelector('.sl-bulk-rows article');
    const content = await page.$eval('#page-supplier-labels',el=>el.outerHTML);
    writeFileSync(resolve(artifactDir,'workspace-bulk.html'),`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--primary:#003b29;--surface:#fff;--border:#dce6df;--text:#18392e}body{margin:0;padding:20px;font:14px Arial;background:#f5f7f6}${readFileSync(resolve(publicDir,'supplier-labels.css'),'utf8')}</style></head><body>${content}</body></html>`);
    for (const width of [1440,768,390]) {
      await page.setViewport({width,height:900});
      expect(await page.$eval('#page-supplier-labels',el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
      await page.screenshot({path:resolve(artifactDir,`bulk-review-${width}.png`),fullPage:true});
    }
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    expect(await page.$eval('#sl-bulk-print',el=>getComputedStyle(el).transitionDuration)).toBe('0s');
  });
  it('opens the embedded supplier tab and creates an explicitly selected product batch', async () => {
    await page.click('#open-issue'); await page.waitForSelector('#sl-new');
    expect(await page.$('dialog[open]')).toBeNull();
    expect(new URL(page.url()).hash).toBe('#warehouse-management/supplier-labels');
    await page.click('#sl-new'); await page.waitForSelector('[data-product]');
    expect(await page.$eval('#sl-issue', (el: HTMLButtonElement) => el.disabled)).toBe(true);
    await page.click('[data-product]');
    await page.$eval('#sl-quantity', (input: HTMLInputElement) => { input.value = '30'; });
    await page.click('#sl-issue'); await page.waitForSelector('dialog.iu-cover-choice[open]');
    await page.click('dialog.iu-cover-choice [data-include-covers="yes"]'); await page.waitForSelector('#sl-print');
    expect(issues).toHaveLength(1); expect(issues[0]).toMatchObject({ productId, quantity: 30 });
    expect(await page.$eval('#sl-print-quantity', (input: HTMLInputElement) => input.value)).toBe('30');
    expect(new URL(page.url()).hash).toBe('#warehouse-management/supplier-labels/batch/' + batchId);
    await page.$eval('#sl-print-quantity', (input: HTMLInputElement) => { input.value = '2'; });
    await page.click('#sl-print'); await readyPreview();
    expect(await page.$eval('#slp-frame', (frame: HTMLIFrameElement) =>
      frame.contentDocument!.querySelectorAll('.iu-label-batch-cover').length)).toBe(1);
  }, 15000);
  it('shows product images and icons, with compact rows and easy batch opening', async () => {
    batches[0].imageUrl = await QRCode.toDataURL('product-image', { width: 32, margin: 0 });
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]');
    await page.waitForFunction(() => (document.querySelector('.sl-product-image img') as HTMLImageElement)?.naturalWidth > 0);
    expect(await page.$$('.sl-table thead th svg')).toHaveLength(7);
    expect(await page.$eval('.sl-table tbody tr', row => row.getBoundingClientRect().height)).toBeLessThan(80);
    await page.click('.sl-batch-select');
    expect(await page.$eval('[data-select-batch]', el => (el as HTMLInputElement).checked)).toBe(true);
    expect(new URL(page.url()).hash).toBe('#warehouse-management/supplier-labels');
    await page.click('.sl-table tbody td.sl-number'); await page.waitForSelector('#sl-print');
    expect(new URL(page.url()).hash).toBe('#warehouse-management/supplier-labels/batch/' + batchId);
  });
  it('points batch navigation arrows in the active page direction', async () => {
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]');
    const arrowX = (selector: string) => page.$eval(selector, element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
    expect(await arrowX('#sl-next svg')).toBeCloseTo(-1);
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    expect(await arrowX('#sl-next svg')).toBeCloseTo(1);
    await page.click('[data-batch]'); await page.waitForSelector('.sl-batch-heading code');
    expect(await arrowX('#sl-back svg')).toBeCloseTo(-1);
    expect(await page.$eval('.sl-batch-heading code', element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    expect(await arrowX('#sl-back svg')).toBeCloseTo(1);
  });
  it('asks before creating QR labels and respects the labels-only choice', async () => {
    await page.click('#open-issue'); await page.waitForSelector('#sl-new');
    await page.click('#sl-new'); await page.waitForSelector('[data-product]'); await page.click('[data-product]');
    await page.$eval('#sl-quantity', (input: HTMLInputElement) => { input.value = '2'; });
    await page.click('#sl-issue'); await page.waitForSelector('dialog.iu-cover-choice[open]');
    expect(issues).toHaveLength(0);
    await page.click('dialog.iu-cover-choice [data-cancel]');
    await page.waitForFunction(() => !document.querySelector('dialog.iu-cover-choice'));
    expect(issues).toHaveLength(0);
    await page.click('#sl-issue'); await page.waitForSelector('dialog.iu-cover-choice[open]');
    await page.click('dialog.iu-cover-choice [data-include-covers="no"]'); await page.waitForSelector('#sl-print');
    expect(issues).toHaveLength(1);
    expect(await page.evaluate(id => localStorage.getItem('soulia_supplier_batch_cover:' + id), batchId)).toBe('no');
    await page.goto(origin); await page.click('#open-issue'); await page.waitForSelector('[data-batch]');
    await page.click('[data-batch]'); await page.waitForSelector('#sl-print');
    await page.click('#sl-print'); await readyPreview();
    expect(await page.$eval('#slp-frame', (frame: HTMLIFrameElement) => ({
      covers: frame.contentDocument!.querySelectorAll('.iu-label-batch-cover').length,
      labels: frame.contentDocument!.querySelectorAll('.iu-label:not(.iu-label-batch-cover)').length,
    }))).toEqual({ covers: 0, labels: 2 });
  });
  it('searches beyond 80 products with unordered tokens and keyboard selection', async () => {
    productCatalog = Array.from({ length: 115 }, (_, i) => ({ _id: String(i + 1).padStart(24, '0'), name: `Product ${i}`, code: `CODE-${i}`, isActive: true }));
    productCatalog.push({ _id: productId, name: 'Brown jute coaster 40cm', code: 'CODE-53', isActive: true });
    await page.click('#open-issue'); await page.waitForSelector('#sl-new'); await page.click('#sl-new');
    await page.waitForSelector('[data-product]');
    await page.type('#sl-product-query', '40cm brown');
    expect(await page.$$('[data-product]')).toHaveLength(1);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    expect(await page.$eval('#sl-selection', el => el.textContent)).toContain('CODE-53');
    await page.$eval('#sl-product-query', (el: HTMLInputElement) => { el.value = 'no-such-product'; el.dispatchEvent(new Event('input')); });
    expect(await page.$$('[data-product]')).toHaveLength(0);
    expect(await page.$eval('#sl-selection', el => el.textContent)).toContain('CODE-53');
  });
  it('finds a product by compact SKU or unordered name and shows its photo', async () => {
    const photo = await QRCode.toDataURL('brown-cushion-photo', { width: 40, margin: 0 });
    productCatalog = [
      { _id: productId, name: 'Alba Soft cushions Brown', code: 'CUS-45-ALB-BRO', imageUrl: photo, isActive: true },
      { _id: '507f1f77bcf86cd799439012', name: 'Alba Soft cushions Beige', code: 'CUS-45-ALB-BEI', isActive: true },
    ];
    await page.click('#open-issue'); await page.waitForSelector('#sl-new'); await page.click('#sl-new');
    await page.waitForSelector('[data-product]');
    await page.type('#sl-product-query', 'CUS45ALBBRO');
    expect(await page.$$('[data-product]')).toHaveLength(1);
    await page.waitForFunction(() => (document.querySelector('.sl-product .sl-product-image img') as HTMLImageElement)?.naturalWidth > 0);
    await page.click('[data-product]');
    expect(await page.$eval('#sl-selection .sl-product-image img', image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.$eval('#sl-product-query', input => { (input as HTMLInputElement).value = 'brown alba'; input.dispatchEvent(new Event('input')); });
    expect(await page.$$('[data-product]')).toHaveLength(1);
  });
  it('opens QR linking on the chosen invoice product and keeps its selection', async () => {
    optionLines = [
      { lineIndex: 3, sku: 'BASKET-1', name: 'Basket', quantity: 10, createdUnits: 0 },
      { lineIndex: 7, sku: 'THROW-2', name: 'Throw blanket', quantity: 2, createdUnits: 0 },
    ];
    await page.evaluate(id => (window as any).PreprintedLabels.openLink(id, 7), invoiceId);
    await page.waitForSelector('#pl-choose-range');
    await page.click('#pl-choose-range');
    expect(await page.$eval('#pl-line', node => (node as HTMLSelectElement).value)).toBe('1');
    await page.select('#pl-line', '0');
    await page.click('#pl-method-back');
    await page.click('#pl-choose-scan');
    expect(await page.$eval('#pl-line', node => (node as HTMLSelectElement).value)).toBe('0');
  });
  it('recovers a failed batch read and retries issuance using the same operation key', async () => {
    failListOnce = true;
    await page.click('#open-issue'); await page.waitForSelector('#sl-retry');
    await page.click('#sl-retry'); await page.waitForSelector('[data-batch]');
    await page.click('#sl-new'); await page.waitForSelector('[data-product]'); await page.click('[data-product]');
    failIssueOnce = true;
    await page.click('#sl-issue');
    await page.waitForSelector('dialog.iu-cover-choice[open]');
    await page.click('dialog.iu-cover-choice [data-include-covers="yes"]');
    await page.waitForFunction(() => document.querySelector('#sl-message')?.getAttribute('data-error') === 'true');
    await page.click('#sl-issue'); await page.waitForSelector('#sl-print');
    expect(issues).toHaveLength(2); expect(issues[0].operationKey).toBe(issues[1].operationKey);
  });
  it('keeps an empty list actionable and prevents accidental reprinting', async () => {
    batches = [];
    await page.click('#open-issue'); await page.waitForSelector('.sl-empty h2');
    expect(await page.$('#sl-new')).not.toBeNull();
    batches = [{ batchId, productId, sku: 'BASKET-1', productName: 'Basket', quantity: 10, unused: 10, linked: 0, printed: 10 }];
    await page.click('#sl-refresh'); await page.waitForSelector('[data-batch]');
    await page.click('[data-batch]'); await page.waitForSelector('#sl-print');
    await page.click('#sl-print'); await readyPreview();
    expect(await page.$eval('#slp-print',(el: HTMLButtonElement)=>el.disabled)).toBe(true);
    await page.keyboard.press('Escape'); await page.waitForSelector('#sl-print-preview',{hidden:true});
    expect(prints).toHaveLength(0);
    expect(await page.$eval('#sl-print', (el: HTMLButtonElement) => el.disabled)).toBe(false);
  });
  it('previews a compact range before printing normal U identities without a popup', async () => {
    batches[0].productName = 'Ribbon Storage'; batches[0].sku = 'Code 32'; batches[0].printed = 0;
    await capturePrints();
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]');
    await page.click('[data-batch]'); await page.waitForSelector('#sl-print');
    await page.$eval('#sl-print-quantity', (input: HTMLInputElement) => { input.value = '2'; });
    await page.click('#sl-print'); await readyPreview();
    expect(prints).toHaveLength(0);
    expect(await page.$eval('#slp-frame',(f:HTMLIFrameElement)=>({covers:f.contentDocument!.querySelectorAll('.iu-label-batch-cover').length,sheets:f.contentDocument!.querySelectorAll('.slp-paper').length,batchNumber:f.contentDocument!.querySelector('.iu-cover-batch-number')?.textContent}))).toEqual({covers:1,sheets:3,batchNumber:batchId.slice(-8).toUpperCase()});
    await page.click('#slp-print');
    await page.waitForFunction(() => Boolean((window as any).__printedLabels), { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__printedSheets)).toBe(3);
    expect(prints).toHaveLength(1); expect(prints[0]).toMatchObject({ batchId, start: 1, quantity: 2, sizeId: '50x25' });
    const printedText = await page.evaluate(() => (window as any).__printedLabels as string);
    expect(printedText).toContain('U-0000-0001-8'); expect(printedText).toContain('U-0000-0002-6');
    expect(await page.evaluate(() => (window as any).__bulkWindows)).toBe(0);
  }, 20000);
  it('shows provenance and returns to the filtered list with browser Back', async () => {
    links = [{ quantity: 2 }]; batches[0].linked = 2; batches[0].unused = 8;
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]');
    await page.type('#sl-query', 'Basket');
    await page.waitForResponse(r => r.url().includes('/batches/page?') && r.url().includes('q=Basket'));
    await page.click('[data-batch]'); await page.waitForSelector('.sl-facts');
    const detail = await page.$eval('#sl-content', node => node.textContent || '');
    expect(detail).toContain(batchId); expect(detail).toContain('Receiver'); expect(detail).toContain('P-100');
    await page.goBack(); await page.waitForSelector('#sl-query');
    expect(await page.$eval('#sl-query', (el: HTMLInputElement) => el.value)).toBe('Basket');
    await page.waitForSelector('[data-batch]');
    expect(await page.$('dialog[open]')).toBeNull();
  });
  it('paginates large batch lists and adapts list, create and detail screens at three widths', async () => {
    batches = Array.from({ length: 27 }, (_, index) => ({ batchId: String(index + 1).padStart(24, '0'), productId,
      sku: 'BASKET-1', productName: `Basket ${index + 1}`, quantity: 1000, unused: 1000, linked: 0,
      printed: 0, createdAt: new Date(Date.parse('2026-11-03T12:00:00Z') - index * 3600000).toISOString(), createdBy: 'Receiver' }));
    await page.click('#open-issue'); await page.waitForSelector('[data-batch]');
    expect(await page.$$('[data-batch]')).toHaveLength(12);
    await page.click('#sl-next'); await page.waitForFunction(() => document.querySelector('#sl-paging')?.textContent?.includes('13'));
    await page.click('#sl-next'); await page.waitForFunction(() => document.querySelectorAll('[data-batch]').length === 3);
    for (const width of [1440, 768, 390]) {
      await page.setViewport({ width, height: 900 });
      for (const view of ['list', 'detail', 'new']) {
        if (view === 'detail') { await page.click('[data-batch]'); await page.waitForSelector('#sl-print'); }
        if (view === 'new') { await page.click('#sl-back'); await page.waitForSelector('#sl-new'); await page.click('#sl-new'); await page.waitForSelector('[data-product]'); }
        expect(await page.$eval('#page-supplier-labels', el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: resolve(artifactDir, `workspace-${view}-${width}.png`), fullPage: true });
        if (width === 1440) {
          const content = await page.$eval('#page-supplier-labels', el => el.outerHTML);
          writeFileSync(resolve(artifactDir, `workspace-${view}.html`), `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--primary:#003b29;--border:#dce6df;--surface:#fff;--text:#18392e;--bg:#f5f7f6}body{margin:0;padding:20px;font:14px Arial;background:#f5f7f6}${readFileSync(resolve(publicDir,'supplier-labels.css'),'utf8')}</style></head><body>${content}</body></html>`);
        }
      }
      await page.click('#sl-cancel'); await page.waitForSelector('[data-batch]');
    }
  }, 30000);
  it('links a partial printed range without scanning and shows the remaining invoice quantity on phone', async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-range');
    expect(await page.$('#pl-link-controls')).toBeNull();
    await page.click('#pl-choose-range'); await page.waitForSelector('#pl-link-controls');
    expect(await page.$eval('.pl-scan', el => getComputedStyle(el).display)).toBe('none');
    await page.$eval('#pl-link-quantity', (input: HTMLInputElement) => { input.value = '6'; });
    await page.click('#pl-link');
    expect(links).toHaveLength(0);
    await page.click('#pl-possession'); await page.click('#pl-labels-confirmed'); await page.click('#pl-inspection');
    await page.click('#pl-link'); await page.waitForFunction(() => document.querySelector('#pl-message')?.textContent?.includes('6'));
    await page.screenshot();
    expect(links).toHaveLength(1); expect(links[0]).toMatchObject({ batchId, lineIndex: 0, start: 1, quantity: 6,
      physicalPossessionConfirmed: true, physicalLabelsConfirmed: true, inspectionPassed: true });
    expect(await page.$eval('.pl-dialog', el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
  it('shows the receipt method choice for the saved purchase invoice', async () => {
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-range');
    expect(await page.$eval('.pl-invoice strong', node => node.textContent)).toContain('P-100');
    expect(await page.$('#pl-link-controls')).toBeNull();
    await page.screenshot({ path: resolve(artifactDir, 'method-choice-desktop.png') });
  });
  it('keeps confirmation text readable in both receiving methods despite global input styles', async () => {
    for (const width of [1200, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan');
      for (const method of ['scan', 'range']) {
        await page.click(`#pl-choose-${method}`); await page.waitForSelector('.pl-confirm-row');
        const sizes = await page.$$eval('.pl-confirm-row', rows => rows.map(row => ({
          checkbox: row.querySelector('input')!.getBoundingClientRect().width,
          text: row.querySelector('span')!.getBoundingClientRect().width,
          row: row.getBoundingClientRect().width,
        })));
        expect(sizes).toHaveLength(3);
        expect(sizes.every(size => size.checkbox === 18 && size.text >= 100 && size.row <= width)).toBe(true);
        await page.click('#pl-method-back'); await page.waitForSelector('#pl-choose-scan');
      }
      await page.$eval('#prelabels-dialog', (dialog: HTMLDialogElement) => dialog.close());
    }
  });
  it('explains why a fully identified invoice cannot receive extra preprinted labels', async () => {
    batches[0].linked = 10; batches[0].unused = 0;
    await page.click('#open-link'); await page.waitForSelector('#pl-done');
    expect(await page.$eval('.pl-panel', node => node.textContent)).toContain('فلا توجد قطع متبقية لربط QR');
    expect(await page.$('#pl-choose-range')).toBeNull();
    expect(links).toHaveLength(0);
    for (const width of [1200, 390]) {
      await page.setViewport({ width, height: 844 });
      const layout = await page.evaluate(() => {
        const panel = document.querySelector('.pl-complete-panel')!.getBoundingClientRect();
        const copy = document.querySelector('.pl-complete-copy')!.getBoundingClientRect();
        const button = document.querySelector('#pl-done')!.getBoundingClientRect();
        return { gap: button.top - copy.bottom, buttonLeft: button.left, panelMid: panel.left + panel.width / 2,
          overflow: document.querySelector('.pl-dialog')!.scrollWidth > document.querySelector('.pl-dialog')!.clientWidth + 1 };
      });
      expect(layout.gap).toBeGreaterThan(20);
      expect(layout.buttonLeft).toBeLessThan(layout.panelMid);
      expect(layout.overflow).toBe(false);
    }
    await page.click('#pl-done');
    expect(await page.$eval('#prelabels-dialog', (node: HTMLDialogElement) => node.open)).toBe(false);
  });
  it('renders the exact batch and ordinal on a compact physical QR label', async () => {
    const unitId = '507f1f77bcf86cd799439044', barcode = 'SU-' + unitId.toUpperCase();
    const manualCode = 'U-0000-0001-8';
    const svg = await QRCode.toString(barcode, { type: 'svg', margin: 4 });
    const result = await page.evaluate(async label => {
      const host = document.querySelector('#label-check')!;
      host.innerHTML = (window as any).InventoryUnitLabels.labelHtml(label, { id: '50x25', widthMm: 50, heightMm: 25, qrMm: 17, marginMm: 1.5 });
      await (window as any).InventoryUnitLabels.waitForLayout(host);
      const node = host.querySelector('.iu-label')!;
      return { header: host.querySelector('.iu-label-ordinal')?.textContent, barcode: host.querySelector('.iu-label-value')?.textContent,
        fits: node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1 };
    }, { unitId, barcode, manualCode, batchId, ordinal: 101, productName: 'Brown jute coaster 40cm', sku: 'Code 53 - 40size', sellPrice: 250, svg });
    expect(result).toMatchObject({ header: '#101 · 439033', barcode: manualCode, fits: true });
  });
  it('still rejects text or a footer that overflows the physical paper', async () => {
    const unitId = '507f1f77bcf86cd799439044', barcode = 'SU-' + unitId.toUpperCase();
    const svg = await QRCode.toString(barcode, { type: 'svg', margin: 4 });
    const rejected = await page.evaluate(async label => {
      const host = document.querySelector('#label-check')!, results = [];
      for (const kind of ['name', 'footer']) {
        host.innerHTML = (window as any).InventoryUnitLabels.labelHtml({ ...label, productName: kind === 'name' ? 'W'.repeat(600) : 'Basket' }, { id: '50x25', widthMm: 50, heightMm: 25, qrMm: 17, marginMm: 1.5 });
        if (kind === 'footer') (host.querySelector('.iu-label-footer') as HTMLElement).style.width = '100mm';
        try { await (window as any).InventoryUnitLabels.waitForLayout(host); results.push(false); }
        catch { results.push(true); }
      }
      return results;
    }, { unitId, barcode, manualCode: 'U-0000-0001-8', batchId, ordinal: 1, sku: 'BASKET-1', svg });
    expect(rejected).toEqual([true, true]);
  });
  it('links a single physically scanned QR to the chosen purchase line', async () => {
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan'); await page.waitForSelector('#pl-link-controls');
    expect(await page.$eval('.pl-bulk-only', el => getComputedStyle(el).display)).toBe('none');
    await page.click('#pl-possession'); await page.click('#pl-labels-confirmed');
    await page.$eval('#pl-scan-code', (input: HTMLInputElement) => { input.value = 'SU-507F1F77BCF86CD799439044'; });
    await page.click('#pl-scan-submit');
    await page.waitForFunction(() => document.querySelector('#pl-message')?.textContent?.includes('1'));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ batchId, lineIndex: 0, start: 4, quantity: 1,
      physicalPossessionConfirmed: true, physicalLabelsConfirmed: true });
    expect(await page.$eval('#pl-possession', (input: HTMLInputElement) => input.checked)).toBe(true);
  });
  it('confirms each scan and keeps the scanner ready for the next label', async () => {
    batches[0].linked = 8; batches[0].unused = 2;
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan');
    await page.click('#pl-possession'); await page.click('#pl-labels-confirmed'); await page.click('#pl-inspection');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pl-scan-code');
    await page.keyboard.type('INVALID'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.getAttribute('data-kind') === 'error'
      && document.activeElement?.id === 'pl-scan-code');
    expect(await page.$eval('#pl-scan-code', el => (el as HTMLInputElement).selectionStart)).toBe(0);
    await page.keyboard.type('SU-507F1F77BCF86CD799439049'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pl-scan-done')?.textContent === '1' && document.activeElement?.id === 'pl-scan-code');
    expect(await page.$eval('#pl-scan-result', el => ({ kind: (el as HTMLElement).dataset.kind, text: el.textContent })))
      .toMatchObject({ kind: 'success', text: expect.stringContaining('تم استلام القطعة بنجاح') });
    expect(await page.$eval('#pl-scan-code', el => (el as HTMLInputElement).value)).toBe('');
    await page.keyboard.type('SU-507F1F77BCF86CD799439050'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pl-scan-done')?.textContent === '2');
    expect(links).toHaveLength(2);
    expect(await page.$eval('#pl-scan-result', el => (el as HTMLElement).dataset.kind)).toBe('success');
  });
  it('counts each scanned piece and reports invalid, incomplete, duplicate and completed sessions', async () => {
    batches[0].linked = 8; batches[0].unused = 2;
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan'); await page.waitForSelector('#pl-scan-progress');
    expect(await page.$eval('.pl-scan-metric strong', el => el.textContent?.replace(/\s/g, ''))).toBe('0/2');
    await page.click('#pl-possession'); await page.click('#pl-labels-confirmed');
    const scan = async (code: string) => {
      await page.$eval('#pl-scan-code', (input: HTMLInputElement, value: string) => { input.value = value; }, code);
      await page.click('#pl-scan-submit');
    };
    await scan('INVALID');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.textContent?.includes('لم يُعثر على هذا الملصق'));
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('0');
    await scan('WRONG-PRODUCT');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.textContent?.includes('منتجًا آخر'));
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('0');
    await scan('SU-507F1F77BCF86CD799439049');
    await page.waitForFunction(() => document.querySelector('#pl-scan-done')?.textContent === '1');
    expect(await page.$eval('#pl-scan-progress', el => (el as HTMLProgressElement).value)).toBe(1);
    await page.screenshot({ path: resolve(artifactDir, 'receiving-scan-progress.png') });
    await page.click('#pl-scan-finish');
    expect(await page.$eval('#pl-scan-result', el => ({ kind: (el as HTMLElement).dataset.kind, text: el.textContent }))).toMatchObject({ kind: 'error', text: expect.stringContaining('لم يكتمل') });
    await page.click('#pl-scan-resume');
    await scan('SU-507F1F77BCF86CD799439049');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.textContent?.includes('محسوبة'));
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('1');
    await scan('SU-507F1F77BCF86CD799439050');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.getAttribute('data-kind') === 'success');
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('2');
    expect(await page.$eval('#pl-scan-code', el => (el as HTMLInputElement).disabled)).toBe(true);
    expect(links).toHaveLength(2);
    await page.screenshot({ path: resolve(artifactDir, 'receiving-scan-complete.png') });
  });
  it('keeps the same receiving request on retry and completes after a temporary failure', async () => {
    batches[0].linked = 9; batches[0].unused = 1; failLinkOnce = true;
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan');
    await page.click('#pl-possession'); await page.click('#pl-labels-confirmed'); await page.click('#pl-inspection');
    await page.$eval('#pl-scan-code', (input: HTMLInputElement) => { input.value = 'SU-507F1F77BCF86CD799439050'; });
    await page.click('#pl-scan-submit');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.textContent?.includes('Temporary receiving failure'));
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('0');
    expect(await page.$eval('#pl-scan-code', el => (el as HTMLInputElement).value)).toBe('SU-507F1F77BCF86CD799439050');
    await page.click('#pl-scan-submit');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.getAttribute('data-kind') === 'success');
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('1');
    expect(linkAttempts).toHaveLength(2);
    expect(linkAttempts[0].operationKey).toBe(linkAttempts[1].operationKey);
    expect(links).toHaveLength(1);
    expect(await page.$eval('#pl-scan-result', el => el.textContent)).toContain('متاحة');
  });
  it('allows another piece after a definitive receiving rejection', async () => {
    batches[0].linked = 8; batches[0].unused = 2; rejectLinkOnce = true;
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan'); await page.click('#pl-possession'); await page.click('#pl-labels-confirmed');
    await page.$eval('#pl-scan-code', (input: HTMLInputElement) => { input.value = 'SU-507F1F77BCF86CD799439049'; });
    await page.click('#pl-scan-submit');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.textContent?.includes('This label cannot be linked'));
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('0');
    await page.$eval('#pl-scan-code', (input: HTMLInputElement) => { input.value = 'SU-507F1F77BCF86CD799439050'; });
    await page.click('#pl-scan-submit');
    await page.waitForFunction(() => document.querySelector('#pl-scan-done')?.textContent === '1');
    expect(linkAttempts).toHaveLength(2);
    expect(linkAttempts[0].operationKey).not.toBe(linkAttempts[1].operationKey);
    expect(links).toHaveLength(1);
  });
  it('keeps the camera active between scans and releases it after the last piece', async () => {
    batches[0].linked = 8; batches[0].unused = 2;
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan'); await page.click('#pl-possession'); await page.click('#pl-labels-confirmed');
    await page.evaluate(() => {
      (window as any).__cameraStops = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop: () => { (window as any).__cameraStops++; } }] }) });
      (window as any).ZXingBrowser = { BrowserQRCodeReader: class { async decodeFromStream(_stream: any, _video: any, callback: any) {
        (window as any).__cameraCallback = callback; return { stop: () => { (window as any).__cameraStops++; } };
      } } };
    });
    await page.click('#pl-camera');
    await page.waitForFunction(() => Boolean((window as any).__cameraCallback));
    await page.evaluate(() => (window as any).__cameraCallback({ getText: () => 'SU-507F1F77BCF86CD799439049' }));
    await page.waitForFunction(() => document.querySelector('#pl-scan-done')?.textContent === '1');
    expect(await page.evaluate(() => (window as any).__cameraStops)).toBe(0);
    await page.evaluate(() => (window as any).__cameraCallback({ getText: () => 'SU-507F1F77BCF86CD799439050' }));
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.getAttribute('data-kind') === 'success');
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('2');
    expect(await page.evaluate(() => (window as any).__cameraStops)).toBeGreaterThan(0);
  });
  it('explains camera permission failure and keeps manual scanning available', async () => {
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan'); await page.click('#pl-possession'); await page.click('#pl-labels-confirmed');
    await page.evaluate(() => {
      (window as any).ZXingBrowser = { BrowserQRCodeReader: class {} };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
      });
    });
    await page.click('#pl-camera');
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.textContent?.includes('تم رفض إذن الكاميرا'));
    expect(await page.$eval('#pl-scan-code', el => (el as HTMLInputElement).disabled)).toBe(false);
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('0');
  });
  it('retries the same camera code after a temporary receiving failure without double counting', async () => {
    batches[0].linked = 9; batches[0].unused = 1; failLinkOnce = true;
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan'); await page.click('#pl-possession'); await page.click('#pl-labels-confirmed');
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop: () => {} }] }) });
      (window as any).ZXingBrowser = { BrowserQRCodeReader: class { async decodeFromStream(_stream: any, _video: any, callback: any) {
        (window as any).__cameraCallback = callback; return { stop: () => {} };
      } } };
    });
    await page.click('#pl-camera'); await page.waitForFunction(() => Boolean((window as any).__cameraCallback));
    await page.evaluate(() => (window as any).__cameraCallback({ getText: () => 'SU-507F1F77BCF86CD799439050' }));
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.getAttribute('data-kind') === 'error');
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('0');
    await page.evaluate(() => {
      const now = Date.now; Date.now = () => now() + 3000;
      (window as any).__cameraCallback({ getText: () => 'SU-507F1F77BCF86CD799439050' });
      Date.now = now;
    });
    await page.waitForFunction(() => document.querySelector('#pl-scan-result')?.getAttribute('data-kind') === 'success');
    expect(await page.$eval('#pl-scan-done', el => el.textContent)).toBe('1');
    expect(linkAttempts).toHaveLength(2);
    expect(linkAttempts[0].operationKey).toBe(linkAttempts[1].operationKey);
    expect(links).toHaveLength(1);
  });
  it('can defer receipt after invoice save and choose another method on reopening', async () => {
    await page.click('#open-link'); await page.waitForSelector('#pl-later');
    await page.click('#pl-later');
    expect(await page.$eval('#prelabels-dialog', (node: HTMLDialogElement) => node.open)).toBe(false);
    expect(links).toHaveLength(0);
    await page.click('#open-link'); await page.waitForSelector('#pl-choose-scan', { visible: true });
    await page.click('#pl-choose-scan');
    await page.click('#pl-method-back');
    expect(await page.$('#pl-choose-range')).not.toBeNull();
  });
});
