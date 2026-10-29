/* Pick-Up Orders page visibility and read-only controls; all API writes mocked. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return request.respond({ contentType: ({ '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp' })[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ contentType:'text/javascript', body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ contentType:'application/json', body:'[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil:'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'en'; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      onPageEnter = () => {}; window.pickupWrites = [];
      api = async (url, options = {}) => {
        if (options.method && options.method !== 'GET') pickupWrites.push(url);
        return url === '/transactions/pickup-orders' ? structuredClone(_pickupOrders) : [];
      };
      currentUser = { _id:'operator', role:'staff', perms:['movements','inventory-units-view','inventory-units-allocate'] };
      const base = { type:'مبيعات', client:'Preview Customer', phone:'01000000000', total:500, remaining:0, date:'2026-10-29', createdAt:'2026-10-29T08:00:00Z', shipCo:'Bosta', items:[{name:'Cotton basket', code:'SKU-1', qty:1, price:500, lineId:'line-1'}] };
      _pickupOrders = [
        {...base, _id:'pending', ref:'3201', pickupStatus:'Pending'},
        {...base, _id:'prep', ref:'3202', pickupStatus:'Preparing', pickupRef:'PREP-TEST', prepRef:'PREP-TEST', prepCreatedAt:'2026-10-29T08:00:00Z', prepChecked:false},
        {...base, _id:'ready', ref:'3203', pickupStatus:'Ready', pickupRef:'READY-TEST', bostaOrderId:'b-ready', bostaStatus:'CREATED', shipmentEvents:[{type:'sent',at:'2026-10-29T08:00:00Z'}]},
      ];
      transactions = _pickupOrders.map(row => ({...row})); _puOrdersLoaded = true;
      _puLoadPrepGroups(_pickupOrders); _bpSetRequests([]);
    });
    const hidden = await page.evaluate(() => {
      currentPage = 'movements'; buildSidebar(); navigateTo('pickup-orders');
      return { allowed:_canAccessPage('pickup-orders'), page:currentPage, link:!!document.querySelector('[data-page="pickup-orders"]') };
    });
    assert.equal(hidden.allowed, false); assert.equal(hidden.page, 'movements'); assert.equal(hidden.link, false);
    await page.evaluate(() => {
      currentUser.perms.push('pickup-orders'); buildSidebar(); navigateTo('pickup-orders'); puSwitchView('board');
    });
    for (const width of [1440,390]) {
      await page.setViewport({width,height:950});
      const readOnly = await page.evaluate(async () => {
        _puPaintCurrentView();
        const page = qs('#page-pickup-orders');
        const actions = [...page.querySelectorAll('[data-pu-edit]')];
        const result = {
          allowed:_canAccessPage('pickup-orders'), readonly:!_puCanEdit(),
          actionsHidden:actions.length > 0 && actions.every(el=>getComputedStyle(el).display==='none'),
          draggable:page.querySelectorAll('[draggable="true"]').length,
          filter:!qs('#pu-pending-search')?.disabled, refresh:!qs('#pu-refresh-btn').disabled,
        };
        const group = _puPrepGroups[0];
        if (!group) throw Error('Missing preparation fixture');
        openPuCardOrdersModal(group.prepRef,'prep');
        result.details = !!qs('#pw-work').textContent.trim();
        result.scanTools = !!qs('#pw-work .pw-barcode-tools');
        await openPrepGroupModal(); await puCardSave('prep'); await puBoardDrop();
        await _puReturnReadyOrder('ready','pending'); await submitBostaPickup();
        result.writes = pickupWrites.length;
        closePuCardOrdersModal();
        return result;
      });
      assert(readOnly.allowed && readOnly.readonly && readOnly.actionsHidden && readOnly.filter && readOnly.refresh && readOnly.details,JSON.stringify(readOnly));
      assert.equal(readOnly.draggable,0); assert.equal(readOnly.scanTools,false); assert.equal(readOnly.writes,0);
      const output = path.join(root,'artifacts/pickup-permissions'); fs.mkdirSync(output,{recursive:true});
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(el => el.remove()));
      await page.screenshot({path:path.join(output,'read-only-'+width+'.png')});
      console.log('PASS read-only page, detail viewing, filters and denied writes:',width);
    }
    const editor = await page.evaluate(() => {
      currentUser.perms.push('pickup-orders-edit'); buildSidebar(); puSwitchView('board');
      return {allowed:_puCanEdit(),readonlyClass:document.body.classList.contains('pu-readonly'),draggable:qs('#page-pickup-orders').querySelectorAll('[draggable="true"]').length};
    });
    assert(editor.allowed && !editor.readonlyClass && editor.draggable > 0,JSON.stringify(editor));
    console.log('PASS hidden page and editable page permission states.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });

