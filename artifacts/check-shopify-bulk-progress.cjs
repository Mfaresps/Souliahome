const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('../backend/node_modules/puppeteer');
const html = fs.readFileSync(path.resolve(__dirname, '../frontend/public/index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const start = html.indexOf('async function _runWithConcurrency(');
const source = html.slice(start, html.indexOf('/**', html.indexOf('async function _confirmBulkSendShopify()')));
const keys = ['spBatchWorking','spBatchDoneCount','spBatchFailedCount','spBatchKeepOpen','spBatchLastSaved','spBatchGrouping','spSendingProgress','spSendFailedFor','spDepOrderChanged'];
const translations = Object.fromEntries(keys.map(key => [key, Function('return (' + html.match(new RegExp(key + ':(\\{ar:[^\\n]+?\\}),?\\r?\\n'))[1] + ')')()]));

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', userDataDir: path.join(__dirname, 'bulk-preview-browser') });
  try {
    for (const lang of ['ar','en']) {
      const page = await browser.newPage();
      await page.setViewport(lang === 'ar' ? {width:390,height:844} : {width:1440,height:900});
      await page.setContent(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"></head><body><div id="sp-bulk-confirm-modal" style="position:fixed;inset:0;background:#0005;display:flex;align-items:center;justify-content:center;padding:20px"><div class="spd" style="width:460px;max-width:100%;background:var(--bg);border-radius:18px"></div></div><select id="spb-carrier" hidden><option value="bosta">Bosta</option></select></body></html>`);
      await page.addStyleTag({content:css});
      await page.evaluate((translations,lang) => {
        window.qs = selector => document.querySelector(selector);
        window.t = key => translations[key]?.[lang] || key;
        window.tf = (key,values) => t(key).replace(/\{(\w+)\}/g,(_,k)=>values[k]);
        window.esc = text => String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
        window.SP_CONFIRM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>';
        window._sppReadChoice = () => ({on:true});
        window._sppCommit = async () => {await new Promise(r=>setTimeout(r,200));return {prepRef:'PREP-1'};};
        window._spDepositOf = () => ({byMethod:{}});
        window._shopifySelectedIds = new Set(Array.from({length:8},(_,i)=>String(i)));
        window.currentPage = 'shopify-orders'; window.txItems = []; window._txSaving = false;
        window.txNotifier = {beginBatch:()=>()=>({}),suppressCreated:()=>{}};
        window.loadShopifyOrders = async()=>{}; window._rtRefreshUI = ()=>{};
        window._spShowBulkResult = (modal,result)=>{window.result=result;};
        window.api = async url => {
          if (!url.endsWith('/approve')) return [];
          const id = Number(url.split('/')[3]);
          await new Promise(r=>setTimeout(r,500+id*70));
          if (id === 1) throw Error('Stock changed');
          return {success:true,txId:'tx-'+id};
        };
        qs('#sp-bulk-confirm-modal')._sendable = Array.from({length:8},(_,i)=>({order:{_id:String(i),ref:String(2859+i),items:[{qty:2}]}}));
      },translations,lang);
      await page.addScriptTag({content:source});
      await page.evaluate(()=>{window.run=_confirmBulkSendShopify();});
      await page.waitForFunction(()=>Number(document.querySelector('#sp-bulk-completed')?.textContent)>=3);
      await page.screenshot({path:path.join(__dirname,`shopify-bulk-${lang}.png`)});
      await page.evaluate(()=>window.run);
      const result = await page.evaluate(()=>({ok:result.okCount,failed:result.errors.length,items:result.items,done:qs('#sp-bulk-completed').textContent,overflow:document.documentElement.scrollWidth>innerWidth,remaining:[..._shopifySelectedIds]}));
      assert.deepEqual(result,{ok:7,failed:1,items:14,done:'8',overflow:false,remaining:['1']});
      console.log(lang + ': progress, partial failure and retry selection verified.');
      await page.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
