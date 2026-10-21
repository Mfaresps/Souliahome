const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('../backend/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    userDataDir: path.resolve(__dirname, 'startup-browser'),
    args: ['--no-first-run', '--disable-extensions'],
  });
  try {
    for (const mobile of [false, true]) {
      const page = await browser.newPage();
      await page.setViewport(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: mobile ? 'reduce' : 'no-preference' }]);
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('token', 'startup-preview-invalid-token');
        localStorage.setItem('user', JSON.stringify({ name: 'Preview', role: 'staff', perms: [] }));
      });
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (!request.url().startsWith('http://localhost:8080')) {
          // Deliberately slow libraries must not delay the sign-in screen.
          setTimeout(() => request.respond({ status: 200, contentType: 'text/javascript', body: '' }).catch(() => {}), 6000);
        } else if (/\/vendor\/(xlsx-|chart-|socket\.io-)/.test(request.url())) {
          setTimeout(() => request.continue().catch(() => {}), 6000);
        } else if (new URL(request.url()).pathname === '/api/auth/me') {
          setTimeout(() => request.respond({ status: 401, contentType: 'application/json', body: '{"message":"Unauthorized"}' }).catch(() => {}), 1200);
        } else request.continue();
      });
      await page.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
      const splash = await page.evaluate(() => {
        const splash = document.querySelector('#splash-screen');
        const logo = splash.querySelector('img').getBoundingClientRect();
        return { children: splash.querySelectorAll('img').length, text: splash.textContent.trim(), x: logo.x + logo.width / 2, y: logo.y + logo.height / 2, width: innerWidth, height: innerHeight };
      });
      assert.equal(splash.children, 1);
      assert.equal(splash.text, '');
      assert(Math.abs(splash.x - splash.width / 2) < 2);
      assert(Math.abs(splash.y - splash.height / 2) < 2);
      await page.waitForFunction(() => document.querySelector('#splash-screen img')?.classList.contains('is-ready'));
      await page.screenshot({ path: path.join(__dirname, mobile ? 'startup-mobile.png' : 'startup-desktop.png') });
      await page.waitForFunction(() => !document.querySelector('#splash-screen'), { timeout: 10000 });
      const result = await page.evaluate(() => ({
        readyMs: Math.round(performance.now()),
        loginVisible: getComputedStyle(document.querySelector('#login-page')).display === 'flex',
        libraryLoaded: performance.getEntriesByType('resource').some(r => /xlsx|chart\.umd|socket\.io\.min/.test(r.name) && r.responseEnd > 0),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert(result.loginVisible);
      assert(!result.libraryLoaded, 'Sign-in should not wait for slow third-party libraries');
      assert(!result.overflow);
      console.log(JSON.stringify({ viewport: mobile ? 'mobile/reduced-motion' : 'desktop', ...result }));
      await page.close();
    }
    // A delayed public branding update must not replace or resize a cached logo mid-startup.
    const branded = await browser.newPage();
    await branded.setViewport({ width: 390, height: 844 });
    await branded.evaluateOnNewDocument(() => {
      const id = '11111111-1111-1111-1111-111111111111';
      localStorage.setItem('soulia_branding_v1', JSON.stringify({ selection: {splash:id,header:null,tab:null}, logos:[{id,name:'Wide logo',width:400,height:100,bytes:200}] }));
      localStorage.setItem('token','preview'); localStorage.setItem('user',JSON.stringify({name:'Preview'}));
    });
    await branded.setRequestInterception(true);
    branded.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://localhost:8080') request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
      else if (url.pathname === '/api/auth/me') setTimeout(()=>request.respond({status:401,contentType:'application/json',body:'{}'}).catch(()=>{}),1600);
      else if (url.pathname === '/api/branding') setTimeout(()=>request.respond({status:200,contentType:'application/json',body:JSON.stringify({selection:{splash:'22222222-2222-2222-2222-222222222222'},logos:[{id:'22222222-2222-2222-2222-222222222222',name:'New logo',width:100,height:400,bytes:200}]})}).catch(()=>{}),400);
      else if (url.pathname.includes('/api/branding/logos/')) setTimeout(()=>request.respond({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" rx="20" fill="#6ce3ed"/></svg>'}).catch(()=>{}),150);
      else request.continue();
    });
    await branded.goto('http://localhost:8080',{waitUntil:'domcontentloaded'});
    const measure = () => branded.evaluate(()=>{
      const img=document.querySelector('#splash-screen img'), rect=img.getBoundingClientRect();
      return {src:img.getAttribute('src'),x:rect.x,y:rect.y,width:rect.width,height:rect.height,filter:getComputedStyle(img).filter};
    });
    const before = await measure();
    await branded.waitForFunction(()=>JSON.parse(localStorage.getItem('soulia_branding_v1')).selection.splash.startsWith('2222'));
    const after = await measure();
    assert.deepEqual(after,before);
    assert(after.src.includes('11111111'));
    assert.equal(after.filter,'none');
    assert.equal(after.width,220);
    console.log('Cached custom logo retains colour, source and fixed geometry during branding refresh.');
    await branded.close();
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'startup-preview-token');
      localStorage.setItem('user', JSON.stringify({ _id: 'preview', name: 'Preview', username: 'preview', role: 'staff', perms: [] }));
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://localhost:8080') {
        const body = url.hostname === 'cdn.socket.io' ? 'window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}' : '';
        request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'text/javascript', body });
      } else if (url.pathname.startsWith('/api/')) {
        const payload = url.pathname === '/api/auth/me'
          ? { _id: 'preview', name: 'Preview', username: 'preview', role: 'staff', perms: [] }
          : url.pathname === '/api/settings' ? { lang: 'en' }
          : url.pathname === '/api/branding/public' ? { logos: [], selection: {} }
          : [];
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      } else request.continue();
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:8080/#userhub', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#splash-screen'), { timeout: 15000 });
    const authenticated = await page.evaluate(() => ({
      appVisible: getComputedStyle(document.querySelector('#app')).display !== 'none',
      pageVisible: document.querySelector('#page-userhub').classList.contains('active'),
    }));
    assert(authenticated.appVisible && authenticated.pageVisible);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ authenticated: true, ...authenticated, errors }));
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
