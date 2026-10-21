const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('../backend/node_modules/puppeteer');
const baseline = process.argv.includes('--baseline');
const originalHtml = baseline ? require('node:child_process').execFileSync('git',['show','HEAD:frontend/public/index.html'],{encoding:'utf8',maxBuffer:16*1024*1024}) : null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const user = {_id:'startup-preview',name:'Preview',role:'staff',perms:['movements','reports']};

(async () => {
  const browser = await puppeteer.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', userDataDir:path.join(__dirname,'startup-speed-browser')});
  try {
    for (const mobile of [false,true]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport(mobile ? {width:390,height:844,isMobile:true,hasTouch:true} : {width:1440,height:900});
      if (mobile) await page.emulateCPUThrottling(4);
      await page.evaluateOnNewDocument(user => {
        localStorage.clear();
        localStorage.setItem('token','preview-only');
        localStorage.setItem('user',JSON.stringify(user));
        new MutationObserver(() => {
          if (!document.getElementById('splash-screen') && document.getElementById('app')?.style.display === 'block' && !window.previewReadyMs) window.previewReadyMs = performance.now();
        }).observe(document,{childList:true,subtree:true});
      },user);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (baseline && url.origin === 'http://localhost:8080' && url.pathname === '/') return request.respond({status:200,contentType:'text/html; charset=utf-8',body:originalHtml});
        if (url.origin !== 'http://localhost:8080') {
          if (request.resourceType() === 'stylesheet') return request.respond({status:200,contentType:'text/css',body:''});
          return void pause(6000).then(() => request.respond({status:200,contentType:'text/javascript',body:url.hostname==='cdn.socket.io'?'window.io=()=>({on(){},emit(){},disconnect(){}});':''})).catch(()=>{});
        }
        if (url.pathname.startsWith('/api/')) {
          const body = url.pathname === '/api/auth/me' ? user : url.pathname === '/api/settings' ? {lang:'ar'} : [];
          return void pause(100).then(() => request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)})).catch(()=>{});
        }
        // Optional libraries must not delay startup even when all three are slow.
        if (!baseline && /vendor\/(xlsx-|chart-|socket\.io-)/.test(url.pathname)) return void pause(6000).then(()=>request.continue()).catch(()=>{});
        if (url.pathname.startsWith('/socket.io/')) return request.abort();
        request.continue();
      });
      await page.goto('http://localhost:8080/#movements',{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.previewReadyMs,{timeout:20000});
      const result = await page.evaluate(() => ({readyMs:Math.round(previewReadyMs),xlsxLoaded:typeof XLSX!=='undefined',motion:getComputedStyle(document.querySelector('#main .page.active')).animationName,overflow:document.documentElement.scrollWidth>innerWidth}));
      if (!baseline) {
        assert.equal(result.xlsxLoaded,false,'Opening must not wait for Excel');
        assert.equal(await page.evaluate(()=>typeof Chart),'undefined');
        assert.equal(await page.evaluate(()=>typeof io),'undefined');
        assert(result.readyMs < 6000,'Opening must finish before optional libraries');
        if (mobile) assert.equal(result.motion,'none');
        assert.equal(result.overflow,false);
        // An export clicked before Excel loads must wait, then produce a workbook.
        await page.evaluate(() => {
          // Open charts before Chart.js is ready; they should render on arrival.
          currentPage='reports'; activeReportTab='charts';
          currentReportData={series:[{date:'2026-10-01',sales:100,profit:40,orders:1}],totalSales:100,grossProfit:40,netProfit:40};
          renderReportChartsTab(currentReportData);
          window.exportFinished=false;
          window.exportTask=writeExcel([{name:'Preview',quantity:2}], 'Preview', 'startup-preview');
          exportTask.then(()=>{window.exportFinished=true;});
        });
        assert.equal(await page.evaluate(()=>exportFinished),false);
        await page.waitForFunction(()=>typeof XLSX!=='undefined');
        await page.waitForFunction(()=>exportFinished);
        await page.waitForFunction(()=>typeof Chart==='function' && typeof io==='function' && !!reportCharts.trend);
        await page.evaluate(()=>{currentPage='movements';});
        await page.screenshot({path:path.join(__dirname,`startup-fast-${mobile?'mobile':'desktop'}.png`)});
        assert.deepEqual(errors,[]);
      }
      console.log(JSON.stringify({mode:baseline?'before':'after',viewport:mobile?'mobile (4x CPU slowdown)':'desktop',...result,errors}));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
