/* Real app UI with intercepted APIs: no production data is read or modified. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const puppeteer=require('../backend/node_modules/puppeteer'),express=require('../frontend/node_modules/express');
const html=fs.readFileSync('frontend/public/index.html','utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
(async()=>{
  const app=express();
  app.get('/config.js',(req,res)=>res.type('js').send('window.__ENV__={API_BASE_URL:""};'));
  app.use(express.static(path.resolve('frontend/public')));
  const server=app.listen(8088);let browser;
  try{
    browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setViewport({width:390,height:1000,hasTouch:true});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.evaluateOnNewDocument(()=>{
      document.startViewTransition=undefined;
      localStorage.setItem('token','density-preview');
      localStorage.setItem('soulia-push-prompt:preview','dismissed');
      localStorage.setItem('user',JSON.stringify({_id:'preview',name:'Preview',username:'preview',role:'admin',perms:[]}));
    });
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.origin!=='http://localhost:8088')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
      if(url.pathname.startsWith('/api/')){
        const data=url.pathname==='/api/auth/me'?{_id:'preview',name:'Preview',username:'preview',role:'admin',perms:[]}:url.pathname==='/api/settings'?{lang:'en'}:url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences'?{preferences:{enabled:false},devices:0,configured:false,language:'en',categories:[]}:url.pathname.includes('branding')?{logos:[],selection:{}}:[];
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
      }
      request.continue();
    });
    await page.goto('http://localhost:8088/#shopify-orders',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.spCompactHeader&&currentPage==='shopify-orders'&&!document.querySelector('#splash-screen'));
    await page.evaluate(()=>{
      const now=Date.now();
      _shopifyOrders=Array.from({length:10},(_,i)=>({
        _id:'density-'+i,ref:String(2801+i),shopifyOrderId:String(8801+i),status:i===8?'approved':'pending',
        client:i===5?'Fatma Hassan Abdelrahman Mohamed Mahmoud':'سارة محمد',phone:'01012345678',
        createdAt:new Date(now-(i>=3?48:24)*3600000).toISOString(),total:i===5?1234567.89:1450+i*100,
        assignedToName:'Ahmed',items:[{name:'قميص كتان بأكمام طويلة — لون بيج ومقاس كبير',qty:2,price:600},{name:'بنطلون واسع',qty:1,price:250}],
        tags:i===6?'contact verified by otp, confirmed':'',shipWithoutDeposit:i===7,
        cancelled:i===2,cancelRequest:i===3?{status:'معلق',reason:'طلب العميل'}:i===4?{status:'مرفوض',reason:'تمت المراجعة'}:null,
        depositReceipts:i===0?[{id:'r1',status:'معتمد',amount:450,method:'Instapay'}]:i===9?[{id:'r9',status:'معلق',amount:200,method:'Instapay'}]:[],
        comments:[{text:'مراجعة العنوان',authorName:'Ahmed',createdAt:new Date(now).toISOString()}]
      }));
      followUps=[0,1,7,9].map(i=>({_id:'followup-'+i,orderRef:String(2801+i),status:'في انتظار العميل',createdAt:new Date(now).toISOString(),comments:[{kind:'call',callOutcome:'answered',callAttemptNo:1,text:'العميل طلب تأكيد المقاس قبل الشحن',authorName:'مريم',createdAt:new Date(now).toISOString()}]}));
      _spOrdersLoaded=true;switchShopifyTab('all');renderShopifyOrders();
    });
    await page.waitForFunction(()=>document.querySelector('.sp-card-confirmed')&&getComputedStyle(document.querySelector('.sp-card-confirmed')).backgroundColor==='rgb(255, 255, 255)');
    const byRef=ref=>`#sp-mobile-list .sp-card:has(.sp-ref-link[onclick*="density-${ref-2801}"])`;
    for(const width of [320,390,430,820])for(const lang of ['ar','en'])for(const dark of [false,true]){
      await page.setViewport({width,height:1000,hasTouch:true});
      await page.evaluate(({lang,dark})=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);renderShopifyOrders();},{lang,dark});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const result=await page.evaluate(()=>{
        const cards=[...document.querySelectorAll('#sp-mobile-list>.sp-card')],overlaps=[];
        for(const [index,card]of cards.entries()){
          const a=card.querySelector('.sp-card-heading').getBoundingClientRect(),b=card.querySelector('.sp-card-money').getBoundingClientRect();
          if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)overlaps.push(index);
        }
        return {count:cards.length,overflow:cards.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),overlaps,
          pageOverflow:document.documentElement.scrollWidth>innerWidth,phones:document.querySelectorAll('#sp-mobile-list a[href^="tel:"]').length,
          paid:[...document.querySelectorAll('#sp-mobile-list .sp-card-deposit-paid')].map(e=>getComputedStyle(e).backgroundColor),
          unpaid:[...document.querySelectorAll('#sp-mobile-list .sp-card-deposit-none')].map(e=>getComputedStyle(e).backgroundColor)};
      });
      assert.equal(result.count,10);assert.deepEqual(result.overflow,[],JSON.stringify({width,lang,dark,result}));
      assert(await page.$(`${byRef(2801)}.sp-card-compact .sp-card-actions-row .sp-card-products-toggle`),'Paid cards combine product toggle and tools in one compact row');
      if(width===390){
        const paidHeight=await page.$eval(byRef(2801),e=>e.getBoundingClientRect().height);
        const unpaidHeight=await page.$eval(byRef(2807),e=>e.getBoundingClientRect().height);
        assert(paidHeight<unpaidHeight,'Confirmed cards take less height than unpaid action cards');
      }
      assert(await page.$(`${byRef(2806)} .sp-fu-add`),'Unpaid orders without a trail offer Add follow-up');
      assert.equal(await page.$(`${byRef(2802)} .sp-fu-add`),null,'Existing trails keep their history action');
      assert.equal(await page.$$eval('#sp-mobile-list .sp-card-deposit-paid .sp-fu-add',els=>els.length),0,'Paid/no-deposit-shipping cards do not offer Add follow-up');
      assert.equal(await page.$$eval('#sp-mobile-list .sp-card-deposit-paid .sp-card-fu-last',els=>els.length),0,'Approved/pending deposits and no-deposit shipping hide follow-up previews');
      assert(await page.$(`${byRef(2802)} .sp-card-fu-last`),'Unpaid orders keep their follow-up preview');
      assert(await page.$eval(byRef(2802),card=>{
        const name=card.querySelector('.sp-card-client'),ref=card.querySelector('.sp-card-ref');
        return name.parentElement.classList.contains('sp-card-meta') && name.parentElement.contains(card.querySelector('.sp-card-heading-time')) &&
          name.getBoundingClientRect().top>=ref.getBoundingClientRect().bottom-1 && parseFloat(getComputedStyle(name).fontSize)<parseFloat(getComputedStyle(ref).fontSize);
      }),'Small customer name sits below the order number alongside the timestamp');
      assert.deepEqual(result.overlaps,[],JSON.stringify({width,lang,dark,result}));assert(!result.pageOverflow);assert.equal(result.phones,0);
      if(!dark){
        assert(result.paid.every(c=>c==='rgb(255, 255, 255)'),'Approved/pending deposits and shipping without deposit are white');
        assert(result.unpaid.every(c=>c==='rgb(255, 251, 235)'),'All orders without a deposit are yellow, regardless of confirmation tags or status');
        for(const ref of [2801,2808,2810])assert.equal(await page.$eval(byRef(ref),e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
        for(const ref of [2807,2809])assert.equal(await page.$eval(byRef(ref),e=>getComputedStyle(e).backgroundColor),'rgb(255, 251, 235)');
      }
      assert.equal(await page.$eval(`${byRef(2807)} .sp-deposit-followup`,e=>e.textContent.trim()),lang==='en'?'Deposit Due':'عربون مستحق');
      for(const ref of [2807,2809]){
        assert(await page.$eval(byRef(ref),e=>e.classList.contains('sp-card-unconfirmed')),'Tags and approved status alone do not enable the checkmark');
        assert(await page.$eval(`${byRef(ref)} .sp-order-confirmation`,e=>e.classList.contains('is-waiting')),'No deposit shows the waiting icon');
      }
      for(const ref of [2801,2808,2810])assert(await page.$eval(`${byRef(ref)} .sp-order-confirmation`,e=>e.classList.contains('is-paid')),'Approved/pending deposits and shipping without deposit show the checkmark');
      assert.equal(await page.$eval(`${byRef(2807)} .sp-deposit-followup`,e=>getComputedStyle(e).whiteSpace),'nowrap');
      const toggle=await page.$(`${byRef(2802)} .sp-card-products-toggle`);await toggle.evaluate(e=>e.click());
      assert.equal(await toggle.evaluate(e=>e.getAttribute('aria-expanded')),'true');
      const products=await toggle.evaluate(e=>{const panel=document.getElementById(e.getAttribute('aria-controls'));return {display:getComputedStyle(panel).display,rows:panel.children.length,thumb:panel.querySelector('.sp-card-ith').getBoundingClientRect().width,overflow:panel.scrollWidth>panel.clientWidth+1};});
      assert.equal(products.display,'flex');assert.equal(products.rows,2);assert(products.thumb>=32&&products.thumb<=40);assert(!products.overflow);
      await toggle.evaluate(e=>e.click());assert.equal(await toggle.evaluate(e=>e.getAttribute('aria-expanded')),'false');
      if(width===390&&lang==='ar'&&!dark)await page.screenshot({path:'artifacts/orders-cards-neutral-ar.png',fullPage:true});
      if(width===390&&lang==='en'&&!dark)await page.screenshot({path:'artifacts/orders-cards-neutral-en.png',fullPage:true});
      if(width===820&&lang==='en'&&!dark)await page.screenshot({path:'artifacts/orders-cards-neutral-wide.png',fullPage:true});
    }
    await page.setViewport({width:390,height:1000,hasTouch:true});
    await page.evaluate(()=>{currentLang='en';document.body.classList.remove('dark-mode');renderShopifyOrders();});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.$eval(`${byRef(2801)} .sp-card-products-toggle`,e=>e.click());
    assert.equal(await page.$eval('#sp-items-density-0',e=>getComputedStyle(e).display),'flex','Compact cards still expand product details');
    await page.$eval(`${byRef(2801)} .sp-card-products-toggle`,e=>e.click());
    await page.focus(`${byRef(2802)} .sp-card-products-toggle`);await page.keyboard.press('Enter');
    assert.equal(await page.$eval(`${byRef(2802)} .sp-card-products-toggle`,e=>e.getAttribute('aria-expanded')),'true');
    await (await page.$(byRef(2802))).screenshot({path:'artifacts/order-card-neutral-expanded.png'});
    await page.focus(`${byRef(2802)} .dd-toggle`);await page.keyboard.press('Enter');
    await page.waitForSelector('.dd-menu-portal');
    assert(await page.$eval('.dd-menu-portal',e=>!!e.querySelector('[onclick*="approveShopifyOrder"]')));
    await page.evaluate(()=>closeAllMenus());
    const payments=await page.$eval(byRef(2802),e=>({switch:e.querySelector('[role="switch"]').getAttribute('onclick'),deposit:e.querySelector('.spdep-quick-add').getAttribute('onclick'),shopify:e.querySelector('.sp-card-shopify-link').href,chat:e.querySelector('.sp-card-vrobo-link').href}));
    assert(payments.switch.includes('_spToggleShipWithoutDeposit'));assert(payments.deposit.includes('openSpReceiptForm'));assert(payments.shopify.includes('admin.shopify.com'));assert(payments.chat.includes('merchant.vrobo.co'));
    for(const ref of [2801,2808,2810])assert(await page.$(`${byRef(ref)} .sp-fu-mark`),'Hidden previews retain the follow-up history action');
    await page.$eval(`${byRef(2806)} .sp-fu-add`,e=>e.click());
    assert.equal(await page.$eval('#fu-modal-overlay',e=>getComputedStyle(e).display),'flex','Add follow-up opens the existing form');
    assert.equal(await page.$eval('#fu-modal-reason',e=>e.value),'عملية تأكيد الطلب');
    await page.evaluate(()=>closeFuModal());
    await page.setViewport({width:1800,height:1000});await page.evaluate(()=>renderShopifyOrders());
    assert.equal(await page.$eval('#sp-orders-tab-content',e=>e.dataset.layout),'table');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: 10 order states; yellow without deposit / white approved deposit, pending deposit or shipping without deposit; independent confirmation labels; product rows and keyboard; menu, deposit, chat and Shopify actions; RTL/LTR, 4 card widths, dark mode and desktop table; inline JS syntax.');
  }finally{await browser?.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
