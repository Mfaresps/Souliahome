import { createServer, Server } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { Types } from 'mongoose';
import puppeteer, { Browser, Page } from 'puppeteer';
import { trackingMongo } from '../helpers/tracking-mongo';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';

describe('Piece action dialog against real persisted lifecycle operations',()=>{
  let mongo:Awaited<ReturnType<typeof trackingMongo>>,service:InventoryUnitsService,Unit:any,Event:any;
  let browser:Browser,page:Page,server:Server,origin:string,actor:any,unitId:string,failNext=false;
  const requests:any[]=[];
  const publicDir=resolve(__dirname,'../../../frontend/public');
  beforeAll(async()=>{
    mongo=await trackingMongo();Unit=mongo.connection.model('InventoryUnit',InventoryUnitSchema);Event=mongo.connection.model('InventoryUnitEvent',InventoryUnitEventSchema);
    const Operation=mongo.connection.model('InventoryUnitOperation',InventoryUnitOperationSchema);
    const manual=new UnitManualCodesService(mongo.connection);await manual.onModuleInit();
    service=new InventoryUnitsService(mongo.connection,Unit,Event,Operation,{} as any,manual);await migrateInventoryUnitIndexes(mongo.connection.db!,true);
    actor={userId:new Types.ObjectId().toHexString(),role:'admin'};
    await mongo.connection.collection('users').insertOne({_id:new Types.ObjectId(actor.userId),name:'Verified operator'});
    const productId=new Types.ObjectId().toHexString();
    await mongo.connection.collection('products').insertOne({_id:new Types.ObjectId(productId),code:'GEO-TEST',name:'Geo Basket'});
    const unit=await Unit.create({productId,status:'inspection-required',warehouseCode:'MAIN',origin:{kind:'legacy-unknown',reconciliationRef:'isolated-action-ui'},registeredByUserId:actor.userId,registeredBy:'Verified operator'});unitId=String(unit._id);
    await Event.create(Array.from({length:26},(_,i)=>({unitId,sequence:i+1,operationKey:'fixture-'+i,action:i?'scan-validated':'registered',fromStatus:i?'inspection-required':null,toStatus:'inspection-required',byUserId:actor.userId,by:'Verified operator',reason:i?'Operator requested online unit identity validation':'Isolated initial registration'})));
    server=createServer(async(req,res)=>{
      try{
        const url=new URL(req.url!,'http://localhost');
        if(url.pathname==='/'){
          res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><link rel="stylesheet" href="/inventory-units.css"><style>body{margin:12px;font:14px Arial;background:#eef3f1}.test-toast{position:fixed;top:10px;left:10px;padding:12px;background:#dff3e6;z-index:9999}</style></head><body><main id="page-barcodes"></main><div id="test-toast" role="status"></div><script>let currentLang='ar',currentPage='barcodes',currentUser={_id:'${actor.userId}'};let toastCount=0;function hasPerm(){return true}function toast(text){toastCount++;const e=document.getElementById('test-toast');e.className='test-toast';e.textContent=text}async function api(path,options={}){const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok){const e=new Error(d.message);e.status=r.status;throw e}return d}</script><script src="/inventory-units.js"></script></body></html>`);return;
        }
        if(url.pathname==='/inventory-units.js'||url.pathname==='/inventory-units.css'){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(readFileSync(publicDir+url.pathname));return;}
        res.setHeader('Content-Type','application/json');let body='';for await(const chunk of req)body+=chunk;const data=body?JSON.parse(body):null;
        let result:any;
        if(url.pathname.endsWith('/config'))result=service.config();
        else if(url.pathname.endsWith('/purchases/receipts'))result={receipts:[],total:0};
        else if(url.pathname==='/api/inventory-units')result=await service.search(Object.fromEntries(url.searchParams));
        else if(url.pathname.endsWith('/action-options'))result=await service.actionOptions(unitId,actor);
        else if(url.pathname.endsWith('/actions')){
          requests.push(data);await new Promise(done=>setTimeout(done,80));
          if(failNext){failNext=false;res.statusCode=503;res.end(JSON.stringify({message:'Temporary action failure'}));return;}
          result=await service.action(unitId,data,actor);
        }else if(url.pathname==='/api/inventory-units/'+unitId)result=await service.lookup(unitId);
        else{res.statusCode=404;result={message:'Unknown test route'};}
        res.end(JSON.stringify(result));
      }catch(error:any){res.statusCode=error.getStatus?.()||500;res.end(JSON.stringify({message:error.message}));}
    });
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as any).port}`;
    browser=await puppeteer.launch({headless:true,...(process.platform==='win32'?{executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'}:{})});
  },50000);
  afterAll(async()=>{await browser?.close();if(server)await new Promise<void>(done=>server.close(()=>done()));await mongo?.close();});
  it('saves once, closes and notifies; history persists; failures stay open and retry with the same key',async()=>{
    page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error instanceof Error?error.message:String(error)));
    await page.setViewport({width:1440,height:900});await page.goto(origin);await page.click('#iu-tab-units');await page.waitForSelector('#iu-units .iu-log-status [data-piece-actions]');
    await page.click('#iu-units .iu-log-status [data-piece-actions]');
    await page.waitForFunction(()=>!document.querySelector<HTMLElement>('#iu-action-fields')!.hidden||document.querySelector<HTMLElement>('#iu-action-dialog [data-dialog-message]')!.dataset.error==='true');
    expect(await page.$eval('#iu-action-dialog [data-dialog-message]',e=>e.textContent)).toBe('');
    expect(await page.$$eval('.iu-action-event',rows=>rows.length)).toBe(1);
    await page.click('[data-iu-history-filter="all"]');expect(await page.$$eval('.iu-action-event',rows=>rows.length)).toBe(10);
    await page.click('[data-iu-history-more]');expect(await page.$$eval('.iu-action-event',rows=>rows.length)).toBe(20);
    for(const width of [1440,390]){
      await page.setViewport({width,height:800});
      expect(await page.$eval('#iu-action-dialog',dialog=>{const b=dialog.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight&&b.width<=innerWidth;})).toBe(true);
      expect(await page.$eval('.iu-history-list',list=>list.clientHeight<=260&&list.scrollHeight>list.clientHeight)).toBe(true);
      expect(await page.$eval('#iu-action-dialog .iu-dialog-footer',footer=>footer.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
      mkdirSync(resolve(__dirname,'../../../artifacts'),{recursive:true});await page.screenshot({path:resolve(__dirname,`../../../artifacts/piece-actions-${width}.png`),fullPage:true});
    }
    await page.select('#iu-action-kind','inspect');
    await page.evaluate(()=>{const form=document.getElementById('iu-action-form') as HTMLFormElement;form.requestSubmit();form.requestSubmit();});
    await page.waitForFunction(()=>!document.querySelector<HTMLDialogElement>('#iu-action-dialog')!.open);
    expect(await page.$eval('#test-toast',e=>e.textContent)).toContain('تم حفظ');expect(requests).toHaveLength(1);
    expect((await Unit.findById(unitId)).status).toBe('available');expect(await Event.countDocuments({unitId,action:'inspection-passed'})).toBe(1);
    await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#iu-units .iu-log-status [data-piece-actions]')!.disabled);
    await page.click('#iu-units .iu-log-status [data-piece-actions]');await page.waitForFunction(()=>document.querySelector('#iu-action-kind option[value="damage"]'));
    expect(await page.$eval('#iu-action-piece',e=>e.textContent)).toContain('متاحة');
    expect(await page.$$eval('.iu-action-event strong',nodes=>nodes.some(n=>n.textContent?.includes('اعتماد الفحص')))).toBe(true);
    failNext=true;await page.select('#iu-action-kind','damage');await page.click('#iu-action-submit');
    await page.waitForFunction(()=>document.querySelector('#iu-action-dialog [data-dialog-message]')!.textContent!.includes('Temporary action failure'));
    expect(await page.$eval('#iu-action-dialog',(d:any)=>d.open)).toBe(true);expect(await page.evaluate('toastCount')).toBe(1);expect((await Unit.findById(unitId)).status).toBe('available');
    await page.click('#iu-action-submit');await page.waitForFunction(()=>!document.querySelector<HTMLDialogElement>('#iu-action-dialog')!.open);
    expect(requests[1].operationKey).toBe(requests[2].operationKey);expect((await Unit.findById(unitId)).status).toBe('damaged');expect(await Event.countDocuments({unitId,action:'damaged'})).toBe(1);
    expect(await page.evaluate('toastCount')).toBe(2);expect(errors).toEqual([]);
  },40000);
});
