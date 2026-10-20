import { createServer, Server } from 'http';
import { mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import * as ts from 'typescript';
import puppeteer, { Browser, Page } from 'puppeteer';

describe('Real new-transaction purchase functions and shared receipt controls in Chromium', () => {
  let browser: Browser, page: Page, server: Server, origin: string, requests: any[], mode: string;
  const publicDir = resolve(__dirname, '../../../frontend/public');
  const source = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
  let functions = '';
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].includes('function confirmTxSave()')) continue;
    const ast = ts.createSourceFile('app.js', match[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['renderTxFields', 'saveTx', 'confirmTxSave'].includes(node.name?.text || '')).map(node => node.getText(ast)).join('\n');
  }
  const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--border:#d8e4dd;--surface:#f8fafb;--bg:white;--text:#163e2a;--primary:#00311e;--muted:#738a7b}body{font:14px Arial;padding:16px;margin:0}.modal{max-width:800px;margin:auto}.modal input{width:100%;height:46px}.modal label{display:flex;justify-content:space-between}.form-group{min-width:0}#tx-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.form-group input,.form-group select{box-sizing:border-box;max-width:100%}.btn{padding:10px;border-radius:8px;border:1px solid var(--border);background:white;color:var(--primary)}@media(max-width:600px){#tx-fields{grid-template-columns:1fr}}</style><link rel="stylesheet" href="/purchase-receiving.css"></head><body><main class="modal"><div id="tx-fields"></div><input id="tx-transaction-date" value="2026-10-17"><button id="tx-save-btn">Save</button><div id="toast" role="status"></div><div id="confirmation"></div></main><script>
    let currentLang='en', currentUser={_id:'507f1f77bcf86cd799439099',name:'Operator'}, receiver=true, txType='مشتريات', txDirty=false, _txSaving=false;
    let suppliers=[{_id:'507f1f77bcf86cd799439077',name:'Supplier One'}], products=[{_id:'507f1f77bcf86cd799439011',name:'Basket',code:'BASKET-1'}];
    let txItems=[{productId:products[0]._id,qty:2,price:20}], settings={}, txComments=[], txAppliedCodes=[],txManualDiscount=0,txManualDiscountType='fixed',txDiscountType='fixed',txAppliedCodeId='',txAppliedCode='';
    let _pendingHighValueOtpId='',_pendingHighValueOtpAmount=0,_pendingPurchaseOtpId='',_pmSelOpen=null, pendingTxData=null,transactions=[],inventoryCache=[], activeDraftId=null;
    window.queuedCalls=0;window.guardCalls=0;window.savedCalls=0;
    const qs=s=>document.querySelector(s),qsa=s=>document.querySelectorAll(s),t=s=>s,esc=s=>String(s??'').replaceAll('<','&lt;');
    function hasPerm(p){return p==='inventory-units-receive'?receiver:true;}
    function toast(message){qs('#toast').textContent=message;}
    function applyLangIn(){}function _pmEnhanceSelects(){}function _pmSelClose(){}function todayLocalISO(){return '2026-10-17';}
    const ICON=()=>'',_PAY_METHOD_ICONS={};
    function mergeDuplicateTxItems(){return false;}function validateTx(){return true;}function _isPurchaseOtpRequired(){return false;}function _isOtpRequired(){return false;}function getEffectiveDiscount(){return 0;}function _txCodesTotal(){return 0;}function _needsTxDateConfirm(){return false;}
    function showTxConfirmation(body){window.confirmedBody=body;qs('#confirmation').textContent=JSON.stringify(body);}function closeTxConfirmModal(){}
    function _assertNotDuplicateTxSubmit(){window.guardCalls++;}function cashPulseAll(){}function addSupplierLog(){return Promise.resolve();}function fmtN(v){return String(v);}function fmtJ(v){return String(v);}function buildNotifications(){}function buildSidebar(){}function resetTx(){window.savedCalls++;}
    function trySendOrQueue(type,fn){window.queuedCalls++;return fn();}
    async function api(path,options={}){const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const data=await r.json();if(!r.ok){const error=new Error(data.message);error.status=r.status;throw error;}return data;}
    </script><script src="/purchase-receiving.js"></script><script>${functions}</script><script>renderTxFields();qs('#tx-supplier').value='Supplier One';qs('#tx-ref').value='100';</script></body></html>`;
  beforeAll(async () => {
    expect(functions).toContain('submitManualPurchaseWithUnits');
    browser = await puppeteer.launch({ headless: true, timeout: 20000 });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const data = body ? JSON.parse(body) : null; requests.push({ path: url.pathname, method: req.method, data });
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname.endsWith('/purchases/readiness')) { res.end(JSON.stringify({ writesReady: mode !== 'not-ready' })); return; }
        if (url.pathname.endsWith('/purchases/receive')) {
          if (mode === 'denied') { res.statusCode = 403; res.end(JSON.stringify({ message: 'Permission denied' })); return; }
          if (mode === 'failure') { res.statusCode = 503; res.end(JSON.stringify({ message: 'Unknown receipt outcome' })); return; }
          res.end(JSON.stringify({ operationId: 'f'.repeat(64), transaction: { ...data.invoice, _id: '507f1f77bcf86cd799439055' }, receipt: { createdUnits: 2, unitIds: ['one','two'], lines: [{ sku: 'BASKET-1', receivedQty: 2, createdUnits: 2 }] } }));
        } else res.end(JSON.stringify(req.method === 'POST' ? { _id: '507f1f77bcf86cd799439055', ...data } : []));
      } else if (url.pathname === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); }
      else if (['/purchase-receiving.js','/purchase-receiving.css'].includes(url.pathname)) { res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');res.end(readFileSync(publicDir+url.pathname)); }
      else {res.statusCode=404;res.end();}
    });
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done)); origin='http://127.0.0.1:'+(server.address() as any).port;
  },30000);
  beforeEach(async()=>{requests=[];mode='';page=await browser.newPage();page.on('pageerror',error=>console.error('Purchase browser error',error));await page.goto(origin);await page.waitForSelector('#tx-track-units',{timeout:3000});});
  afterEach(async()=>{await page?.close();});
  afterAll(async()=>{await browser?.close();if(server)await new Promise<void>(done=>server.close(()=>done()));});
  async function optIn(){await page.click('#tx-track-units');await page.type('#tx-unit-reason','Signed supplier delivery');}
  const posts=()=>requests.filter(row=>row.method==='POST');

  it('leaves receipt controls unchecked and hidden until the user opts in',async()=>{
    expect(await page.$eval('#tx-receipt-details',el=>(el as HTMLElement).hidden)).toBe(true);
    expect(await page.$eval('#tx-unit-reason',el=>(el as HTMLInputElement).disabled)).toBe(true);
    expect(await page.evaluate(()=>(window as any).readPurchaseReceiptTracking('tx'))).toBeNull();
    await page.click('#tx-track-units');expect(await page.$eval('#tx-receipt-details',el=>(el as HTMLElement).hidden)).toBe(false);
    expect(await page.evaluate(()=>(window as any).readPurchaseReceiptTracking('tx'))).toMatchObject({physicalPossessionConfirmed:true,inspectionPassed:true});
  });
  it('keeps compact checkboxes in Arabic/RTL under broad modal CSS on desktop and mobile',async()=>{
    await optIn();
    for(const width of [320,390,1000]){await page.setViewport({width,height:1000});const box=await page.$eval('#tx-track-units',el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));expect(box).toEqual({width:18,height:18});
      expect(await page.$eval('#tx-receipt',el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);}
    const folder=resolve(__dirname,'../../../artifacts/barcode-ui');mkdirSync(folder,{recursive:true});await page.evaluate(()=>{currentLang='ar';(window as any).renderTxFields();});await optIn();
    await (await page.$('#tx-receipt'))!.screenshot({path:resolve(folder,'manual-purchase-receipt.png')});
  });
  it('uses the real save/confirm functions to send one tracked receipt online and open its labels summary',async()=>{
    await optIn();await page.evaluate(()=>{(window as any).showPurchaseReceiptSummary=async(_id:any,saved:any)=>{(window as any).receivedSummary=saved;};return (window as any).saveTx();});
    expect(await page.evaluate(()=>(window as any).confirmedBody._unitTracking.physicalPossessionConfirmed)).toBe(true);
    await page.evaluate(()=>Promise.all([(window as any).confirmTxSave(),(window as any).confirmTxSave()]));
    expect(posts()).toHaveLength(1);expect(posts()[0].path).toBe('/api/inventory-units/purchases/receive');expect(posts()[0].data.invoice.total).toBe(40);
    expect(await page.evaluate(()=>({queue:(window as any).queuedCalls,guard:(window as any).guardCalls,units:(window as any).receivedSummary.receipt.createdUnits}))).toEqual({queue:0,guard:0,units:2});
  });
  it('keeps ordinary manual purchasing on its existing path when tracking is not selected',async()=>{
    await page.evaluate(async()=>{await (window as any).saveTx();await (window as any).confirmTxSave();});
    expect(posts()).toHaveLength(1);expect(posts()[0].path).toBe('/api/transactions');
    expect(await page.evaluate(()=>(window as any).queuedCalls)).toBe(1);
  });
  it('preserves the exact unknown request through reload and retries without the offline queue or a new key',async()=>{
    mode='failure';await optIn();await page.evaluate(async()=>{await (window as any).saveTx();await (window as any).confirmTxSave();});
    const first=posts()[0].data;expect(await page.$eval('#toast',el=>el.textContent)).toContain('outcome is unknown');
    await page.reload();await page.waitForSelector('#tx-track-units');mode='';
    await page.evaluate(async()=>{await (window as any).saveTx();(window as any).showPurchaseReceiptSummary=async()=>{};await (window as any).confirmTxSave();});
    expect(posts()).toHaveLength(2);expect(posts()[1].data).toEqual(first);expect(await page.evaluate(()=>(window as any).hasPendingManualPurchaseReceipt())).toBe(false);
    expect(await page.evaluate(()=>(window as any).queuedCalls)).toBe(0);
  });
  it('uses one confirmation checkbox and isolates PO/manual form identities',async()=>{
    await optIn();await page.evaluate(()=>{const po=document.createElement('div');po.innerHTML=(window as any).purchaseReceiptFields();document.body.append(po);});
    expect(await page.evaluate(()=>(window as any).readPurchaseReceiptTracking())).toBeNull();
    await page.click('#tx-track-units');expect(await page.evaluate(()=>(window as any).readPurchaseReceiptTracking('tx'))).toBeNull();
    await page.click('#tx-track-units');expect(await page.$$eval('#tx-receipt input[type=checkbox]',inputs=>inputs.length)).toBe(1);
    await page.evaluate(()=>{receiver=false;});expect(await page.evaluate(()=>(window as any).purchaseReceiptFields('tx'))).toBe('');
  });
  it('retains an uncertain financial request if a later retry is denied',async()=>{
    mode='failure';await optIn();await page.evaluate(async()=>{await (window as any).saveTx();await (window as any).confirmTxSave();});
    const first=posts()[0].data;mode='denied';await page.evaluate(async()=>{await (window as any).saveTx();await (window as any).confirmTxSave();});
    expect(await page.evaluate(()=>(window as any).hasPendingManualPurchaseReceipt())).toBe(true);expect(posts()[1].data).toEqual(first);
  });
  it('blocks before posting or creating a pending financial request when the server is not ready',async()=>{
    mode='not-ready';await optIn();await page.evaluate(async()=>{await (window as any).saveTx();await (window as any).confirmTxSave();});
    expect(posts()).toHaveLength(0);expect(await page.$eval('#toast',el=>el.textContent)).toContain('not configured');
    expect(await page.evaluate(()=>(window as any).hasPendingManualPurchaseReceipt())).toBe(false);
  });
});
