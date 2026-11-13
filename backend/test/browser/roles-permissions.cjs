const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const path = require('node:path');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const fixtureRoles = [
  {slug:'super-admin',name:'Super Admin',description:'Protected owner account with full system access.',system:true,locked:true,baseRole:'admin',perms:['dashboard','users','settings'],users:[{id:'1',username:'admin',name:'Owner',isActive:true}]},
  {slug:'admin',name:'Admin',description:'Full administrative access.',system:true,locked:true,baseRole:'admin',perms:['dashboard'],users:[]},
  {slug:'manager',name:'Manager',description:'Operations, orders, stock and approvals.',system:true,locked:false,baseRole:'staff',perms:['dashboard','shopify-orders'],users:[{id:'2',username:'manager',name:'Mona',isActive:true,assignedAt:'2026-10-02T00:00:00Z'}]},
  ...['accountant','sales','warehouse','customer-service','viewer'].map(name=>({slug:name,name:name.replace(/\b\w/g,c=>c.toUpperCase()),description:'Team role',system:true,locked:false,baseRole:name==='viewer'?'viewer':'staff',perms:[],users:[]})),
];
(async()=>{
  const browser=await puppeteer.launch({headless:true});
  try {
    const page=await browser.newPage(); const errors=[]; const writes=[]; let roleReads=0;
    page.on('pageerror',error=>errors.push(error.stack||error.message));
    await page.setViewport({width:1440,height:900});
    await page.evaluateOnNewDocument(lang=>{
      localStorage.setItem('token','rbac-test');
      localStorage.setItem('user',JSON.stringify({id:'1',username:'admin',name:'Owner',role:'admin',perms:[]}));
      if (lang) localStorage.setItem('soulia_lang_pref',lang);
    },process.env.RBAC_LANG||'');
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const path=new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return request.continue();
      if (path==='/api/roles') {
        if (request.method()==='POST') {
          const data=JSON.parse(request.postData()); const role={...data,slug:data.name.toLowerCase().replace(/\W+/g,'-'),system:false,locked:false,users:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
          fixtureRoles.push(role); writes.push({path,method:'POST',body:request.postData()});
          return request.respond({status:201,contentType:'application/json',body:JSON.stringify(role)});
        }
        roleReads++;
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify({roles:fixtureRoles,canManage:true})});
      }
      if (path==='/api/auth/me') return request.respond({status:200,contentType:'application/json',body:JSON.stringify({id:'1',username:'admin',name:'Owner',role:'admin',perms:[],isActive:true})});
      if (path==='/api/users') return request.respond({status:200,contentType:'application/json',body:JSON.stringify([{_id:'1',username:'admin',name:'Owner'},{_id:'2',username:'manager',name:'Mona'},{_id:'3',username:'new',name:'Nour'}])});
      if (path.startsWith('/api/security-audit/')) return request.respond({status:200,contentType:'application/json',body:'[]'});
      if (path.startsWith('/api/roles/')) {
        writes.push({path,method:request.method(),body:request.postData()});
        const [, , , slug, action] = path.split('/');
        const role=fixtureRoles.find(item=>item.slug===slug);
        const data=request.postData()?JSON.parse(request.postData()):{};
        if (request.method()==='PATCH') Object.assign(role,data,{updatedAt:new Date().toISOString()});
        if (request.method()==='DELETE') fixtureRoles.splice(fixtureRoles.indexOf(role),1);
        if (action==='assign') { const user={id:data.userId,username:'new',name:'Nour',isActive:true,assignedAt:new Date().toISOString()}; role.users.push(user); }
        if (action==='unassign') role.users=role.users.filter(user=>user.id!==data.userId);
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify(role||{})});
      }
      return request.respond({status:200,contentType:'application/json',body:path==='/api/transactions/startup-overview'?'{"rows":[],"activeCount":0}':'{}'});
    });
    await page.goto(origin+'/#roles',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.querySelector('#rbac-role-list .rbac-role-item')?.getClientRects().length>0,{timeout:15000});
    assert.equal(await page.$eval('#page-users',el=>el.classList.contains('active')),true,'roles render inside Users');
    assert.equal(await page.$eval('#users-tab-roles',el=>el.getAttribute('aria-selected')),'true');
    assert.equal(await page.$eval('#sidebar',el=>!!el.querySelector('[data-page="roles"]')),false,'no duplicate Roles sidebar item');
    await page.click('#users-tab-accounts');
    assert.equal(await page.$eval('#users-accounts-view',el=>el.hidden),false);
    assert.equal(await page.$eval('#users-roles-view',el=>el.hidden),true);
    assert.equal(await page.evaluate(()=>{const admin=currentUser;currentUser={...admin,role:'staff',perms:['users']};syncUsersWorkspaceTab('users');const hidden=document.querySelector('#users-tab-roles').hidden;currentUser=admin;syncUsersWorkspaceTab('users');return hidden;}),true,'non-admin cannot see role management tab');
    await page.click('#users-tab-roles');
    assert.equal(await page.$eval('#users-roles-view',el=>el.hidden),false);
    assert.equal(new URL(page.url()).hash,'#roles','direct link remains shareable');
    assert.equal(roleReads,1,'switching tabs reuses loaded roles');
    assert.equal(await page.$$eval('.rbac-role-item',items=>items.length),8);
    await page.click('[data-role="manager"]');
    if (process.env.RBAC_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.RBAC_SCREENSHOT_DIR,'roles-desktop.png'),fullPage:true});
    await page.evaluate(()=>{currentLang='en';applyLang();window.rbacOpen();});
    assert.equal(await page.$eval('#rbac-root',el=>el.dir),'ltr');
    if (process.env.RBAC_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.RBAC_SCREENSHOT_DIR,'roles-desktop-en.png'),fullPage:true});
    await page.click('[data-expand="employees"]');
    assert.equal(await page.$eval('[data-perm="users"]',el=>el.disabled),true);
    await page.click('[data-perm="dashboard"]');
    assert.match(await page.$eval('.rbac-unsaved',el=>el.textContent),/Unsaved|محفوظة/);
    await page.click('#rbac-save');
    // A role with accounts on it names them before its access changes.
    await page.waitForFunction(()=>document.querySelector('#rbac-dialog').open);
    assert.match(await page.$eval('#rbac-dialog',el=>el.textContent),/Mona/,'role edit names the accounts it changes');
    await page.click('#rbac-confirm');
    await page.waitForFunction(()=>document.querySelector('#rbac-status').textContent.includes('saved') || document.querySelector('#rbac-status').textContent.includes('حفظ'));
    assert.ok(writes.some(write=>write.path==='/api/roles/manager'&&write.method==='PATCH'));
    await page.click('[data-expand="cash"]');
    await page.click('[data-perm="vault"]');
    await page.click('#rbac-save');
    assert.equal(await page.$eval('#rbac-dialog',el=>el.open),true,'sensitive grant needs confirmation');
    await page.click('#rbac-confirm');
    await page.waitForFunction(()=>!document.querySelector('#rbac-dialog').open);
    await page.click('#rbac-create');
    const dialogBox=await page.$eval('#rbac-dialog',el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};});
    assert.ok(Math.abs(dialogBox.left+(dialogBox.width/2)-(dialogBox.viewportWidth/2))<12,'create dialog centered horizontally');
    assert.ok(Math.abs(dialogBox.top+(dialogBox.height/2)-(dialogBox.viewportHeight/2))<12,'create dialog centered vertically');
    await page.type('#rbac-form [name="name"]','Auditor');
    await page.select('#rbac-form [name="baseRole"]','viewer');
    await page.click('#rbac-form [type="submit"]');
    await page.waitForFunction(()=>document.querySelectorAll('.rbac-role-item').length===9);
    assert.match(await page.$eval('.rbac-detail-head h2',el=>el.textContent),/Auditor/);
    await page.click('[data-perm="dashboard"]');
    await page.click('#rbac-save');
    await page.waitForFunction(()=>document.querySelector('#rbac-status').textContent.includes('saved'));
    await page.click('.rbac-detail [data-assign="auditor"]');
    await page.waitForSelector('#rbac-assign-form [type="submit"]');
    await page.select('#rbac-assign-form select','3');
    await page.click('#rbac-assign-form [type="submit"]');
    await page.waitForFunction(()=>document.querySelector('.rbac-users-table')?.textContent.includes('Nour'));
    await page.click('.rbac-detail [data-unassign="3"]');
    await page.click('#rbac-confirm');
    await page.waitForFunction(()=>!document.querySelector('.rbac-users-table'));
    await page.click('.rbac-detail [data-delete="auditor"]');
    await page.click('#rbac-confirm');
    await page.waitForFunction(()=>document.querySelectorAll('.rbac-role-item').length===8);
    assert.ok(writes.some(write=>write.path==='/api/roles/auditor/assign'));
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>window.rbacOpen());
    await page.click('#rbac-create');
    const mobileDialogBox=await page.$eval('#rbac-dialog',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
    assert.ok(mobileDialogBox.left>=16 && mobileDialogBox.right<=mobileDialogBox.width-16,'mobile dialog keeps screen gutters');
    assert.ok(mobileDialogBox.top>=16 && mobileDialogBox.bottom<=mobileDialogBox.height-16,'mobile dialog fits viewport');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>scrollTo(0,0));
    if (process.env.RBAC_SCREENSHOT_DIR) {
      await page.screenshot({path:path.join(process.env.RBAC_SCREENSHOT_DIR,'roles-mobile-viewport.png')});
      await page.screenshot({path:path.join(process.env.RBAC_SCREENSHOT_DIR,'roles-mobile.png'),fullPage:true});
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: roles page, protected permission, save, and mobile width.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
