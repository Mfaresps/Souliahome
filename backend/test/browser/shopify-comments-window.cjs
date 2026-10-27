const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/comments-window');
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await puppeteer.launch({headless:true});
  try {
    const page = await browser.newPage();
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', request=>{
      const url=new URL(request.url()), file=path.resolve(publicDir, url.pathname==='/'?'index.html':url.pathname.slice(1));
      if(url.origin==='http://comments.test' && file.startsWith(publicDir+path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({status:200,contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/webp',body:fs.readFileSync(file)});
      if(request.resourceType()==='script')return request.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
      return request.respond({status:200,contentType:'application/json',body:'[]'});
    });
    await page.goto('http://comments.test/',{waitUntil:'domcontentloaded'});
    for(const [lang,width,dark] of [['ar',1440,false],['ar',390,false],['en',390,false],['ar',390,true]]) {
      await page.setViewport({width,height:850});
      await page.evaluate(({lang,dark})=>{
        currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.documentElement.lang=lang;
        document.body.classList.toggle('dark-mode',dark);
        currentUser={name:'Fares',role:'admin'};
        qs('#splash-screen')?.remove();qs('#login-page').style.display='none';
        _shopifyOrders=[{_id:'comment-preview',ref:'2814',client:'Amel Refat',comments:[
          {id:1,employee:'Marwa',text:'العميلة تسأل عن Lovely Basket بنفس المقاس، مع قلوب باللون الأبيض.\nبرجاء تأكيد المقاس والتكلفة قبل التواصل معها.',timestamp:new Date(Date.now()-3600000).toISOString()},
          {id:2,employee:'Hassan Ammar',text:'يرجى مراجعة اللون المطلوب وتأكيد التفاصيل مع العميلة.',timestamp:new Date(Date.now()-1800000).toISOString()},
          {id:3,employee:'Fares',text:'الباسكت باللون الأبيض والقلوب باللون الأحمر.\nهل تفضل العميلة القلوب باللون الأبيض أيضًا؟',timestamp:new Date().toISOString()}
        ]}];
        openShopifyCommentsModal('comment-preview');
      },{lang,dark});
      await new Promise(r=>setTimeout(r,250));
      assert.equal(await page.$eval('#sp-cmtwin-count',el=>el.textContent),'3');
      assert.equal(await page.$eval('.sp-cmtwin textarea',el=>el.getBoundingClientRect().height>=80),true);
      assert.equal(await page.$eval('.sp-cmtwin',el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.type('.sp-cmtwin textarea','First line');
      await page.keyboard.down('Shift');await page.keyboard.press('Enter');await page.keyboard.up('Shift');
      await page.type('.sp-cmtwin textarea','Second line');
      assert.equal(await page.$eval('.sp-cmtwin textarea',el=>el.value),'First line\nSecond line');
      await page.screenshot({path:path.join(output,`${lang}-${width}${dark?'-dark':''}.png`)});
    }
    const mention=await page.evaluate(()=>{
      users=[{_id:'marwa',name:'Marwa',avatar:'https://images.example.com/marwa.webp'},{_id:'hassan',name:'Hassan Ammar',avatar:''}];
      const input=qs('.sp-cmtwin textarea');input.value='@';input.focus();input.setSelectionRange(1,1);
      openMentionDropdown(input,'comment-preview','');
      const items=[...document.querySelectorAll('.mention-item')];
      const photo=items[0].querySelector('img');
      const src=photo.getAttribute('src');
      photo.dispatchEvent(new Event('error'));
      const fallback=photo.nextElementSibling.style.display==='flex';
      items[0].click();
      return {src,fallback,value:input.value};
    });
    assert.deepEqual(mention,{src:'https://images.example.com/marwa.webp',fallback:true,value:'@Marwa '});
    const keys=await page.evaluate(()=>{
      let sends=0;_spAddComment=()=>sends++;
      const input=qs('.sp-cmtwin textarea');
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
      return sends;
    });
    assert.equal(keys,1);
    assert.deepEqual(errors,[]);
    console.log('PASS comments window: Arabic/English, mobile/desktop, dark mode, multiline entry and send key.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
