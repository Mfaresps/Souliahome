import { createServer, Server } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import * as QRCode from 'qrcode';

describe('Shared scanner in actual Chromium (simulated camera, no physical hardware claim)', () => {
  let browser: Browser, server: Server, page: Page, origin: string;
  let requests: any[], receipts: Map<string, any>, mode: string, code: string;
  const id = '507f1f77bcf86cd799439031', barcode = 'SU-' + id.toUpperCase();
  const publicDir = resolve(__dirname, '../../../frontend/public');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px Arial;margin:12px}</style><link rel="stylesheet" href="/inventory-scanner.css"></head><body><main id="scanner"></main><script src="/inventory-scanner.js"></script><script>
    async function api(path,options={}){const res=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const data=await res.json();if(!res.ok){const error=new Error(data.message);error.status=res.status;throw error;}return data;}
    function openScanner(extra={}){window.scanner?.destroy?.();window.scanner=SouliaScanner.mount(document.querySelector('#scanner'),{api,actorId:'operator-1',workflowKey:'test-scanner',context:{intent:'lookup'},lang:'en',canManualSelect:true,timeoutMs:1000,...extra});}
    openScanner();
    </script></body></html>`;
  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true, timeout: 20000 });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const data = body ? JSON.parse(body) : null; requests.push({ path: url.pathname, data, search: url.search });
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'denied') { res.statusCode = 403; res.end(JSON.stringify({ message: 'Permission denied' })); return; }
        if (url.pathname.endsWith('/eligible')) { res.end(JSON.stringify({ units: [{ _id: id, barcode, status: 'available' }], nextCursor: null })); return; }
        if (url.pathname.includes('/operations/')) { if (mode === 'lookup-delay') await new Promise(done => setTimeout(done, 200)); const receipt = receipts.get(url.pathname.split('/').pop()!); res.end(JSON.stringify(receipt ? { state: 'resolved', result: receipt } : { state: 'unresolved', retrySameRequest: true })); return; }
        if (url.pathname.endsWith('/validate')) {
          const result = receipts.get(data.operationKey) || { outcome: code === 'VALIDATED' ? 'accepted' : 'rejected', code, operationId: 'f'.repeat(64), ...(code === 'VALIDATED' ? { unit: { _id: id, barcode, status: 'available' } } : {}) };
          if (mode === 'uncommitted') { res.statusCode = 503; res.end(JSON.stringify({ message: 'Unavailable' })); return; }
          receipts.set(data.operationKey, result);
          if (mode === 'disconnect') { res.destroy(); return; }
          if (mode === 'delay') await new Promise(done => setTimeout(done, 200));
          if (!res.destroyed) res.end(JSON.stringify(result)); return;
        }
        res.statusCode = 404; res.end('{}');
      } else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
      else if (['/inventory-scanner.js', '/inventory-scanner.css', '/vendor/zxing-browser-0.2.1.min.js'].includes(url.pathname)) {
        res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'); res.end(readFileSync(publicDir + url.pathname));
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = 'http://127.0.0.1:' + (server.address() as any).port;
  }, 30000);
  beforeEach(async () => { requests = []; receipts = new Map(); mode = ''; code = 'VALIDATED'; page = await browser.newPage(); page.on('pageerror', error => console.error('Scanner browser error:', error)); await page.goto(origin); await page.waitForSelector('[data-scan-input]', { timeout: 3000 }); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(done => server.close(() => done())); });
  const input = '[data-scan-input]', message = '[data-scan-message]';
  const wait = (content: string) => page.waitForFunction((content: string) => document.querySelector('[data-scan-message]')!.textContent!.includes(content), {}, content);
  const scans = () => requests.filter(row => row.path.endsWith('/validate'));
  async function enter() { await page.type(input, barcode); await page.keyboard.press('Enter'); }

  it('normalizes only configured terminal suffixes and preserves valid case/spaces byte-for-byte', async () => {
    expect(await page.evaluate(() => {
      const normalize = (window as any).SouliaScanner.normalize;
      const results = [normalize('Su-Ab \r\n', 'Enter'), normalize('Su-Ab \t', 'Tab'), normalize(' Su-Ab ', 'none')];
      for (const value of ['ab\ncd', 'abc\t', '', 'a'.repeat(161)]) { try { normalize(value, 'none'); results.push('BAD'); } catch { results.push('rejected'); } }
      return results;
    })).toEqual(['Su-Ab ', 'Su-Ab ', ' Su-Ab ', 'rejected', 'rejected', 'rejected', 'rejected']);
  });
  it.each(['Enter', 'Tab', 'none'])('supports the configured %s keyboard suffix without repeated submissions', async suffix => {
    await page.select('[data-scan-suffix]', suffix); await page.type(input, barcode);
    if (suffix === 'none') { await page.keyboard.press('Enter'); expect(scans()).toHaveLength(0); await page.click('[data-scan-submit]'); }
    else await page.keyboard.press(suffix === 'Tab' ? 'Tab' : 'Enter');
    await wait('Piece identified'); expect(scans()).toHaveLength(1); expect(scans()[0].data.identifier).toBe(barcode);
    expect(scans()[0].data.inputMethod).toBe(suffix === 'none' ? 'manual-entry' : 'keyboard');
    expect(await page.$eval(input, el => document.activeElement === el)).toBe(true);
  });
  it('blocks overlapping requests, double clicks, repeated key events and preserves the active payload', async () => {
    mode = 'delay'; await page.type(input, barcode);
    await page.evaluate(() => {
      const form = document.querySelector('[data-scan-form]') as HTMLFormElement;
      const input = document.querySelector('[data-scan-input]') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
      form.requestSubmit(); form.requestSubmit(); (window as any).scanner.client.submit('other', 'camera');
    });
    await wait('Piece identified'); expect(scans()).toHaveLength(1); expect(scans()[0].data.identifier).toBe(barcode);
  });
  it.each(['UNKNOWN_BARCODE', 'WRONG_PRODUCT', 'INVALID_UNIT_STATE', 'DUPLICATE_SCAN', 'UNAVAILABLE_UNIT'])('renders authoritative %s feedback with text and accessible status', async value => {
    code = value; await enter(); await page.waitForFunction(() => !(window as any).scanner.client.pending);
    expect(await page.$eval(message, el => el.textContent!.length)).toBeGreaterThan(15);
    expect(await page.$eval(message, el => el.getAttribute('role'))).toBe('status');
    expect(await page.$eval(message, el => el.getAttribute('data-level'))).toBe(value === 'DUPLICATE_SCAN' ? 'warning' : 'error');
    expect(await page.$eval(message, el => document.activeElement === el)).toBe(true);
  });
  it('automatically resolves a timed-out committed request on reopening without resubmitting', async () => {
    mode = 'delay'; await page.evaluate(() => (window as any).openScanner({ timeoutMs: 60 })); await enter(); await wait('outcome unknown');
    const pending = await page.evaluate(() => (window as any).scanner.client.pending); expect(pending.operationKey).toBeTruthy();
    mode = 'lookup-delay'; await page.reload(); await wait('previous scan request is saved');
    expect(await page.$eval('[data-scan-retry]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.evaluate(() => (window as any).scanner.client.pending)).toEqual(pending);
    await wait('Piece identified');
    expect(scans()).toHaveLength(1); expect(await page.evaluate(() => (window as any).scanner.client.pending)).toBeNull();
    expect(requests.filter(row => row.path.includes('/operations/')).map(row => row.path.split('/').pop())).toEqual([pending.operationKey]);
  });
  it('shows an unresolved saved request separately from a network failure, and retries only on explicit action', async () => {
    mode = 'uncommitted'; await enter(); await wait('outcome unknown');
    const pending = await page.evaluate(() => (window as any).scanner.client.pending);
    await page.reload(); await wait('No confirmed result');
    expect(await page.$eval(message, el => el.textContent)).not.toContain('Network error');
    expect(await page.evaluate(() => (window as any).scanner.client.pending)).toEqual(pending);
    expect(scans()).toHaveLength(1);
    expect(await page.$eval('[data-scan-submit]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await page.evaluate(() => (window as any).openScanner({ lang: 'ar' })); await wait('لم تتوفر نتيجة مؤكدة');
    expect(await page.$eval(message, el => el.textContent)).not.toContain('خطأ شبكة');
    expect(scans()).toHaveLength(1);
    mode = ''; await page.click('[data-scan-retry]'); await wait('تم التحقق من الوحدة');
    expect(scans()).toHaveLength(2); expect(scans()[1].data).toEqual(pending);
  });
  it('retains an uncertain committed request when a later retry and recovery lookup are denied', async () => {
    mode = 'disconnect'; await enter(); await wait('outcome unknown');
    const pending = await page.evaluate(() => (window as any).scanner.client.pending);
    // Chromium may retry a disconnected HTTP connection before reporting failure.
    const initialAttempts = scans().length;
    mode = 'denied'; await page.click('[data-scan-retry]'); await wait('Permission denied');
    expect(await page.evaluate(() => (window as any).scanner.client.pending)).toEqual(pending);
    await page.reload(); await wait('Permission denied');
    expect(await page.evaluate(() => (window as any).scanner.client.pending)).toEqual(pending);
    mode = ''; await page.click('[data-scan-check]'); await wait('Piece identified');
    expect(scans()).toHaveLength(initialAttempts + 1);
    expect(scans().every(row => JSON.stringify(row.data) === JSON.stringify(pending))).toBe(true);
  });
  it('does not interpret a missing operation or failed connection as failure and retries the identical request', async () => {
    mode = 'uncommitted'; await enter(); await wait('outcome unknown'); const pending = scans()[0].data;
    await page.click('[data-scan-check]'); await page.waitForFunction(() => !(window as any).scanner.client.busy);
    expect(await page.evaluate(() => (window as any).scanner.client.pending)).toEqual(pending);
    expect(await page.$eval('[data-scan-submit]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    mode = ''; await page.click('[data-scan-retry]'); await wait('Piece identified'); expect(scans()).toHaveLength(2); expect(scans()[1].data).toEqual(pending);
  });
  it('recovers a disconnected committed response by lookup and treats permission denial distinctly', async () => {
    mode = 'disconnect'; await enter(); await wait('outcome unknown'); mode = ''; await page.click('[data-scan-check]'); await wait('Piece identified');
    mode = 'denied'; await enter(); await wait('Permission denied'); expect(await page.evaluate(() => (window as any).scanner.client.pending)).toBeNull();
  });
  it('offers only server-listed eligible units and requires confirmation and an audited reason', async () => {
    await page.click('summary'); await page.click('[data-scan-load]'); await page.waitForSelector('[data-scan-choice] option[value="' + id + '"]');
    await page.select('[data-scan-choice]', id); await page.click('[data-scan-select]'); expect(scans()).toHaveLength(0);
    await page.type('[data-scan-reason]', 'Scanner unavailable; confirmed label'); await page.click('[data-scan-confirm]'); await page.click('[data-scan-select]'); await wait('Piece identified');
    expect(scans()[0].data).toMatchObject({ identifier: id, inputMethod: 'manual-selection', manualSelectionConfirmed: true, reason: 'Scanner unavailable; confirmed label' });
    expect(requests.find(row => row.path.endsWith('/eligible'))!.search).toContain('intent=lookup');
    await page.evaluate(() => (window as any).openScanner({ canManualSelect: false })); expect(await page.$eval('[data-scan-manual]', el => (el as HTMLElement).hidden)).toBe(true);
  });
  it('fails closed when pending-request storage is unavailable', async () => {
    await page.evaluate(() => (window as any).openScanner({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } }));
    await wait('Cannot preserve'); expect(scans()).toHaveLength(0); expect(await page.$eval('[data-scan-submit]', el => (el as HTMLButtonElement).disabled)).toBe(true);
  });
  it('requires resolution before a new session and retains old session audit identity on retry', async () => {
    mode = 'uncommitted'; await enter(); await wait('outcome unknown');
    const session = scans()[0].data.sessionKey;
    expect(await page.$eval('[data-scan-new]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.evaluate(() => (window as any).scanner.client.newSession())).toBe(false);
    mode = ''; await page.click('[data-scan-retry]'); await wait('Piece identified'); await page.click('[data-scan-new]');
    expect(await page.evaluate(() => (window as any).scanner.client.sessionKey)).not.toBe(session);
    await enter(); await wait('Piece identified'); expect(scans()[1].data.sessionKey).toBe(session); expect(scans()[2].data.sessionKey).not.toBe(session);
  });
  it('does not let a late response from a destroyed component erase a newer unresolved request', async () => {
    mode = 'delay'; await enter(); await page.waitForFunction(() => !!(window as any).scanner.client.pending);
    // Wait until the simulated backend has committed the original request.
    const deadline = Date.now() + 1000;
    while (scans().length === 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    expect(scans()).toHaveLength(1);
    await page.evaluate(() => (window as any).openScanner());
    mode = ''; await page.click('[data-scan-check]'); await wait('Piece identified');
    mode = 'uncommitted'; await enter(); await wait('outcome unknown');
    const pending = await page.evaluate(() => (window as any).scanner.client.pending);
    await new Promise(done => setTimeout(done, 250));
    expect(await page.evaluate(() => { const client = (window as any).scanner.client; return JSON.parse(sessionStorage.getItem(client.storageKey)!).pending; })).toEqual(pending);
    expect(pending.operationKey).not.toBe(scans()[0].data.operationKey);
  });
  it('requests camera permission only on explicit start and handles denial/unsupported devices', async () => {
    await page.evaluate(() => { (window as any).cameraCalls = 0; Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { (window as any).cameraCalls++; throw new DOMException('Denied', 'NotAllowedError'); } }); });
    expect(await page.evaluate(() => (window as any).cameraCalls)).toBe(0);
    await page.click('[data-scan-camera]'); await wait('Camera permission denied'); expect(scans()).toHaveLength(0);
    await page.evaluate(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }));
    await page.click('[data-scan-camera]'); await wait('Camera unavailable'); expect(await page.$eval(input, el => (el as HTMLInputElement).disabled)).toBe(false);
  });
  it('decodes an actual generated QR through the real ZXing stream reader and stops all camera tracks', async () => {
    const png = await QRCode.toDataURL(barcode, { width: 400, margin: 4 });
    await page.evaluate(async png => {
      const img = new Image(); img.src = png; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 500;
      const ctx = canvas.getContext('2d')!; const draw = () => { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 500, 500); ctx.drawImage(img, 50, 50, 400, 400); };
      draw(); const stream = canvas.captureStream(20); (window as any).cameraStream = stream;
      (window as any).drawTimer = setInterval(draw, 40);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => stream });
    }, png);
    await page.click('[data-scan-camera]'); await wait('Piece identified');
    expect(scans()).toHaveLength(1); expect(scans()[0].data).toMatchObject({ identifier: barcode, inputMethod: 'camera' });
    expect(await page.evaluate(() => (window as any).cameraStream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
    await page.evaluate(() => clearInterval((window as any).drawTimer));
  });
  it('releases late camera permission grants after stop and when the component is removed', async () => {
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 30; (window as any).cameraStream = canvas.captureStream();
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => new Promise(resolve => { (window as any).grantCamera = () => resolve((window as any).cameraStream); }) });
    });
    await page.click('[data-scan-camera]'); await page.waitForFunction(() => !!(window as any).grantCamera);
    await page.click('[data-scan-stop]'); await page.evaluate(() => (window as any).grantCamera());
    await page.waitForFunction(() => (window as any).cameraStream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended'));
    await page.evaluate(() => document.querySelector('#scanner')!.remove());
    await page.waitForFunction(() => (window as any).scanner.client.destroyed);
  });
  it('destroys the scanner when actual page navigation hides its parent with a CSS class', async () => {
    await page.evaluate(() => {
      const css = document.createElement('style'); css.textContent = '.page:not(.active){display:none}'; document.head.append(css);
      const host = document.createElement('div'); host.id = 'page-scanner-test'; host.className = 'page active';
      const root = document.querySelector('#scanner')!; root.before(host); host.append(root);
      host.classList.remove('active');
    });
    await page.waitForFunction(() => (window as any).scanner.client.destroyed);
    expect(scans()).toHaveLength(0);
  });
  it('keeps mobile layouts within the viewport and exposes Arabic messages', async () => {
    await page.click('summary'); await page.click('[data-scan-load]');
    for (const width of [320, 360, 768, 1280]) { await page.setViewport({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await page.evaluate(() => (window as any).openScanner({ lang: 'ar' }));
    expect(await page.$eval('h2', el => el.textContent)).toBe('مسح وحدة فعلية'); code = 'WRONG_PRODUCT'; await enter(); await wait('صنفًا آخر');
  });
});
