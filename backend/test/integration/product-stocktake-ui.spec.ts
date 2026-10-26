import { createServer, Server } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';

describe('Product stocktake workflow in Chromium', () => {
  let browser: Browser, page: Page, server: Server, origin: string, units: any[], calls: any[], replay: any, failAfterCommit: boolean;
  const productId = '507f1f77bcf86cd799439001';
  const unit = (i: number) => ({ _id: String(i).padStart(24, '0'), barcode: 'SU-' + String(i).padStart(24, '0'), manualCode: 'U-0000-' + String(i).padStart(4, '0') + '-1', productId, status: 'available' });
  const publicDir = resolve(__dirname, '../../../frontend/public');
  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true, ...(process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/product-stocktake.css"><style>body{font:15px Arial}</style><script>
        let currentLang='ar', currentUser={_id:'operator'}; let canRegister=true; window.selection=null;
        function hasPerm(p){return p!=='inventory-units-register'||canRegister;}
        async function api(path,options={}){const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const data=await r.json();if(!r.ok){const e=new Error(data.message);e.status=r.status;throw e;}return data;}
        window.InventoryUnitLabels={openStockUnits(scope){window.selection=scope;}};
        </script><script src="/product-stocktake.js"></script>`); return;
      }
      if (url.pathname.startsWith('/api/')) {
        let bytes = ''; for await (const chunk of req) bytes += chunk;
        const body = bytes ? JSON.parse(bytes) : null; calls.push({ path: url.pathname, body });
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname.endsWith('/stocktake')) { res.end(JSON.stringify({ product: { _id: productId, name: 'منتج A', code: 'A' }, balance: 25, registered: units.length, missing: 25 - units.length, assigned: 3, discrepancy: false, warehouseCode: 'MAIN', units })); return; }
        if (url.pathname.endsWith('/identify')) {
          if (!replay) {
            const created = Array.from({ length: body.physicalQuantity - body.expectedRegistered }, (_, i) => unit(units.length + i + 1));
            units.push(...created); replay = { stockChanged: false, unitIds: created.map(row => row._id) };
            if (failAfterCommit) { res.statusCode = 503; res.end(JSON.stringify({ message: 'Connection interrupted' })); return; }
          }
          res.end(JSON.stringify(replay)); return;
        }
      }
      if (['/product-stocktake.js', '/product-stocktake.css'].includes(url.pathname)) { res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css'); res.end(readFileSync(publicDir + url.pathname)); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = 'http://127.0.0.1:' + (server.address() as any).port;
  });
  beforeEach(async () => { units = Array.from({ length: 20 }, (_, i) => unit(i + 1)); calls = []; replay = null; failAfterCommit = false; page = await browser.newPage(); await page.goto(origin); });
  afterEach(async () => { await page.close(); });
  afterAll(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  async function open() { await page.evaluate(id => (window as any).ProductStocktake.open(id), productId); }
  async function scan(code: string) { await page.type('[data-count-code]', code); await page.keyboard.press('Enter'); }
  it('shows all 25 positions, marks scans green, and reuses two codes while registering only five missing codes', async () => {
    await page.setViewport({ width: 1200, height: 900 }); await open();
    expect(await page.$$('[data-count-rows] tr')).toHaveLength(25);
    for (let i = 0; i < 18; i++) await scan(units[i].manualCode);
    await scan(units[0].barcode); expect(await page.$$('[data-count-rows] .count-found')).toHaveLength(18);
    await scan('SU-999999999999999999999999'); expect(await page.$eval('[data-count-message]', el => el.textContent)).toContain('ليس ضمن');
    const folder = resolve(__dirname, '../../../artifacts/product-stocktake'); mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: resolve(folder, 'scanned.png') });
    await page.click('[data-count-finish]');
    expect(await page.$$('[data-count-rows] tr')).toHaveLength(7);
    await page.click('[data-count-print]'); expect(calls.filter(row => row.body)).toHaveLength(0);
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(folder, 'review-mobile.png') });
    expect(await page.$eval('dialog', el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.click('[data-count-confirm]'); await page.click('[data-count-print]');
    await page.waitForFunction(() => !!(window as any).selection);
    const selection = await page.evaluate(() => (window as any).selection);
    expect(selection.unitIds).toEqual([unit(19)._id, unit(20)._id, ...[21, 22, 23, 24, 25].map(i => unit(i)._id)]);
    expect(calls.find(row => row.body).body).toMatchObject({ physicalQuantity: 25, expectedRegistered: 20, expectedBalance: 25, physicalPossessionConfirmed: true });
    expect(units).toHaveLength(25);
  }, 20000);
  it('reprints existing unscanned codes without creating identities', async () => {
    units = Array.from({ length: 25 }, (_, i) => unit(i + 1)); await open();
    await scan(units[0].barcode); await page.click('[data-count-finish]');
    await page.click('[data-count-confirm]'); await page.click('[data-count-print]');
    await page.waitForFunction(() => !!(window as any).selection);
    expect(await page.evaluate(() => (window as any).selection.unitIds.length)).toBe(24);
    expect(calls.some(row => row.path.endsWith('/identify'))).toBe(false);
  });
  it('recovers the same registration after an uncertain result and reopening', async () => {
    failAfterCommit = true; await open(); await page.click('[data-count-finish]');
    await page.click('[data-count-confirm]'); await page.click('[data-count-print]');
    await page.waitForFunction(() => document.querySelector('[data-count-message]')!.textContent!.includes('Connection interrupted'));
    await page.click('[data-count-close]'); await page.reload(); await open();
    await page.click('[data-count-print]'); await page.waitForFunction(() => !!(window as any).selection);
    const attempts = calls.filter(row => row.path.endsWith('/identify'));
    expect(attempts).toHaveLength(2); expect(attempts[0].body).toEqual(attempts[1].body);
    expect(units).toHaveLength(25);
    expect(new Set(await page.evaluate(() => (window as any).selection.unitIds)).size).toBe(25);
  });
  it('allows scanning and reprinting but excludes new codes without registration permission', async () => {
    await page.evaluate(() => (window as any).eval('canRegister=false')); await open(); await page.click('[data-count-finish]');
    expect(await page.$$eval('[data-count-choice^="new:"]', nodes => nodes.every(node => (node as HTMLInputElement).disabled && !(node as HTMLInputElement).checked))).toBe(true);
    await page.click('[data-count-confirm]'); await page.click('[data-count-print]');
    await page.waitForFunction(() => !!(window as any).selection);
    expect(calls.some(row => row.path.endsWith('/identify'))).toBe(false);
  });
});
