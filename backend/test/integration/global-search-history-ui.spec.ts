import { createServer, Server } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';

describe('Global search history in Chromium', () => {
  let browser: Browser, server: Server, page: Page, origin: string;
  const index = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
  const header = index.slice(index.indexOf('<div class="header-search">'), index.indexOf('<div class="header-actions">'));
  const search = index.slice(index.indexOf('let searchSelectedIdx ='), index.indexOf('/* Excel helper', index.indexOf('let searchSelectedIdx =')));
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>.search-dropdown{display:none}.search-dropdown.active{display:block}.search-item{padding:12px;min-height:40px}svg{width:20px;height:20px}</style>
    </head><body>${header}<button id="outside">Outside</button><script>
    const qs=s=>document.querySelector(s),qsa=s=>[...document.querySelectorAll(s)];
    const currentUser={_id:'history-test'},currentLang='ar',NAV_ITEMS=[],transactions=[];
    const t=s=>s,normalizeUiSearch=s=>String(s||'').toLowerCase();
    function esc(s){const el=document.createElement('div');el.textContent=String(s||'');return el.innerHTML}
    const fmtJ=String,fmtN=String,_orderStateMeta=()=>({tone:'neutral'}),SouliaOrderStatus={badge:()=>''};
    let requests=[],aborted=[];
    function api(path,{signal}) {
      requests.push(path);
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>resolve({results:[{id:'order-233',type:'order',title:'233',subtitle:'مبيعات — عميل',total:100}]}),150);
        signal.addEventListener('abort',()=>{clearTimeout(timer);aborted.push(path);reject(new DOMException('Aborted','AbortError'))},{once:true});
      });
    }
    ${search}
    localStorage.setItem(recentSearchesKey(),JSON.stringify(['233']));
    </script></body></html>`;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    origin = 'http://127.0.0.1:' + (server.address() as any).port;
  });
  beforeEach(async () => { page = await browser.newPage(); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>(done => server.close(() => done()));
  });

  it.each([1280, 390])('shows results after clicking a recent search at width %i', async width => {
    await page.setViewport({ width, height: 850, hasTouch: width === 390, isMobile: width === 390 });
    await page.goto(origin);
    await page.click('#global-search');
    if (width === 390) await page.tap('[data-term="233"] .search-title');
    else await page.click('[data-term="233"] .search-title');
    expect(await page.$eval('#global-search', el => (el as HTMLInputElement).value)).toBe('233');
    expect(await page.$eval('#search-dropdown', el => el.classList.contains('active'))).toBe(true);
    await page.waitForSelector('#search-dropdown .search-order-ref', { timeout: 2000 });
    expect(await page.$eval('.search-order-ref', el => el.textContent)).toBe('233');
    expect(await page.evaluate(() => (window as any).eval('aborted'))).toEqual([]);
    expect(await page.evaluate(() => (window as any).eval('requests'))).toEqual(['/search?q=233']);
    await page.click('#outside');
    expect(await page.$eval('#global-search', el => el.getAttribute('aria-expanded'))).toBe('false');
  });

  it('allows selecting history with the keyboard', async () => {
    await page.goto(origin);
    await page.click('#global-search');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.search-order-ref', { timeout: 2000 });
    expect(await page.$eval('#global-search', el => (el as HTMLInputElement).value)).toBe('233');
  });

  it('cancels a pending search when clicking outside', async () => {
    await page.goto(origin);
    await page.click('#global-search');
    await page.keyboard.press('Enter');
    await page.click('#outside');
    expect(await page.evaluate(() => (window as any).eval('aborted'))).toEqual(['/search?q=233']);
    expect(await page.$eval('#search-dropdown', el => el.classList.contains('active'))).toBe(false);
  });
});
