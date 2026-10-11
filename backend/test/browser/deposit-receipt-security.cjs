// Exercises shipped handlers in Chromium; no request reaches a live service.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const src=fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8').replace(/\r\n/g,'\n');
for(const match of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if(!match[1].includes('src=')&&!match[1].includes('application/')) new vm.Script(match[2]);
}
function fn(name){const start=src.indexOf(`function ${name}(`);assert(start>=0);return (src.slice(start-6,start)==='async '?'async ':'')+src.slice(start,src.indexOf('\n}',start)+2);}
(async()=>{
  const browser=await puppeteer.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<div id="modal-content"></div><button id="spdep-bulk-go">Approve selected</button>');
    await page.addScriptTag({content:`
      const _spReceiptBusy=new Set(),_spDepSelectedIds=new Set();
      const order={_id:'o1',ref:'2771',depositReceipts:[{id:'r1',status:'معلق'}]};
      const qs=s=>document.querySelector(s),_spOrderById=()=>order,isAdmin=()=>true;
      const t=String,esc=String,tf=String,fmtN=String,_spReceiptRowHtml=()=>'',_spReceiptError=e=>{throw e;};
      window.requests=[];window.pending=[];window.modalOpens=0;
      const openModal=html=>{window.modalOpens++;qs('#modal-content').innerHTML=html;};
      const closeModal=()=>{qs('#modal-content').innerHTML='';},toast=()=>{},loadShopifyOrders=async()=>{};
      const api=async(path)=>{window.requests.push(path);return new Promise(resolve=>window.pending.push(()=>resolve({success:true})));};
      ${fn('_spReceiptAction')}
      ${fn('_spDepRunBulkApprove')}
    `});
    await page.evaluate(async()=>{
      await _spReceiptAction('o1','r1','approve');
      const btn=qs('#spdep-decide');
      window.first=btn.onclick.call(btn);
      for(let i=0;i<50;i++)btn.onclick.call(btn);
      await _spReceiptAction('o1','r1','approve');
      await _spDepRunBulkApprove([{o:order,r:order.depositReceipts[0]}]);
    });
    assert.equal(await page.evaluate(()=>window.requests.length),1,'individual and bulk clicks share one receipt lock');
    assert.equal(await page.evaluate(()=>window.modalOpens),1,'repeat action does not open another confirmation');
    await page.evaluate(async()=>{window.pending.shift()();await window.first;});
    assert(await page.evaluate(()=>!_spReceiptBusy.size),'success releases lock');
    await page.evaluate(()=>{
      qs('#spdep-bulk-go')?.remove();
      document.body.insertAdjacentHTML('beforeend','<button id="spdep-bulk-go">Approve</button>');
      window.bulk=_spDepRunBulkApprove([{o:order,r:order.depositReceipts[0]}]);
      for(let i=0;i<50;i++)_spDepRunBulkApprove([{o:order,r:order.depositReceipts[0]}]);
      _spReceiptAction('o1','r1','approve');
    });
    assert.equal(await page.evaluate(()=>window.requests.length),2,'bulk approval also prevents duplicate requests');
    await page.evaluate(async()=>{window.pending.shift()();await window.bulk;});
    assert(await page.evaluate(()=>!_spReceiptBusy.size),'bulk completion releases receipt lock');
    console.log('PASS: shipped scripts parse; 50 repeated individual/bulk clicks send one request per receipt.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
