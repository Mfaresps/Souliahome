const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('../backend/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'login-space-browser')});
  try {
    for (const [lang,width,height] of [['en',1440,900],['ar',390,844]]) {
      const page=await browser.newPage();
      await page.setViewport({width,height});
      await page.evaluateOnNewDocument(lang=>{
        localStorage.clear();localStorage.setItem('soulia_lang_pref',lang);
      },lang);
      let submissions=0, mode='error'; const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const url=new URL(request.url());
        if(url.origin!=='http://localhost:8080')request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
        else if(url.pathname==='/api/auth/login'){
          submissions++;
          const payload = mode==='totp' ? {requireTotp:true,userId:'preview-user'} : mode==='success' ? {accessToken:'preview-only',user:{_id:'preview-user',name:'Preview',role:'staff',perms:[]}} : {message:'Invalid credentials'};
          const status = mode==='error' ? 401 : 200;
          setTimeout(()=>request.respond({status,contentType:'application/json',body:JSON.stringify(payload)}).catch(()=>{}),700);
        } else if(url.pathname.startsWith('/api/'))request.respond({status:200,contentType:'application/json',body:'{}'});
        else request.continue();
      });
      await page.goto('http://localhost:8080',{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!document.querySelector('#splash-screen'));
      await page.screenshot({path:path.join(__dirname,`login-space-${lang}.png`)});
      const geometry=await page.evaluate(()=>{
        const field=document.querySelector('#login-user').getBoundingClientRect();
        const button=document.querySelector('.lfp-btn-login').getBoundingClientRect();
        return {width:field.width,height:field.height,buttonHeight:button.height,direction:document.querySelector('#login-form').dir,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert(geometry.width>=280 && geometry.height>=48 && geometry.buttonHeight>=48);
      assert.equal(geometry.direction,lang==='ar'?'rtl':'ltr');assert(!geometry.overflow);
      await page.click('.lfp-btn-login');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'login-user');
      assert.equal(submissions,0);
      await page.type('#login-user','preview'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'login-pass');
      await page.type('#login-pass','preview-only');
      await page.click('#login-pass-toggle');
      assert.equal(await page.$eval('#login-pass',el=>el.type),'text');
      assert.equal(await page.$eval('#login-pass-toggle',el=>el.getAttribute('aria-pressed')),'true');
      await page.click('#login-pass-toggle');
      await page.evaluate(()=>loginCapsLock({getModifierState:()=>true}));
      assert.equal(await page.$eval('#login-caps-warning',el=>el.hidden),false);
      await page.focus('#login-pass');await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('.lfp-btn-login').getAttribute('aria-busy')==='true');
      await page.evaluate(()=>doLogin()); // Duplicate submission is ignored while busy.
      assert.equal(await page.$eval('.lfp-btn-login',el=>el.disabled),true);
      await page.waitForFunction(()=>document.querySelector('.lfp-btn-login').getAttribute('aria-busy')==='false');
      assert.equal(submissions,1);
      assert.equal(await page.$eval('#login-error',el=>el.textContent),'Invalid credentials');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'login-pass');
      await page.type('#login-pass','x');
      assert.equal(await page.$eval('#login-error',el=>getComputedStyle(el).display),'none');
      if(lang==='en'){
        mode='totp';
        await page.evaluate(()=>doLogin());
        assert(await page.$('#totp-verify-overlay'));
        assert.equal(await page.$eval('.lfp-btn-login',el=>el.disabled),false);
        await page.evaluate(()=>document.querySelector('#totp-verify-overlay').remove());
        mode='success';
        await page.evaluate(()=>{window.showApp=async()=>{window.previewAppOpened=true;};});
        await page.evaluate(()=>doLogin());
        assert.equal(await page.evaluate(()=>window.previewAppOpened),true);
        assert.equal(await page.$eval('.lfp-btn-login',el=>el.getAttribute('aria-busy')),'false');
      }
      if(lang==='ar'){
        await page.setViewport({width:390,height:430});
        await page.$eval('.lfp-btn-login',el=>el.scrollIntoView({block:'center'}));
        const visible=await page.$eval('.lfp-btn-login',el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
        assert(visible,'Sign-in remains reachable with a short viewport');
      }
      assert.deepEqual(errors,[]);
      console.log(lang+': form size, language, validation, Enter, reveal, Caps Lock, duplicate guard, errors and short viewport verified.');
      await page.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
