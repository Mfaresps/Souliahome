const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../..'),dir=path.join(root,'frontend/public');
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try {
  const page=await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request',r=>{
   const u=new URL(r.url()),file=path.join(dir,u.pathname.slice(1));
   if(u.origin==='http://soulia.test'&&u.pathname==='/')return r.respond({status:200,contentType:'text/html',body:html});
   if(u.origin==='http://soulia.test'&&u.pathname.endsWith('.css')&&fs.existsSync(file))return r.respond({status:200,contentType:'text/css',body:fs.readFileSync(file)});
   if(r.resourceType()==='script')return r.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
   return r.respond({status:200,contentType:'application/json',body:'[]'});
  });
  await page.setViewport({width:1536,height:864});
  await page.goto('http://soulia.test/',{waitUntil:'load'});
  await page.evaluate(()=>{
   qs('#splash-screen')?.remove();qs('#login-page').style.display='none';qs('#app').style.display='';
   qsa('.page').forEach(e=>e.classList.toggle('active',e.id==='page-movements'));
   qs('#mov-table-wrap').style.display='block';
   const table=qs('#mov-table'),headers=[...table.querySelectorAll('thead th')];
   table.querySelector('tbody').innerHTML=Array.from({length:20},(_,i)=>'<tr>'+headers.map(h=>`<td data-col="${h.dataset.col||''}">${h.dataset.col==='invoice'?'<span class="mov-col-total">EGP 12,345</span>':h.dataset.col==='client'?'Customer name':String(i+1)}</td>`).join('')+'</tr>').join('');
   window.fitCalls=0;const fit=fitMovTableColumns;fitMovTableColumns=()=>{fitCalls++;fit();};
   applyMovColsVisibility();
  });
  let cases=0;
  for(const direction of ['ltr','rtl'])for(const zoom of [1,.9,.8,.75,.67,.5]) {
   await page.evaluate(({direction,zoom})=>{document.documentElement.dir=direction;document.body.style.zoom=zoom;fitMovTableColumns();},{direction,zoom});
   await new Promise(r=>setTimeout(r,1000));
   const result=await page.evaluate(async()=>{
    const table=qs('#mov-table'),scroll=qs('#mov-table-wrap .ent-table-scroll'),samples=[],initial=fitCalls;
    for(let i=0;i<24;i++) {await new Promise(requestAnimationFrame);samples.push([table.getBoundingClientRect().width,scroll.clientWidth,scroll.clientHeight,table.style.width].join('|'));}
    const columns=Object.keys(MOV_COL_FIT).reduce((sum,id)=>sum+parseFloat(table.style.getPropertyValue('--mov-col-'+id)||0),88);
    return {unique:[...new Set(samples)],calls:fitCalls-initial,width:table.getBoundingClientRect().width,columns,target:parseFloat(table.style.width)};
   });
   console.log(direction,zoom,JSON.stringify(result));
   assert.equal(result.unique.length,1,'Table must settle at fractional zoom');
   assert.ok(result.calls<=1,'ResizeObserver must not keep refitting a stationary table');
   assert.equal(result.columns,result.target,'Rounded columns must sum exactly to the target width');
   const menuFits=await page.evaluate(()=>{
    const host=qs('#mov-type-dd');host.classList.add('open');
    const menu=qs('#mov-command-tabs').getBoundingClientRect(),main=qs('#main').getBoundingClientRect();
    host.classList.remove('open');
    return menu.width>0&&menu.left>=Math.max(0,main.left)&&menu.right<=Math.min(innerWidth,main.right);
   });
   assert.ok(menuFits,'Type dropdown stays in the content area in both directions');
   cases++;
  }
  const heightOnly=await page.evaluate(async()=>{
   const scroll=qs('#mov-table-wrap .ent-table-scroll'),before=fitCalls;
   scroll.style.maxHeight='300px';
   for(let i=0;i<8;i++) await new Promise(requestAnimationFrame);
   return fitCalls-before;
  });
  assert.equal(heightOnly,0,'Height-only changes must not refit column widths');
  await page.evaluate(()=>{_setHiddenMovCols(new Set(['client','tag','invoice']));applyMovColsVisibility();});
  assert.ok(await page.$eval('#mov-table',table=>['client','tag','invoice'].every(id=>table.style.getPropertyValue('--mov-col-'+id)==='0px')),'Column visibility still updates widths');
  console.log(`PASS ${cases} fractional zoom/direction cases, exact column sums, height-only resize and column visibility`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

