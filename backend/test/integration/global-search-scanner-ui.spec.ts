import { createServer, Server } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';

describe('Global search shared unit scanner in Chromium', () => {
  let browser: Browser, server: Server, page: Page, origin: string, mode: string, requests: any[], receipts: Map<string, any>;
  const publicDir = resolve(__dirname, '../../../frontend/public');
  const index = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
  const header = index.slice(index.indexOf('<div class="header-search">'), index.indexOf('<div class="header-actions">'));
  const id = '507f1f77bcf86cd799439031', barcode = 'SU-' + id.toUpperCase();
  const html = `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box}body{margin:10px;font:14px Arial}#header{width:100%}.header-search{width:min(100%,340px)}.search-wrap{position:relative;width:100%}.search-wrap input{width:100%;height:40px}.search-wrap>svg{position:absolute;width:15px;height:15px;right:10px;top:12px}.search-clear{position:absolute;left:8px;top:12px;width:20px;padding:0}.search-dropdown{display:none}button{min-height:30px}
  </style><link rel="stylesheet" href="/navigation-shell.css"><link rel="stylesheet" href="/inventory-scanner.css"><link rel="stylesheet" href="/global-search-scanner.css"></head><body><div id="app"><header id="header">${header}</header></div><script>
  let currentLang='en',currentUser={_id:'operator-1'},permitted=true;
  let queries=[];function hasPerm(p){return permitted&&p==='inventory-units-view'}
  function renderRecentSearches(){} function handleSearchKeydown(){} function toggleSearchClear(){} function closeSearchDropdown(){}
  function handleGlobalSearch(q){queries.push(q)}function debouncedGlobalSearch(q){handleGlobalSearch(q)}
  const shortcut=document.createElement('kbd');shortcut.className='shell-search-shortcut';shortcut.textContent='Ctrl K';document.querySelector('.search-wrap').append(shortcut);
  async function api(path,options={}){const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok){const e=new Error(d.message);e.status=r.status;throw e}return d}
  </script><script src="/barcode-input.js"></script><script src="/inventory-scanner.js"></script><script src="/global-search-scanner.js"></script></body></html>`;
  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true, timeout: 20000 });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
      if (url.pathname.startsWith('/api/')) {
        let bytes = ''; for await (const chunk of req) bytes += chunk;
        const data = bytes ? JSON.parse(bytes) : null; requests.push({ path: url.pathname, data });
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'denied') { res.statusCode = 403; res.end(JSON.stringify({ message: 'Permission denied' })); return; }
        if (url.pathname.endsWith('/scans/validate')) {
          if (mode === 'pending') { res.statusCode = 503; res.end('{}'); return; }
          const result = { outcome: mode === 'unknown' ? 'rejected' : 'accepted', code: mode === 'unknown' ? 'UNKNOWN_BARCODE' : 'VALIDATED', operationId: 'f'.repeat(64), unit: { _id: id, barcode } };
          receipts.set(data.operationKey, result); res.end(JSON.stringify(result)); return;
        }
        if (url.pathname.includes('/operations/')) {
          const result = receipts.get(url.pathname.split('/').pop()!); res.end(JSON.stringify(result ? { state: 'resolved', result } : { state: 'unresolved' })); return;
        }
        if (mode === 'details-fail') { res.statusCode = 500; res.end('{}'); return; }
        const statuses = ['available','reserved','picking','prepared','shipped','delivered'];
        const status = statuses.includes(mode) ? mode : ['stale-search','missing-order'].includes(mode) ? 'picking' : 'inspection-required';
        const assignment = ['reserved','picking','prepared','shipped','delivered'].includes(status) ? {transactionId:'507f1f77bcf86cd799439040',lineId:'line-1'} : null;
        if (url.pathname === '/api/inventory-units/' + barcode) { res.end(JSON.stringify({unit:{_id:id,barcode,productId:'product-1',warehouseCode:'Main',status,assignment},purchaseInvoice:{transactionId:'507f1f77bcf86cd799439041',ref:'PUR-88',date:'2026-10-17',createdAt:'2026-10-17T10:00:00Z'},assignmentOrder:assignment && mode !== 'missing-order' ? {transactionId:assignment.transactionId,ref:'2773',client:'Fatma Hassan',pickupStatus:'Preparing',date:'2026-10-20'} : null}));return; }
        if (url.pathname.startsWith('/api/products/')) { res.end(JSON.stringify({ _id: 'product-1', name: '<img src=x onerror=alert(1)> Basket', code: 'Code 02', sellPrice: 249.5, buyPrice: 50, size: 'Large', colors: ['Red'] })); return; }
        if(url.pathname==='/api/transactions/inventory'){res.end(JSON.stringify([]));return;}
        res.end(JSON.stringify({ total:3,units: [{ _id: id, barcode, productId: 'product-1', warehouseCode: 'Main', status: mode==='stale-search'?'available':status,assignment,product: { name: 'Basket', code: 'Code 02' } }] })); return;
      }
      if (['/barcode-input.js', '/inventory-scanner.js', '/inventory-scanner.css', '/global-search-scanner.js', '/global-search-scanner.css', '/navigation-shell.css', '/vendor/zxing-browser-0.2.1.min.js'].includes(url.pathname)) {
        res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'); res.end(readFileSync(publicDir + url.pathname)); return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = 'http://127.0.0.1:' + (server.address() as any).port;
  }, 30000);
  beforeEach(async () => { mode = ''; requests = []; receipts = new Map(); page = await browser.newPage(); await page.goto(origin); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(done => server.close(() => done())); });
  const open = () => page.click('#global-search-scan');
  async function scan() { await page.type('[data-scan-input]', barcode); await page.keyboard.press('Enter'); }
  const result = () => page.waitForSelector('[data-gs-result] .gs-unit-price');
  const scans = () => requests.filter(row => row.path.endsWith('/scans/validate'));
  it('preserves ordinary general search and requests no camera/scan on typing', async () => {
    await page.type('#global-search', 'Basket');
    expect(await page.evaluate(() => (window as any).eval('queries').at(-1))).toBe('Basket');
    expect(requests).toHaveLength(0); expect(await page.$('[data-scan-input]')).toBeNull();
  });
  it('opens with F outside fields, preserves typing and browser shortcuts, and shows no removed disclaimer',async()=>{
    await page.focus('#global-search');await page.keyboard.press('f');
    expect(await page.$eval('#global-search',e=>(e as HTMLInputElement).value)).toBe('f');
    expect(await page.$eval('#global-unit-scan-dialog',e=>(e as HTMLDialogElement).open)).toBe(false);
    await page.$eval('#global-search',e=>(e as HTMLInputElement).blur());
    await page.keyboard.down('Control');await page.keyboard.press('f');await page.keyboard.up('Control');expect(await page.$eval('#global-unit-scan-dialog',e=>(e as HTMLDialogElement).open)).toBe(false);
    await page.keyboard.press('Escape');await page.keyboard.press('f');
    expect(await page.$eval('#global-unit-scan-dialog',e=>(e as HTMLDialogElement).open)).toBe(true);
    expect(await page.$eval('#global-unit-scan-dialog',e=>e.textContent)).not.toContain('Online validation only');
    expect(scans()).toHaveLength(0);
  });
  it.each(['KeyF','Unidentified'])('opens scan using the Arabic F key with code %s',async(code)=>{
    await page.evaluate(code=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ب',code,bubbles:true,cancelable:true})),code);
    expect(await page.$eval('#global-unit-scan-dialog',e=>(e as HTMLDialogElement).open)).toBe(true);
    expect(await page.$eval('[data-scan-input]',e=>e===document.activeElement)).toBe(true);
  });
  it('recovers scanner hardware keys when Windows composition leaves unreadable Arabic text',async()=>{
    await open();
    await page.evaluate(barcode=>{
      const input=document.querySelector<HTMLInputElement>('[data-scan-input]')!;
      input.value='نص غير مقروء من القارئ';
      for(const char of barcode)input.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',code:/[A-Z]/.test(char)?'Key'+char:char==='-'?'Minus':'Digit'+char,isComposing:true,bubbles:true,cancelable:true}));
    },barcode);
    await page.keyboard.press('Enter');await result();
    expect(scans()).toHaveLength(1);expect(scans()[0].data.identifier).toBe(barcode);
  });
  it('presents purchase provenance first, followed by order state and the sales invoice',async()=>{
    mode='picking';await open();await scan();await result();
    const sections=await page.$eval('.gs-product-details',e=>[...e.children].filter(c=>c.matches('.gs-purchase-invoice,.gs-unit-state,.gs-sales-invoice')).map(c=>c.className));
    expect(sections).toHaveLength(3);expect(sections[0]).toContain('gs-purchase-invoice');expect(sections[1]).toBe('gs-unit-state');expect(sections[2]).toContain('gs-sales-invoice');
    expect(await page.$eval('.gs-purchase-invoice',e=>e.textContent)).toContain('PUR-88');
    expect(await page.$eval('.gs-linked-order-status',e=>e.textContent)).toContain('Preparing');
    expect(await page.$eval('.gs-sales-invoice',e=>e.textContent)).toContain('2773');
    expect(requests.every(r=>!r.method||r.method==='GET'||r.path.endsWith('/scans/validate'))).toBe(true);
  });
  it('shows the exact unit product, warehouse, details and selling price without searching or navigating', async () => {
    await open(); await scan(); await result();
    expect(scans()).toHaveLength(1); expect(scans()[0].data).toMatchObject({ identifier: barcode, intent: 'lookup' });
    expect(await page.$eval('[data-gs-result]', el => el.textContent)).toContain('Code 02');
    expect(await page.$('.gs-product-details img')).toBeNull();
    expect(await page.$eval('.gs-product-image',el=>(el as HTMLImageElement).hidden)).toBe(true);
    expect(await page.$eval('dialog', el => (el as HTMLDialogElement).open)).toBe(true);
    expect(await page.$eval('[data-gs-result]', el => el.textContent)).toContain('Main');
    expect(await page.$eval('[data-gs-result]', el => el.textContent)).toContain('Large');
    expect(await page.$eval('.gs-unit-price', el => el.textContent)).toContain('249.50 EGP');
    expect(await page.$('[data-gs-result] button')).toBeNull();
    expect(await page.$eval('#global-search', el => (el as HTMLInputElement).value)).toBe('');
    expect(await page.evaluate(() => (window as any).eval('queries').length)).toBe(0);
  });
  it('hides the entry point without permission and closes active scanning when logging out', async () => {
    await open(); await page.evaluate(() => { (window as any).eval('permitted=false;currentUser=null'); document.getElementById('app')!.style.display = 'none'; });
    await page.waitForFunction(() => !(document.querySelector('dialog') as HTMLDialogElement).open);
    expect(await page.$eval('#global-search-scan', el => (el as HTMLElement).hidden)).toBe(true); expect(scans()).toHaveLength(0);
  });
  it.each(['available','reserved','picking','prepared','shipped','delivered'])('shows current %s state and its linked order without changing custody',async status=>{
    mode=status;await open();await scan();await result();
    expect(await page.$eval('.gs-unit-state',el=>(el as HTMLElement).dataset.status)).toBe(status);
    if(status==='available')expect(await page.$('.gs-unit-order')).toBeNull();
    else{expect(await page.$eval('.gs-unit-order',el=>el.textContent)).toContain('#2773');expect(await page.$eval('.gs-unit-order',el=>el.textContent)).toContain('Fatma Hassan');}
    expect(requests.filter(row=>row.data&& !row.path.endsWith('/scans/validate'))).toHaveLength(0);
  });
  it('prefers the fresh lookup state over stale search data and localizes the status',async()=>{
    mode='stale-search';await page.evaluate(()=>{(window as any).eval("currentLang='ar'");document.documentElement.dir='rtl';});await open();await scan();await result();
    expect(await page.$eval('.gs-unit-status',el=>el.textContent)).toBe('قيد التحضير');
    expect(await page.$eval('.gs-unit-order',el=>el.textContent)).toContain('2773');
    await page.setViewport({width:320,height:900});expect(await page.$eval('dialog',el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  });
  it('handles a deleted linked order without claiming the piece is available',async()=>{
    mode='missing-order';await open();await scan();await result();
    expect(await page.$eval('.gs-unit-status',el=>el.textContent)).toBe('Being prepared');
    expect(await page.$eval('.gs-unit-order',el=>el.textContent)).toContain('unavailable');
  });
  it.each(['unknown', 'denied'])('does not search or navigate for %s scans', async failure => {
    mode = failure; await open(); await scan();
    await page.waitForFunction(() => !!document.querySelector('[data-scan-message]')!.textContent);
    expect(await page.$eval('[data-gs-result]', el => (el as HTMLElement).hidden)).toBe(true);
    expect(await page.evaluate(() => (window as any).eval('queries').length)).toBe(0);
  });
  it('retains an unresolved request on close, rechecks on reopening, and retries the original key only explicitly', async () => {
    mode = 'pending'; await open(); await scan();
    await page.waitForFunction(() => document.querySelector('[data-scan-message]')!.textContent!.includes('outcome unknown'));
    const pending = scans()[0].data; await page.click('[data-gs-close]'); await open();
    await page.waitForFunction(() => document.querySelector('[data-scan-message]')!.textContent!.includes('No confirmed result'));
    expect(scans()).toHaveLength(1); mode = ''; await page.click('[data-scan-retry]'); await result();
    expect(scans()[1].data).toEqual(pending);
  });
  it('reloads failed product details without posting another validation', async () => {
    mode = 'details-fail'; await open(); await scan(); await page.waitForSelector('[data-gs-result] button');
    expect(await page.$eval('[data-gs-result]', el => el.textContent)).toContain('could not load');
    mode = ''; await page.click('[data-gs-result] button'); await result();
    expect(scans()).toHaveLength(1);
  });
  it('requests camera permission explicitly and closes with Escape, restoring trigger focus', async () => {
    await page.evaluate(() => { (window as any).cameraCalls = 0; Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { (window as any).cameraCalls++; throw new DOMException('Denied', 'NotAllowedError'); } }); });
    await open(); expect(await page.evaluate(() => (window as any).cameraCalls)).toBe(0);
    await page.click('[data-scan-camera]'); await page.waitForFunction(() => document.querySelector('[data-scan-message]')!.textContent!.includes('Camera permission denied'));
    await page.keyboard.press('Escape'); expect(await page.$eval('dialog', el => (el as HTMLDialogElement).open)).toBe(false);
    expect(await page.$eval('#global-search-scan', el => document.activeElement === el)).toBe(true);
  });
  it('fits 320px and desktop layouts in both Arabic and English', async () => {
    for (const lang of ['ar', 'en']) {
      await page.evaluate(lang => { (window as any).eval('currentLang=' + JSON.stringify(lang)); document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; }, lang);
      await open();
      for (const width of [320, 390, 1280]) { await page.setViewport({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
      expect(await page.$eval('dialog', el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.click('[data-gs-close]');
    }
  });
  it('keeps scan, clear, shortcut and text in separate slots with the actual navigation shell CSS', async () => {
    for (const enabled of [true, false]) {
      await page.evaluate(enabled => { (window as any).eval('permitted=' + enabled); document.getElementById('app')!.classList.toggle('scanner-disabled', !enabled); }, enabled);
    for (const direction of ['rtl', 'ltr']) {
      await page.evaluate(direction => { document.documentElement.dir = direction; document.querySelector<HTMLElement>('#search-clear-btn')!.style.display = 'inline-flex'; }, direction);
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewport({ width, height: 900 });
        const layout = await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('#global-search')!, rect = input.getBoundingClientRect(), style = getComputedStyle(input);
          const start = rect.left + parseFloat(style.paddingLeft), end = rect.right - parseFloat(style.paddingRight);
          const controls = ['#search-clear-btn', '.shell-search-shortcut'].map(selector => document.querySelector(selector)!).filter(el => getComputedStyle(el).display !== 'none').map(el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right }; });
          const scan=document.querySelector('#global-search-scan')!, scanBox=scan.getBoundingClientRect();
          return { start, end, left: rect.left, right: rect.right, controls, scanVisible:getComputedStyle(scan).display!=='none',scan:{left:scanBox.left,right:scanBox.right},header:document.querySelector('.header-search')!.getBoundingClientRect().toJSON() };
        });
        expect(layout.end - layout.start).toBeGreaterThan(60);
        for (const control of layout.controls) {
          expect(control.left).toBeGreaterThanOrEqual(layout.left);
          expect(control.right).toBeLessThanOrEqual(layout.right);
          expect(control.right <= layout.start || control.left >= layout.end).toBe(true);
        }
        for (let i = 0; i < layout.controls.length; i++) for (let j = i + 1; j < layout.controls.length; j++) {
          const a = layout.controls[i], b = layout.controls[j]; expect(a.right <= b.left || b.right <= a.left).toBe(true);
        }
        if(enabled&&layout.scanVisible){
          if(width>768){expect(layout.scan.right<=layout.left||layout.scan.left>=layout.right).toBe(true);expect(layout.scan.left).toBeGreaterThanOrEqual(layout.header.left-1);expect(layout.scan.right).toBeLessThanOrEqual(layout.header.right+1);}
          else{expect(layout.scan.left).toBeGreaterThanOrEqual(layout.left);expect(layout.scan.right).toBeLessThanOrEqual(layout.right);}
        }
      }
    }
    }
  });
});
