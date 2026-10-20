const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{
  const browser=await puppeteer.launch({headless:true,pipe:true});
  try{
    const page=await browser.newPage();await page.setViewport({width:1440,height:1000});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const user={_id:'507f1f77bcf86cd799439011',name:'Preview',username:'preview',role:'admin',perms:['dashboard','inventory','suppliers','shopify-orders','complaints']};
    const mentionId='507f1f77bcf86cd799439012';
    const now=Date.now();
    const history=Array.from({length:24},(_,i)=>({_id:i.toString(16).padStart(64,'0'),type:i===0?'comment':'approval',title:i===0?'New comment':'Request approved',body:'Notification fixture '+i,recordId:'tx:fixture',event:i===0?'42':String(i),actorName:'Mona',actorUserId:'author',actorAvatar:'/broken-avatar-fixture.png',createdAt:new Date(now-i*60000).toISOString(),readAt:null,ref:'2745',url:'/?pushRecord=tx:fixture&pushType=comment'}));
    history.push({_id:'f'.repeat(64),type:'mention',title:'Mention',recordId:'mention:'+mentionId,createdAt:history[0].createdAt,readAt:null});
    Object.assign(history[1],{type:'delivered',title:'📦 Order Delivered',body:'Order #2745 · Successfully Delivered'});
    Object.assign(history[2],{type:'deliveryProblem',title:'🚨 Delivery Issue',body:'Order #2746 · Returned Before Delivery · Action Required'});
    history[1].actorAvatar='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2c7a50"/><text x="9" y="23" fill="white" font-size="20">M</text></svg>').toString('base64');
    const mentions=[{id:mentionId,targetUserId:user._id,fromUserId:'author',fromName:'Mona',txId:'fixture',commentId:42,commentText:'Latest comment with a mention',ts:history[0].createdAt,read:false}];
    const readRequests=[],legacyReads=new Set();
    await page.evaluateOnNewDocument(user=>{localStorage.setItem('soulia_lang_pref','en');localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));},user);
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.pathname==='/broken-avatar-fixture.png')return request.respond({status:404,body:''});
      if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?'window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}':''});
      if(url.pathname.startsWith('/api/')){
        let data=[];
        if(url.pathname==='/api/auth/me')data=user;
        if(url.pathname==='/api/settings')data={lang:'en'};
        if(url.pathname==='/api/mentions')data=mentions;
        if(url.pathname==='/api/notifications/history')data={items:history,unread:history.filter(n=>!n.readAt).length,next:''};
        if(url.pathname==='/api/notifications/read-state'){
          if(request.method()==='POST')for(const id of JSON.parse(request.postData()).ids)legacyReads.add(id);
          data={ids:[...legacyReads]};
        }
        if(url.pathname==='/api/notifications/read-all'){
          const body=JSON.parse(request.postData());
          for(const id of body.ids)legacyReads.add(id);
          for(const row of history)if(Date.parse(row.createdAt)<=Date.parse(body.before)){row.readAt=new Date().toISOString();readRequests.push(row._id);}
          for(const row of mentions)if(Date.parse(row.ts)<=Date.parse(body.before))row.read=true;
          data={success:true,before:body.before,unread:history.filter(n=>!n.readAt).length};
        }
        if(url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences')data={configured:false,language:'en',preferences:{enabled:false,deposit:true,comment:true,followup:true,order:true,deliveryProblem:true,delivered:true,mention:true},devices:0};
        if(/^\/api\/notifications\/history\/[^/]+\/read$/.test(url.pathname)){
          const id=url.pathname.split('/').at(-2);readRequests.push(id);const row=history.find(n=>n._id===id);if(row)row.readAt=new Date().toISOString();data={success:true};
        }
        if(url.pathname==='/api/mentions/'+mentionId+'/read'){mentions[0].read=true;data={ok:true};}
        if(url.pathname==='/api/complaints')data=[{_id:'old-complaint',complaintNo:'OLD-2026',status:'معلق',submittedBy:'Old',description:'Old urgent complaint',createdAt:'2026-07-01T00:00:00Z'}];
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
      }
      if(url.pathname==='/config.js')return request.respond({contentType:'text/javascript',body:'window.__ENV__={API_BASE_URL:""};'});
      const file=path.resolve(__dirname,'../frontend/public',url.pathname==='/'?'index.html':'.'+url.pathname);
      const publicRoot=path.resolve(__dirname,'../frontend/public')+path.sep;
      if(!file.startsWith(publicRoot)||!fs.existsSync(file))return request.respond({status:404,body:''});
      const extension=path.extname(file);
      return request.respond({status:200,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'}[extension]||'application/octet-stream'),body:fs.readFileSync(file)});
    });
    await page.goto('http://localhost:8080/#inventory',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!document.querySelector('#splash-screen')&&typeof souliaMergeNotifications==='function');
    await page.evaluate(async()=>{localStorage.setItem(LOCK_KEYS.adbAutoShow,'0');if(typeof closeAdminBriefing==='function')closeAdminBriefing();await refreshMentionsFromServer();await souliaRefreshNotificationHistory();});
    assert.equal(readRequests.length,0,'Closed notifications must not mark anything read');
    await page.evaluate(()=>toggleNotifPanel({stopPropagation(){}}));
    await page.waitForSelector('#notif-panel.show [data-notification-id]');
    const first=await page.$eval('#notif-list [data-notification-id]',el=>({id:el.dataset.notificationId,text:el.textContent}));
    assert.equal(first.id,'mention-'+mentionId);assert(first.text.includes('Latest comment'));
    assert.equal(await page.$$eval('#notif-list [data-notification-id]',els=>els.length),25,'Comment + mention history collapse into one item');
    assert.equal(await page.$eval('#notif-tab-mentions',el=>getComputedStyle(el).display),'none');
    await page.waitForFunction(()=>!document.querySelector('#notif-list img[src="/broken-avatar-fixture.png"]'));
    assert(await page.$eval('#notif-list img[src^="data:image"]',el=>el.complete&&el.naturalWidth>0&&!el.hidden),'Available actor photos are displayed');
    assert(await page.$eval('#notif-list .notification-avatar-fallback',el=>el.getBoundingClientRect().width>0),'Broken photos retain a visible event icon');
    const iconBefore=await page.$eval('#notif-list .notification-avatar',el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
    await page.evaluate(()=>{_updateMentionBadge();buildNotifications();_updateMentionBadge();});
    const iconAfter=await page.$eval('#notif-list .notification-avatar',el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
    assert.deepEqual(iconAfter,iconBefore,'Icon geometry stays fixed across badge updates and repaints');
    assert.equal(await page.$eval('#notif-badge',el=>el.classList.contains('notif-badge-mention')),false,'Opening must not restart the badge pop animation');
    assert.equal(await page.$eval('#notif-panel',el=>getComputedStyle(el).transform),'none','Opening does not slide icons');
    await page.waitForFunction(()=>document.querySelector('#notif-badge').textContent==='');
    assert(await page.$eval('#notif-list [data-notification-id]',el=>el.classList.contains('unread-notif')),'Newly opened items retain a visible highlight after the badge clears');
    assert(mentions[0].read);assert(readRequests.includes(history[0]._id));assert(readRequests.includes('f'.repeat(64)));
    assert(readRequests.includes(history[20]._id),'Opening the inbox clears old offscreen history too');
    await page.waitForFunction(()=>document.querySelector('#notif-badge').textContent==='');
    await page.waitForSelector('#push-settings-shortcut:not([hidden])');
    assert.equal(await page.$eval('#push-settings-shortcut',el=>el.textContent.trim()),'');
    assert(await page.$eval('#push-settings-shortcut',el=>!!el.querySelector('svg')&&el.getBoundingClientRect().width<=32&&!!el.closest('.notif-header-top')),'Small settings icon sits next to Clear all');
    assert.equal(await page.$eval('#notif-panel',el=>el.getBoundingClientRect().width),420);
    assert(await page.$eval('.notification-delivered .notification-check',el=>el.tagName.toLowerCase()==='svg'));
    assert.equal(await page.$eval('.notification-delivered .notif-desc',el=>getComputedStyle(el).color),'rgb(21, 128, 61)');
    assert.equal(await page.$eval('.notification-delivery-issue .notif-title',el=>getComputedStyle(el).color),'rgb(153, 27, 27)');
    assert(!(await page.$eval('.notification-delivered .notif-title',el=>el.textContent)).includes('📦'));
    assert((await page.$eval('[data-notification-time]',el=>el.textContent)).includes('ago'));
    await page.screenshot({path:path.join(__dirname,'notification-feed-panel.png')});
    await page.click('#push-settings-shortcut');
    await page.waitForSelector('.push-settings-dialog[open]');
    await page.waitForSelector('.push-preferences-dialog [data-preference="enabled"]');
    assert(await page.$eval('.push-preferences-dialog',el=>el.getBoundingClientRect().width<=440&&el.getBoundingClientRect().height<=540),'Settings dialog is compact');
    await page.screenshot({path:path.join(__dirname,'notification-settings-compact.png')});
    await page.evaluate(()=>document.querySelector('.push-settings-dialog[open]').close());
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!document.querySelector('#splash-screen')&&typeof souliaMergeNotifications==='function');
    await page.evaluate(async()=>{if(typeof closeAdminBriefing==='function')closeAdminBriefing();await refreshMentionsFromServer();await souliaRefreshNotificationHistory();});
    await page.waitForFunction(()=>document.querySelector('#notif-badge').textContent==='');
    assert(await page.evaluate(()=>_notifReadIds.includes('cmp-pending-old-complaint')),'Internal notification reads survive refresh');
    history.unshift({_id:'e'.repeat(64),type:'order',title:'Brand new order',body:'Arrived after opening',recordId:'tx:new',event:'new',createdAt:new Date(Date.now()+1000).toISOString(),readAt:null});
    await page.evaluate(async()=>{await souliaRefreshNotificationHistory();buildNotifications();});
    await page.waitForFunction(()=>document.querySelector('#notif-badge').textContent==='1');
    await page.evaluate(()=>toggleNotifPanel({stopPropagation(){}}));
    await page.waitForSelector('#notif-panel.show [data-notification-id]');
    await page.evaluate(()=>{if(typeof closeAdminBriefing==='function')closeAdminBriefing();currentLang='ar';document.documentElement.dir='rtl';buildNotifications();});
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>{if(typeof closeAdminBriefing==='function')closeAdminBriefing();});
    assert.equal(await page.$eval('#notif-panel',el=>getComputedStyle(el).display),'flex');
    assert(await page.$eval('#notif-panel',el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth),'Enlarged panel fits mobile');
    await page.screenshot({path:path.join(__dirname,'notification-panel-mobile-ar.png')});
    await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';});
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>openNotifCenter());
    await page.waitForSelector('#nc-overlay.active .nc-item');
    assert(!(await page.$eval('#nc-sidebar',el=>el.textContent)).includes('Mentions'));
    assert.equal(await page.$eval('#nc-main [data-notification-id]',el=>el.dataset.notificationId),'history-'+'e'.repeat(64));
    await page.screenshot({path:path.join(__dirname,'notification-feed-center.png')});
    await page.setViewport({width:390,height:844});
    await page.waitForFunction(()=>document.getElementById('mention-alert-overlay').style.display==='none');
    await page.screenshot({path:path.join(__dirname,'notification-feed-mobile.png')});
    await page.evaluate(()=>{document.documentElement.dir='rtl';});
    assert(await page.$eval('#nc-main',el=>el.getBoundingClientRect().right<=innerWidth),'RTL center fits mobile width');
    assert.deepEqual(errors,[]);
    console.log('PASS: live relative times, persistent new-item highlights, green SVG delivery check, dark-red delivery issue, enlarged inbox, compact settings, reload counts, mobile/desktop.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
