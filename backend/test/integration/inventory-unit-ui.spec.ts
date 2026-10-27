import { createServer, Server } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import * as QRCode from 'qrcode';
import { LABEL_SIZES } from '../../src/inventory-units/inventory-units.service';

describe('Actual barcode management script in Chromium', () => {
  let browser: Browser, server: Server, origin: string, page: Page;
  let calls: any[], labels: any[], units: any[], receipts: any[], deny: boolean, printer: boolean, failOnce: boolean, configMissing: boolean, listFailure: boolean;
  const sizes = [...LABEL_SIZES];
  const publicDir = resolve(__dirname, '../../../frontend/public');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>:root{--border:#ddd;--bg:#fafafa;--surface:#fff;--text:#222;--muted:#666}body{margin:0;padding:12px;font:14px Arial}</style><link rel="stylesheet" href="/inventory-units.css"></head><body><main id="page-barcodes"></main><script>
    let currentLang='en';let currentPage='barcodes';let printer=true;let receiver=true;let currentUser={_id:'507f1f77bcf86cd799439099'};
    function hasPerm(p){return p==='inventory-units-print'?printer:p==='inventory-units-receive'?receiver:true;}
    async function api(path,options={}){const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok){const e=new Error(d.message);e.status=r.status;throw e;}return d;}
    </script><link rel="stylesheet" href="/inventory-scanner.css"><link rel="stylesheet" href="/purchase-receiving.css"><script src="/inventory-scanner.js"></script><script src="/inventory-units.js"></script><script src="/purchase-receiving.js"></script></body></html>`;
  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true, timeout: 20000, ...(process.platform === 'win32' ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
    for (const initialTab of await browser.pages()) await initialTab.close();
    server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of request) body += chunk;
        const data = body ? JSON.parse(body) : null; calls.push({ path: url.pathname, data, search: url.search });
        response.setHeader('Content-Type', 'application/json');
        if (deny) { response.statusCode = 403; response.end(JSON.stringify({ message: 'Permission denied' })); return; }
        if (url.pathname.endsWith('/config') && configMissing) { response.statusCode = 404; response.end(JSON.stringify({ message: 'Cannot GET /api/inventory-units/config' })); return; }
        if (url.pathname === '/api/inventory-units' && listFailure) { response.statusCode = 503; response.end(JSON.stringify({ message: 'Unavailable' })); return; }
        if (url.pathname.endsWith('/config')) response.end(JSON.stringify({ statuses: ['available', 'inspection-required'], labelSizes: sizes }));
        else if (url.pathname.endsWith('/purchases/receipts')) {
          const q = (url.searchParams.get('q') || '').toLowerCase(), id = url.searchParams.get('transactionId');
          const found = receipts.filter(inv => (!id || inv.transactionId === id) && (!q || (inv.ref + inv.supplier + inv.lines.map((line: any) => line.name + line.sku).join(' ')).toLowerCase().includes(q)));
          const index = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 20);
          response.end(JSON.stringify({ receipts: found.slice((index - 1) * limit, index * limit), total: found.length, page: index, limit }));
        }
        else if (/\/purchases\/[^/]+\/lines\/\d+\/units$/.test(url.pathname)) {
          const parts = url.pathname.split('/'), inv = receipts.find(r => r.transactionId === parts[4]), line = inv?.lines[Number(parts[6])];
          const found = line ? units.filter(unit => unit.origin?.purchaseTransactionId === inv.transactionId && unit.product.code === line.sku && (!unit.origin.purchaseLineId || unit.origin.purchaseLineId === line.lineId)) : [];
          const index = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 30);
          response.end(JSON.stringify({ units: found.slice((index - 1) * limit, index * limit), total: found.length, page: index, limit }));
        }
        else if (/\/purchases\/[^/]+\/lines\/\d+\/identify$/.test(url.pathname)) {
          const parts = url.pathname.split('/'), inv = receipts.find(r => r.transactionId === parts[4]), line = inv.lines[Number(parts[6])];
          const quantity = data.physicalQuantity - line.onHandUnits;
          for (let i = 0; i < quantity; i++) await addFixtureUnit(inv, line);
          line.createdUnits += quantity; line.onHandUnits += quantity;
          response.end(JSON.stringify({ lineId: line.lineId, createdUnits: quantity, stockChanged: false }));
        }
        else if (url.pathname.endsWith('/scans/validate')) response.end(JSON.stringify({ outcome: 'accepted', code: 'VALIDATED', operationId: 'f'.repeat(64), unit: { _id: labels[0].unitId, barcode: labels[0].barcode } }));
        else if (/\/labels\//.test(url.pathname)) {
          if (url.pathname.endsWith('/requests') && failOnce) { failOnce = false; response.statusCode = 503; response.end(JSON.stringify({ message: 'Injected uncertain network result' })); return; }
          response.end(JSON.stringify({ size: sizes.find(size => size.id === data.sizeId), labels: labels.filter(label => data.unitIds.includes(label.unitId)), physicalPrintingVerified: false }));
        } else {
          const q = url.searchParams.get('q') || '';
          const found = units.filter(unit => (!url.searchParams.get('unitIds') || url.searchParams.get('unitIds')!.split(',').includes(unit._id)) && (!q || [unit.barcode, unit._id, unit.product.name, unit.product.code, 'XL', 'Red'].some(value => value.toLowerCase().includes(q.toLowerCase()))) && (!url.searchParams.get('status') || unit.status === url.searchParams.get('status')));
          const index = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 30);
          response.end(JSON.stringify({ products: q && !found.length ? [] : [{ _id: 'product-1', name: 'Cotton Shirt', code: 'SKU-1', size: 'XL', colors: ['Red'] }], units: found.slice((index - 1) * limit, index * limit), total: found.length, page: index, limit }));
        }
      } else if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); }
      else if (['/inventory-units.js', '/inventory-units.css', '/purchase-receiving.js', '/purchase-receiving.css', '/inventory-scanner.js', '/inventory-scanner.css', '/vendor/zxing-browser-0.2.1.min.js'].includes(url.pathname)) {
        response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css'); response.end(readFileSync(publicDir + url.pathname));
      } else { response.statusCode = 404; response.end(); }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 30000);
  beforeEach(async () => {
    calls = []; receipts = []; deny = false; printer = true; failOnce = false; configMissing = false; listFailure = false;
    labels = await Promise.all(['507f1f77bcf86cd799439031', '507f1f77bcf86cd799439032'].map(async id => {
      const barcode = 'SU-' + id.toUpperCase(); return { unitId: id, barcode, productName: 'Cotton Shirt', sku: 'SKU-1', sellPrice: 249.5, receivedDate: '2026-10-17', svg: await QRCode.toString(barcode, { type: 'svg', margin: 4 }) };
    }));
    units = labels.map(label => ({ _id: label.unitId, barcode: label.barcode, status: 'available', product: { code: label.sku, name: label.productName } }));
    page = await browser.newPage(); await page.goto(origin); await page.click('#iu-tab-units'); await page.waitForSelector('#iu-units [data-unit-id]');
  });
  afterEach(async () => { if (browser) for (const tab of await browser.pages()) await tab.close(); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(done => server.close(() => done())); });
  async function selectPreview(size = '60x40') {
    await page.click('#iu-select-page'); await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('[data-unit-id]')].every(input => input.checked));
    await page.select('#iu-size', size); await page.click('#iu-preview'); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
  }
  it('previews only the exact stocktake IDs passed from the product count', async () => {
    await page.evaluate(ids => window.InventoryUnitLabels.openStockUnits({ unitIds: ids, preview: true }), [units[1]._id]);
    await page.waitForFunction(() => !!document.querySelector('#iu-preview-section[open]') && !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    expect(await page.evaluate(() => window.InventoryUnitLabels.selection().ids)).toEqual([units[1]._id]);
    expect(await page.$$('#iu-previews .iu-label')).toHaveLength(1);
    expect(calls.some(call => call.search?.includes('unitIds=' + units[1]._id))).toBe(true);
  });
  it.each(['shipped', 'delivered'])('shows confirmed order %s instead of the older prepared unit status', async status => {
    units[0] = { ...units[0], status: 'prepared', displayStatus: status, statusSource: 'order' };
    units[1] = { ...units[1], status: 'prepared', displayStatus: 'prepared', statusSource: 'unit' };
    await page.evaluate(() => window.renderBarcodeManagement());
    await page.waitForSelector('#iu-units [data-unit-id]');
    expect(await page.$eval(`[data-log-unit="${units[0]._id}"] .iu-status-pill`, el => el.textContent)).toBe(status === 'shipped' ? 'Shipped' : 'Delivered');
    expect(await page.$eval(`[data-log-unit="${units[1]._id}"] .iu-status-pill`, el => el.textContent)).toBe('Prepared');
    await page.evaluate(() => { currentLang = 'ar'; return window.renderBarcodeManagement(); });
    expect(await page.$eval(`[data-log-unit="${units[0]._id}"] .iu-status-pill`, el => el.textContent)).toBe(status === 'shipped' ? 'مع شركة الشحن' : 'تم تسليمها');
  });
  it('fits long product text and invoice dates on 50x25 labels without shrinking the QR', async () => {
    labels[0] = { ...labels[0], productName: 'Sandora-Deep Gray- organize L', sku: 'RIVA-COASTER-SMALL', manualCode: 'U-0000-0166-9', invoiceDate: '2026-10-26' };
    labels[1] = { ...labels[1], productName: 'سلة تنظيم رمادي غامق كبيرة', sku: 'RIVA-TISSUE', manualCode: 'U-0000-0167-7', invoiceDate: '2026-10-26' };
    await selectPreview('50x25');
    const check = async (target: Page) => target.evaluate(async () => {
      const root = document.querySelector('#iu-previews') || document;
      await window.InventoryUnitLabels?.waitForLayout(root);
      return [...root.querySelectorAll('.iu-label')].map(label => {
        const image = label.querySelector('img')!, text = label.querySelector('.iu-label-text')!, code = label.querySelector('.iu-label-value')!;
        const last = [...text.children].filter(child => getComputedStyle(child).display !== 'none').at(-1)!;
        return { qr: getComputedStyle(image).width, font: parseFloat(getComputedStyle(label.querySelector('.iu-label-name')!).fontSize), bottom: last.getBoundingClientRect().bottom, codeTop: code.getBoundingClientRect().top };
      });
    });
    for (const row of await check(page)) { expect(parseFloat(row.qr)).toBeCloseTo(20 * 96 / 25.4, 1); expect(row.font).toBeGreaterThanOrEqual(2 * 96 / 25.4 - .01); expect(row.bottom).toBeLessThanOrEqual(row.codeTop); }
    const folder = resolve(__dirname, '../../../artifacts/label-fit'); mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: resolve(folder, 'compact-preview.png') });
    await page.select('#iu-preview-zoom', '200');
    await check(page);
    const target = browser.waitForTarget(target => target.type() === 'page' && target.url() === 'about:blank');
    await page.click('#iu-print'); const popup = await (await target).page();
    await page.waitForFunction(() => !!document.querySelector('#iu-preview-section .iu-print-success'));
    for (const row of await check(popup!)) { expect(parseFloat(row.qr)).toBeCloseTo(20 * 96 / 25.4, 1); expect(row.bottom).toBeLessThanOrEqual(row.codeTop); }
    await popup!.close();
    await page.click('#iu-preview-section [data-iu-close]');
    labels[0].productName = 'W'.repeat(600);
    await page.click('#iu-select-page'); await page.select('#iu-size', '50x25'); await page.click('#iu-preview');
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('Product text is too long'));
    expect(await page.$eval('#iu-print', el => (el as HTMLButtonElement).disabled)).toBe(true);
  }, 15000);
  async function addFixtureUnit(invoice: any, line: any) {
    const id = String(1000 + units.length).padStart(24, '0'), barcode = 'SU-' + id.toUpperCase();
    const label = { unitId: id, barcode, productName: line.name, sku: line.sku, sellPrice: 249.5, svg: await QRCode.toString(barcode, { type: 'svg', margin: 4 }) };
    labels.push(label);
    units.push({ _id: id, barcode, productId: line.sku, product: { code: line.sku, name: line.name }, status: 'available', warehouseCode: 'Main', origin: { purchaseTransactionId: invoice.transactionId, purchaseLineId: line.lineId } });
  }
  async function invoiceWorkspace(large = false) {
    await page.setViewport({ width: 1440, height: 1000 });
    receipts = [
      { transactionId: '507f1f77bcf86cd799439051', ref: '900011', supplier: 'Supplier One', date: '2026-10-19', lines: [
        { lineIndex: 0, lineId: 'basket-line', sku: 'BASKET-1', name: 'Lovely Basket', quantity: large ? 120 : 20, createdUnits: large ? 120 : 20, onHandUnits: large ? 120 : 20 },
        { lineIndex: 1, lineId: 'blanket-line', sku: 'BLANKET-1', name: 'Cotton Blanket', quantity: 20, createdUnits: 20, onHandUnits: 20 },
        { lineIndex: 2, lineId: 'missing-line', sku: 'SKU-10', name: 'Uncoded product', quantity: 5, createdUnits: 0, onHandUnits: 0 },
      ] },
      { transactionId: '507f1f77bcf86cd799439052', ref: '900010', supplier: 'Supplier Two', date: '2026-10-18', lines: [
        { lineIndex: 0, lineId: 'other-line', sku: 'OTHER', name: 'Another basket', quantity: 2, createdUnits: 2, onHandUnits: 2 },
      ] },
    ];
    units = []; labels = [];
    for (const inv of receipts) for (const line of inv.lines) for (let i = 0; i < line.createdUnits; i++) await addFixtureUnit(inv, line);
    await page.evaluate(() => { history.replaceState(null, '', '/'); return window.renderBarcodeManagement(); });
    await page.click('#iu-tab-receipts');
    await page.waitForSelector('[data-select-line="0"]');
  }
  async function expectSelected(count: number) {
    try { await page.waitForFunction(count => document.querySelector('#iu-stat-selected')!.textContent === String(count), { timeout: 3000 }, count); }
    catch { throw new Error(`Expected ${count} selected: ` + await page.$eval('#page-barcodes', e => e.textContent)); }
  }
  it('prints one separator between grouped products and none for a single product', async () => {
    await invoiceWorkspace();
    const line = receipts[0].lines[1]; line.quantity = line.createdUnits = line.onHandUnits = 10;
    const removed = new Set(units.filter(unit => unit.product.code === line.sku).slice(10).map(unit => unit._id));
    units = units.filter(unit => !removed.has(unit._id)); labels = labels.filter(label => !removed.has(label.unitId));
    const a = labels.filter(label => label.sku === 'BASKET-1'), b = labels.filter(label => label.sku === 'BLANKET-1');
    labels = [...a.flatMap((label, i) => b[i] ? [label, b[i]] : [label]), ...labels.filter(label => !['BASKET-1', 'BLANKET-1'].includes(label.sku))];
    await page.reload(); await page.waitForSelector('[data-select-line="0"]');
    await page.click('[data-select-line="0"]'); await expectSelected(20);
    await page.select('#iu-size', '50x25'); await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    expect(await page.$$('.iu-label-separator')).toHaveLength(0);
    await page.click('#iu-preview-section [data-iu-close]');
    await page.click('[data-select-line="1"]'); await expectSelected(30);
    await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    expect(await page.$eval('#iu-preview-total', el => el.textContent)).toBe('30 piece label(s) + 1 separator(s)');
    const order = await page.$$eval('#iu-previews .iu-label', els => els.map(el => el.classList.contains('iu-label-separator') ? 'separator' : el.querySelector('.iu-label-sku')!.textContent));
    expect(order).toEqual([...Array(20).fill('SKU: BASKET-1'), 'separator', ...Array(10).fill('SKU: BLANKET-1')]);
    const target = browser.waitForTarget(target => target.type() === 'page' && target.url() === 'about:blank');
    await page.click('#iu-print'); const popup = await (await target).page();
    await page.waitForFunction(() => !!document.querySelector('#iu-preview-section .iu-print-success'));
    expect(await popup!.$$eval('.iu-print-sheet', els => els.length)).toBe(31);
    expect(await popup!.$eval('.iu-label-separator', el => el.textContent)).toBe('فاصل');
    expect(await popup!.$$eval('.iu-label-separator img', els => els.length)).toBe(0);
    expect(await popup!.$$eval('.iu-label', els => els.map(el => el.classList.contains('iu-label-separator') ? 'separator' : el.querySelector('.iu-label-sku')!.textContent))).toEqual(order);
    const pdf = Buffer.from(await popup!.pdf({ preferCSSPageSize: true })).toString('latin1');
    expect((pdf.match(/\/Type \/Page\b/g) || []).length).toBe(31);
    expect(calls.find(call => call.path.endsWith('/requests')).data.unitIds).toHaveLength(30);
    await popup!.close();
  }, 15000);
  it('audits physical labels across pages, rejects duplicates and foreign codes, and previews only unchecked identities', async () => {
    await invoiceWorkspace(true);
    units[0].manualCode = 'U-0000-0001-1';
    await page.select('#iu-size', '60x40');
    await page.click('[data-view-line="0"]');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-audit-start')!.disabled);
    await page.click('#iu-audit-start');
    await page.waitForSelector('#iu-audit-code');
    const scan = async (code: string) => { await page.type('#iu-audit-code', code); await page.keyboard.press('Enter'); };
    await scan(units[0].manualCode);
    await scan(units[0].barcode);
    expect(await page.$eval('#iu-audit-feedback', el => el.textContent)).toContain('Already checked');
    await scan(units[120].barcode);
    expect(await page.$eval('#iu-audit-feedback', el => el.textContent)).toContain('does not belong');
    // A piece on a different API page must still be recognized.
    await scan(units[119].barcode);
    expect(await page.$eval('#iu-label-audit', el => el.textContent)).toContain('2 checked');
    const auditArtifacts = resolve(__dirname, '../../../artifacts/label-audit'); mkdirSync(auditArtifacts, { recursive: true });
    await page.screenshot({ path: resolve(auditArtifacts, 'desktop.png') });
    await page.setViewport({ width: 390, height: 844 });
    expect(await page.$eval('#iu-label-audit', el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: resolve(auditArtifacts, 'mobile.png') });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.click('#iu-line-next');
    await page.waitForFunction(() => document.querySelector('#iu-line-units-meta')!.textContent!.includes('page 2'));
    expect(await page.$eval('#iu-label-audit', el => el.textContent)).toContain('2 checked');
    await page.click('#iu-audit-preview');
    await page.waitForSelector('#iu-preview-section[open]');
    await expectSelected(100);
    const selected = await page.evaluate(() => window.InventoryUnitLabels.selection().ids);
    expect(selected).not.toContain(units[0]._id);
    expect(selected).not.toContain(units[119]._id);
    expect(selected.every((id: string) => units.slice(0, 120).some(unit => unit._id === id))).toBe(true);
    expect(calls.some(call => call.path.endsWith('/requests') || call.path.endsWith('/identify'))).toBe(false);
    await page.click('#iu-preview-section [data-iu-close]');
    await page.click('[data-view-line="0"]');
    await page.waitForSelector('.iu-audit-mark[data-checked="true"]');
    await page.click('.iu-audit-mark[data-checked="true"]');
    expect(await page.$eval('#iu-label-audit', el => el.textContent)).toContain('1 checked');
    await page.click('#iu-audit-reset');
    await page.waitForFunction(() => document.querySelector('#iu-label-audit')!.textContent!.includes('0 checked'));
    await page.evaluate(() => { currentLang = 'ar'; return window.renderBarcodeManagement(); });
    await page.click('[data-view-line="0"]');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-audit-start')!.disabled);
    await page.click('#iu-audit-start');
    await page.waitForSelector('#iu-audit-code');
    await scan(units[0].manualCode);
    expect(await page.$eval('#iu-audit-feedback', el => el.textContent)).toContain('تم فحص الملصق');
    await page.screenshot({ path: resolve(auditArtifacts, 'arabic.png') });
  }, 15000);
  it('opens the shared scanner only on demand and validates without purchasing or printing', async () => {
    expect(await page.$('[data-scan-input]')).toBeNull(); await page.click('#iu-open-scanner');
    await page.type('[data-scan-input]', labels[0].barcode); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-scan-message]')!.textContent!.includes('Piece identified'));
    expect(calls.filter(call => call.path.endsWith('/scans/validate'))).toHaveLength(1);
    expect(calls.some(call => call.path.endsWith('/requests') || call.path.includes('/convert'))).toBe(false);
    expect(await page.$('[data-scan-video]:not([hidden])')).toBeNull();
  });
  it('separates SKU/products from individual units, uses no implicit label size and has no mobile overflow', async () => {
    for (const width of [320, 360, 768, 1280]) {
      await page.setViewport({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await page.$eval('#iu-size', el => (el as HTMLSelectElement).value)).toBe('');
    expect(await page.$eval('#iu-products', el => el.textContent)).toContain('SKU-1');
    expect(await page.$$eval('#iu-units code', els => els.map(el => el.textContent))).toContain(labels[0].unitId);
  });
  it('shows a missing API explanation, disables unsafe controls, and recovers through retry', async () => {
    configMissing = true; await page.evaluate(() => window.renderBarcodeManagement());
    expect(await page.$eval('#iu-error-title', el => el.textContent)).toBe('Barcode service unavailable');
    expect((await page.$eval('#iu-error-detail', el => el.textContent))?.toLowerCase()).toContain('rebuild and restart');
    for (const selector of ['#iu-query', '#iu-status', '#iu-size', '#iu-open-scanner', '#iu-select-page', '#iu-preview', '#iu-print', '#iu-next']) {
      expect(await page.$eval(selector, el => (el as HTMLButtonElement).disabled)).toBe(true);
    }
    expect(await page.$eval('#iu-stat-units', el => el.textContent)).toBe('—');
    configMissing = false; await page.click('#iu-retry'); await page.waitForSelector('[data-unit-id]');
    expect(await page.$eval('#iu-error', el => (el as HTMLElement).hidden)).toBe(true);
    expect(await page.$eval('#iu-connection', el => el.textContent)).toBe('Connected');
    expect(await page.$eval('#iu-stat-units', el => el.textContent)).toBe('2');
    expect(await page.$eval('#iu-size', el => (el as HTMLSelectElement).value)).toBe('');
  });
  it('keeps failed data requests distinct from empty stock and recovers without losing the search', async () => {
    listFailure = true; await page.type('#iu-query', 'Cotton');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#iu-unit-error')!.hidden);
    expect(await page.$eval('#iu-stat-units', el => el.textContent)).toBe('—');
    expect(await page.$eval('#iu-units', el => el.textContent)).toContain('could not be loaded');
    listFailure = false; await page.click('#iu-unit-retry'); await page.waitForSelector('[data-unit-id]');
    expect(await page.$eval('#iu-query', el => (el as HTMLInputElement).value)).toBe('Cotton');
    expect(await page.$eval('#iu-stat-units', el => el.textContent)).toBe('2');
  });
  it('updates selection counts immediately, validates preview visibility and clears it on size changes', async () => {
    await page.click('#iu-select-page'); expect(await page.$eval('#iu-stat-selected', el => el.textContent)).toBe('2');
    await page.select('#iu-size', '60x40'); await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    expect(await page.$eval('#iu-preview-section', el => (el as HTMLElement).hidden)).toBe(false);
    await page.click('[data-iu-close="iu-preview-section"]');
    await page.select('#iu-size', '80x50'); expect(await page.$eval('#iu-preview-section', el => (el as HTMLElement).hidden)).toBe(true);
    expect(await page.$eval('#iu-print', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await page.click('#iu-clear'); expect(await page.$eval('#iu-stat-selected', el => el.textContent)).toBe('0');
  });
  it('ignores an outdated configuration response after a newer page render', async () => {
    await page.evaluate(async () => {
      const original = (window as any).api; let first = true;
      (window as any).api = (path: string, options: any) => {
        if (path.endsWith('/config') && first) { first = false; return new Promise(resolve => { (window as any).finishOldConfig = resolve; }); }
        return original(path, options);
      };
      (window as any).oldRender = window.renderBarcodeManagement();
      await window.renderBarcodeManagement();
      (window as any).finishOldConfig({ statuses: ['BAD-OLD-STATUS'], labelSizes: [] }); await (window as any).oldRender;
    });
    expect(await page.$eval('#iu-status', el => el.textContent)).not.toContain('BAD-OLD-STATUS');
    expect(await page.$$('[data-unit-id]')).toHaveLength(2);
  });
  it('searches shared SKU and exact unit barcode, applies status filters, and reports genuine empty results', async () => {
    await page.type('#iu-query', 'SKU-1'); await page.waitForResponse(response => response.url().includes('q=SKU-1'));
    await page.waitForFunction(() => document.querySelector('#iu-stat-units')!.textContent === '2');
    await page.select('#iu-status', 'inspection-required'); await page.waitForFunction(() => document.querySelector('#iu-stat-units')!.textContent === '0');
    expect(await page.$eval('#iu-error', el => (el as HTMLElement).hidden)).toBe(true);
    expect(calls.some(call => call.search.includes('status=inspection-required'))).toBe(true);
    await page.select('#iu-status', ''); await page.$eval('#iu-query', el => { (el as HTMLInputElement).value = ''; });
    await page.type('#iu-query', labels[0].barcode); await page.waitForFunction(() => document.querySelector('#iu-stat-units')!.textContent === '1');
    expect(await page.$$('[data-unit-id]')).toHaveLength(1);
  });
  it('captures the redesigned desktop and mobile review states', async () => {
    const folder = resolve(__dirname, '../../../artifacts/barcode-ui'); mkdirSync(folder, { recursive: true });
    await page.setViewport({ width: 1440, height: 1100 }); await page.screenshot({ path: resolve(folder, 'desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 1000 }); await page.screenshot({ path: resolve(folder, 'mobile.png'), fullPage: true });
    configMissing = true; await page.evaluate(() => window.renderBarcodeManagement());
    await page.screenshot({ path: resolve(folder, 'service-unavailable.png'), fullPage: true });
  });
  it.each(sizes.map(size => size.id))('previews readable, exact %s dimensions and distinct server values', async size => {
    await selectPreview(size);
    const boxes = await page.$$eval('.iu-label', els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, text: el.textContent })));
    const template = sizes.find(row => row.id === size)!;
    expect(boxes).toHaveLength(2); expect(boxes[0].width).toBeCloseTo(template.widthMm * 96 / 25.4, 0);
    expect(boxes[0].height).toBeCloseTo(template.heightMm * 96 / 25.4, 0); expect(boxes[0].text).toContain(labels[0].barcode);
    expect(await page.$eval('.iu-label-brand', el => el.textContent)).toBe('SOULIA HOME');
    expect(await page.$eval('.iu-label-brand', el => getComputedStyle(el).textAlign)).toBe('right');
    expect(await page.$eval('.iu-label-price', el => el.textContent)).toBe('EGP 249.50');
    expect(await page.$eval('.iu-label-print-date', el => el.textContent)).toContain(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()));
    expect(await page.$eval('.iu-label-date', el => el.textContent)).toContain('2026-10-17');
    expect(await page.$eval('.iu-label-id span', el => el.textContent!.replace(/\s/g, ''))).toBe(labels[0].unitId);
    expect(await page.$eval('.iu-label', el => getComputedStyle(el, ':before').borderStyle)).toBe('solid');
    const folder = resolve(__dirname, '../../../artifacts/barcode-ui'); mkdirSync(folder, { recursive: true });
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 203 / 96 });
    await (await page.$('.iu-label'))!.screenshot({ path: resolve(folder, `label-${size}.png`) });
    const qr = await (await page.$('.iu-label img'))!.screenshot({ encoding: 'base64' });
    await page.addScriptTag({ url: origin + '/vendor/zxing-browser-0.2.1.min.js' });
    expect(await page.evaluate(async png => {
      const reader = new (window as any).ZXingBrowser.BrowserQRCodeReader();
      return (await reader.decodeFromImageUrl('data:image/png;base64,' + png)).getText();
    }, qr)).toBe(labels[0].barcode);
    expect(calls.some(call => call.path.endsWith('/requests'))).toBe(false);
  });
  it.each(sizes.map(size => size.id))('prints framed %s pages at exact dimensions and never claims physical success', async sizeId => {
    await selectPreview(sizeId);
    if (sizeId === '60x40') await page.select('#iu-preview-zoom', '150');
    const target = browser.waitForTarget(target => target.type() === 'page' && target.url() === 'about:blank');
    await page.click('#iu-print'); const popup = await (await target).page(); expect(popup).not.toBeNull();
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('physical printing is unverified'));
    await popup!.emulateMediaType('print');
    expect(await popup!.$$eval('.iu-label', els => els.length)).toBe(2);
    const pdf = await popup!.pdf({ preferCSSPageSize: true, printBackground: true });
    const pdfText = Buffer.from(pdf).toString('latin1');
    const boxes = [...pdfText.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
    const template = sizes.find(size => size.id === sizeId)!;
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(Math.abs(Number(box[1]) - template.widthMm * 72 / 25.4)).toBeLessThan(0.6);
      expect(Math.abs(Number(box[2]) - template.heightMm * 72 / 25.4)).toBeLessThan(0.6);
    }
    expect((pdfText.match(/\/Type \/Page\b/g) || []).length).toBe(2);
    expect(calls.filter(call => call.path.endsWith('/requests'))).toHaveLength(1);
  });
  it('keeps the request key on retry and prevents repeat clicks during a print request', async () => {
    await selectPreview(); failOnce = true; await page.click('#iu-print');
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('Retry uses the same request key'));
    await page.click('#iu-print');
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('physical printing is unverified'));
    const requests = calls.filter(call => call.path.endsWith('/requests'));
    expect(requests).toHaveLength(2); expect(requests[0].data).toEqual(requests[1].data);
    expect(new Set(requests[0].data.unitIds).size).toBe(2);
  });
  it('clears printed product selection on preview close but retains unprinted and failed batches', async () => {
    await invoiceWorkspace();
    await page.click('[data-select-line="0"]'); await expectSelected(20);
    await page.select('#iu-size', '60x40'); await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    await page.click('#iu-preview-section [data-iu-close]');
    await expectSelected(20);
    await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    failOnce = true;
    await page.click('#iu-print');
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('Retry uses the same request key'));
    await page.click('#iu-preview-section [data-iu-close]');
    await expectSelected(20);
    await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    const target = browser.waitForTarget(target => target.type() === 'page' && target.url() === 'about:blank');
    await page.click('#iu-print'); const popup = await (await target).page();
    await page.waitForFunction(() => !!document.querySelector('#iu-preview-section .iu-print-success') && !window.InventoryUnitLabels.selection().busy);
    await popup!.close();
    await page.keyboard.press('Escape');
    await expectSelected(0);
    expect(await page.$eval('[data-select-line="0"]', el => (el as HTMLInputElement).checked)).toBe(false);
    expect(await page.$eval('#iu-select-invoice', el => (el as HTMLInputElement).indeterminate)).toBe(false);
    await page.click('[data-select-line="1"]'); await expectSelected(20);
    const selected = await page.evaluate(() => window.InventoryUnitLabels.selection().ids);
    expect(selected.every((id: string) => units.find(unit => unit._id === id)?.product.code === 'BLANKET-1')).toBe(true);
  }, 15000);
  it('blocks overflowing labels, unsafe text and mismatched barcode identities', async () => {
    labels[0].productName = 'W'.repeat(600);
    await page.click('#iu-select-page'); await page.select('#iu-size', '60x40'); await page.click('#iu-preview');
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('overflows'));
    expect(await page.$eval('#iu-print', el => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.evaluate(() => window.InventoryUnitLabels.labelHtml({ unitId: '507f1f77bcf86cd799439031', barcode: 'SU-507F1F77BCF86CD799439031', productName: '<img src=x onerror=alert(1)>', sku: 'A', svg: '<svg/>' }, { widthMm: 60, heightMm: 40, qrMm: 23 }))).toContain('&lt;img');
    await expect(page.evaluate(() => window.InventoryUnitLabels.labelHtml({ unitId: 'wrong', barcode: 'SKU-1' }, {}))).rejects.toThrow('Invalid backend label identity');
  });
  it('shows empty, permission-denied and translated mobile states', async () => {
    await page.type('#iu-query', 'missing'); await page.waitForFunction(() => document.querySelector('#iu-units')!.textContent!.includes('No tracked units'));
    await page.evaluate(() => { currentLang = 'ar'; return window.renderBarcodeManagement(); });
    expect(await page.$eval('h1', el => el.textContent)).toBe('إدارة الباركود');
    deny = true; await page.evaluate(() => window.renderBarcodeManagement());
    expect(await page.$eval('#iu-error-title', el => el.textContent)).toBe('الصلاحية غير متاحة');
  });
  it('does not offer printing without explicit permission', async () => {
    await page.evaluate(() => { printer = false; return window.renderBarcodeManagement(); });
    await page.click('[data-unit-id]'); await page.select('#iu-size', '60x40'); await page.click('#iu-preview');
    await page.waitForFunction(() => document.querySelector('#iu-message')!.textContent!.includes('Preview validated'));
    expect(await page.$eval('#iu-print', el => (el as HTMLButtonElement).disabled)).toBe(true);
  });
  it('requires explicit receipt opt-in, custody and location without generating any unit identity', async () => {
    await page.evaluate(() => { const form = document.createElement('div'); form.id = 'receipt-fields'; form.innerHTML = (window as any).purchaseReceiptFields(); document.body.append(form); });
    expect(await page.evaluate(() => (window as any).readPurchaseReceiptTracking())).toBeNull();
    await page.click('#conv-track-units');
    await expect(page.evaluate(() => (window as any).readPurchaseReceiptTracking())).rejects.toThrow('Confirm physical receipt');
    await page.type('#conv-unit-warehouse', 'COUNTED-LOCATION'); await page.type('#conv-unit-reason', 'Signed receipt'); await page.click('#conv-unit-possession');
    expect(await page.evaluate(() => (window as any).readPurchaseReceiptTracking())).toEqual({ warehouseCode: 'COUNTED-LOCATION', reason: 'Signed receipt', physicalPossessionConfirmed: true });
    expect(await page.evaluate(() => { receiver = false; return (window as any).purchaseReceiptFields(); })).toBe('');
    expect(calls.some(call => call.path.includes('/convert'))).toBe(false);
  });
  it('shows the receipt summary and opens existing identities with a visible invoice filter for immediate or later printing', async () => {
    await invoiceWorkspace();
    const transactionId = '507f1f77bcf86cd799439051';
    await page.evaluate(async transactionId => {
      const original = (window as any).api;
      (window as any).api = (path: string, options: any) => path.includes('/purchase-orders/') ? Promise.resolve({ transactionId, createdUnits: 2, labelRequests: 0,
        physicalPrintingVerified: false, lines: [{ sku: 'SKU-1', receivedQty: 2, createdUnits: 2 }], unresolvedErrors: [] }) : original(path, options);
      (window as any).esc = (value: any) => { const el = document.createElement('div'); el.textContent = String(value); return el.innerHTML; };
      (window as any).openModal = (content: string) => { const modal = document.createElement('div'); modal.id = 'receipt-summary'; modal.innerHTML = content; document.body.append(modal); };
      (window as any).closeModal = () => document.getElementById('receipt-summary')?.remove();
      (window as any).navigateTo = () => (window as any).renderBarcodeManagement();
      await (window as any).showPurchaseReceiptSummary('receipt-order');
    }, transactionId);
    expect(await page.$eval('#receipt-summary', el => el.textContent)).toContain('Print requests do not prove physical printing');
    await page.click('#receipt-summary .btn-primary');
    await page.waitForFunction(() => document.querySelector('#iu-invoice-detail')!.textContent!.includes('900011'));
    expect(page.url()).toContain('#barcodes/receipt/' + transactionId);
    await page.waitForFunction(() => document.querySelector('[data-unit-id]'));
    expect(calls.some(call => call.path.endsWith('/requests'))).toBe(false);
  });
  it('implements option A with atomic product selection, cross-invoice persistence and exact line queries', async () => {
    await invoiceWorkspace();
    await page.click('[data-select-line="0"]');
    await expectSelected(20);
    await page.click('[data-select-line="1"]');
    await expectSelected(40);
    await page.click('[data-invoice-id="507f1f77bcf86cd799439052"]');
    expect(await page.$eval('#iu-stat-selected', e => e.textContent)).toBe('40');
    await page.click('[data-select-line="0"]');
    await expectSelected(42);
    await page.click('[data-invoice-id="507f1f77bcf86cd799439051"]');
    await page.$eval('[data-line-count="0"]', e => { (e as HTMLInputElement).value = '4'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    await expectSelected(26);
    expect(calls.filter(c => /\/lines\/\d+\/units$/.test(c.path)).length).toBeGreaterThan(2);
    expect(calls.filter(c => /\/lines\/\d+\/units$/.test(c.path)).every(c => !c.search.includes('q='))).toBe(true);
    expect(calls.some(c => c.path.endsWith('/requests'))).toBe(false);
    await page.select('#iu-size', '60x40'); await page.click('#iu-preview');
    try { await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled, { timeout: 3000 }); }
    catch { throw new Error('Preview did not become printable: ' + await page.$eval('#page-barcodes', e => e.textContent)); }
    expect(await page.$$('.iu-label')).toHaveLength(26);
  }, 20000);
  it('registers missing identities with physical evidence without clearing the existing batch', async () => {
    await invoiceWorkspace();
    await page.click('[data-select-line="0"]'); await page.waitForFunction(() => document.querySelector('#iu-stat-selected')!.textContent === '20');
    await page.click('[data-register-line="2"]');
    expect(await page.$eval('#iu-register-form [name=physicalQuantity]', e => (e as HTMLInputElement).value)).toBe('');
    await page.type('[name=physicalQuantity]', '5'); await page.type('[name=warehouseCode]', 'Main shelf'); await page.type('[name=reason]', 'Verified supplier receipt'); await page.click('[name=physicalPossessionConfirmed]');
    await page.click('#iu-register-form button[type=submit]');
    await page.waitForFunction(() => !(document.querySelector('#iu-register-dialog') as HTMLDialogElement).open);
    await page.waitForFunction(() => document.querySelector('[data-select-line="2"]') && !(document.querySelector('[data-select-line="2"]') as HTMLInputElement).disabled);
    expect(await page.$eval('#iu-stat-selected', e => e.textContent)).toBe('20');
    const sent = calls.find(c => c.path.endsWith('/identify'));
    expect(sent.data).toMatchObject({ physicalQuantity: 5, warehouseCode: 'Main shelf', expectedQuantity: 5, physicalPossessionConfirmed: true });
    await page.click('[data-select-line="2"]'); await page.waitForFunction(() => document.querySelector('#iu-stat-selected')!.textContent === '25');
  });
  it('uses an explicit piece range for purchases larger than 100 and previews the second range correctly', async () => {
    await invoiceWorkspace(true);
    await page.click('#iu-select-invoice');
    expect(await page.$eval('#iu-stat-selected', e => e.textContent)).toBe('0');
    await page.click('[data-select-line="0"]'); await page.waitForFunction(() => document.querySelector('#iu-stat-selected')!.textContent === '100');
    const first = calls.filter(c => c.path.includes('/lines/0/units')).at(-1); expect(first.search).toContain('page=1');
    await page.$eval('[data-line-start="0"]', e => { (e as HTMLInputElement).value = '101'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#iu-stat-selected')!.textContent === '20');
    expect(calls.filter(c => c.path.includes('/lines/0/units')).at(-1).search).toContain('page=2');
    await page.select('#iu-size', '60x40'); await page.click('#iu-preview');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    const request = calls.filter(c => c.path.endsWith('/preview')).at(-1);
    const sourceUnits = units.filter(u => u.origin.purchaseLineId === 'basket-line').slice(100, 120);
    expect(new Set(request.data.unitIds)).toEqual(new Set(sourceUnits.map(u => u._id)));
  });
  it('renders the real workspace in Arabic and English without horizontal mobile overflow', async () => {
    await invoiceWorkspace();
    for (const lang of ['en', 'ar']) {
      await page.evaluate(async lang => { currentLang = lang; await window.renderBarcodeManagement(); }, lang);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewport({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    const folder = resolve(__dirname, '../../../artifacts/barcode-option-a-live'); mkdirSync(folder, { recursive: true });
    await page.setViewport({ width: 1440, height: 1150 }); await page.screenshot({ path: resolve(folder, 'desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 950 }); await page.screenshot({ path: resolve(folder, 'mobile.png'), fullPage: true });
  });
  it('keeps product and invoice cards stable, restores selection focus, and removes the breadcrumb', async () => {
    await invoiceWorkspace();
    await page.evaluate(() => { (window as any).originalProduct = document.querySelector('[data-line-index="0"]'); (window as any).originalInvoice = document.querySelector('[data-invoice-id="507f1f77bcf86cd799439052"]'); });
    await page.click('[data-select-line="0"]'); await expectSelected(20);
    expect(await page.evaluate(() => (window as any).originalProduct === document.querySelector('[data-line-index="0"]'))).toBe(true);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-select-line') === '0');
    await page.click('[data-invoice-id="507f1f77bcf86cd799439052"]');
    expect(await page.evaluate(() => (window as any).originalInvoice === document.querySelector('[data-invoice-id="507f1f77bcf86cd799439052"]'))).toBe(true);
    expect(await page.$('.iu-crumb')).toBeNull();
    expect(await page.$eval('#page-barcodes', e => getComputedStyle(e).borderTopWidth)).toBe('1px');
  });
  it('selects paper from the visual size list and zooms the preview without changing the print template', async () => {
    await invoiceWorkspace(); await page.click('[data-select-line="0"]'); await expectSelected(20);
    const folder = resolve(__dirname, '../../../artifacts/barcode-refined'); mkdirSync(folder, { recursive: true });
    await page.click('#iu-size-picker summary');
    await page.$eval('#iu-size-options', async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
    await page.screenshot({ path: resolve(folder, 'paper-size-menu.png'), fullPage: true });
    await page.click('[data-paper-size="60x40"]');
    expect(await page.$eval('#iu-size', e => (e as HTMLSelectElement).value)).toBe('60x40');
    expect(await page.$eval('[data-paper-size="60x40"]', e => e.getAttribute('aria-selected'))).toBe('true');
    await page.click('#iu-size-picker summary'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    expect(await page.$eval('#iu-size-picker', e => (e as HTMLDetailsElement).open)).toBe(false);
    await page.click('#iu-preview'); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#iu-print')!.disabled);
    expect(await page.$$('.iu-preview-sheet')).toHaveLength(20);
    await page.screenshot({ path: resolve(folder, 'label-preview.png') });
    const original = await page.$eval('.iu-label', e => e.getBoundingClientRect().width);
    await page.select('#iu-preview-zoom', '150');
    expect(await page.$eval('.iu-label', e => e.getBoundingClientRect().width)).toBeCloseTo(original * 1.5, 0);
    expect(await page.$eval('#iu-size', e => (e as HTMLSelectElement).value)).toBe('60x40');
  });
});

declare global {
  interface Window { InventoryUnitLabels: any; renderBarcodeManagement: () => Promise<void> }
  let currentLang: string;
  let printer: boolean;
  let receiver: boolean;
}
