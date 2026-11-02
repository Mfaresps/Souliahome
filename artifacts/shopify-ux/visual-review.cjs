const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('../../backend/node_modules/puppeteer');

const publicDir = path.resolve(__dirname, '../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const width of [1920, 1440, 800, 768, 390]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://soulia.test' && url.pathname === '/') {
          return request.respond({ status: 200, contentType: 'text/html', body: html });
        }
        const file = path.join(publicDir, url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
          return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
        }
        if (request.resourceType() === 'script') {
          return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        }
        return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        currentLang = 'ar';
        document.documentElement.lang = 'ar';
        document.documentElement.dir = 'rtl';
        currentUser = { _id: 'review-user', name: 'موظف المراجعة', role: 'staff', perms: ['shopify-orders', 'shopify-deposit-upload', 'followups', 'complaints'] };
        qs('#app').style.display = '';
        qs('#login-page').style.display = 'none';
        qs('#splash-screen')?.remove();
        qsa('.page').forEach(el => el.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active');
        currentPage = 'shopify-orders';
        api = async () => [];
        const names = ['فاطمة حسن', 'مريم نبيل', 'أحمد سامي', 'منى عبد الرحمن', 'ريم خالد', 'عمر طارق'];
        _shopifyOrders = Array.from({ length: 8 }, (_, i) => ({
          _id: `review-order-${i + 1}`, ref: String(2971 - i), shopifyId: String(50000 + i),
          client: names[i % names.length], phone: '01000000000', status: i === 6 ? 'confirmed' : 'pending',
          createdAt: new Date(Date.now() - i * 3600000).toISOString(),
          shopifyCreatedAt: new Date(Date.now() - i * 3600000).toISOString(),
          items: [{ productId: 'review-product', name: 'سلة قطنية يدوية', code: 'SK-101', qty: i % 2 + 1, price: 850 }],
          total: 900 + i * 175, itemsTotal: 850 + i * 175, shipCost: 50,
          discount: 0, manualDiscount: 0, codesDiscount: 0, tags: i % 3 === 0 ? 'متابعة' : '',
          notes: i % 3 === 0 ? 'العميل يفضل الاستلام مساءً' : '',
          depositReceipts: [], assignedToName: i % 2 ? 'سارة' : '', comments: [],
          shippingAddress: 'القاهرة، مصر', shippingCity: 'القاهرة'
        }));
        _shopifyTab = 'pending';
        _shopifyStatusFilter = '';
        _shopifyDateFilter = {};
        _spOrdersLoaded = true;
        renderShopifyOrders();
      });
      await new Promise(resolve => setTimeout(resolve, 450));
      await page.screenshot({ path: path.join(__dirname, `orders-${width}.png`) });
      if (width === 1920 || width === 1440 || width === 800) {
        await page.evaluate(() => { currentUser.role = 'admin'; renderShopifyOrders(); });
        const selectionState = await page.evaluate(() => {
          const table = qs('#shopify-orders-table-body table');
          const tableScroll = table.closest('.sp-table-scroll');
          const checks = [...qsa('#shopify-orders-table-body .sp-row-check')];
          const firstRow = checks[0].closest('tr');
          const tableTop = table.getBoundingClientRect().top;
          const searchTop = qs('#shopify-search-wrap').getBoundingClientRect().top;
          checks[0].click();
          const bar = qs('#sp-bulk-bar');
          checks[1].click();
          const selected = qsa('#shopify-orders-table-body tr.sp-row-selected').length;
          const slot = qs('#sp-bulk-bar-slot');
          const slotRect = slot.getBoundingClientRect();
          const searchRect = qs('#shopify-search-wrap').getBoundingClientRect();
          const closeRect = bar.querySelector('.sp-bulk-close').getBoundingClientRect();
          return {
            barStable: bar === qs('#sp-bulk-bar'),
            tableStable: table === qs('#shopify-orders-table-body table'),
            tableFits: tableScroll.scrollWidth <= tableScroll.clientWidth + 1,
            tableOverflowPx: tableScroll.scrollWidth - tableScroll.clientWidth,
            rowStable: firstRow === checks[0].closest('tr'),
            tableTopStable: Math.abs(table.getBoundingClientRect().top - tableTop) < 1,
            searchTopStable: Math.abs(qs('#shopify-search-wrap').getBoundingClientRect().top - searchTop) < 1,
            inline: slot.parentNode === qs('#shopify-filters-top-row') && Math.abs(slotRect.top - searchRect.top) < 1 && slotRect.left >= 0 && slotRect.right <= innerWidth,
            closeVisible: closeRect.left >= slotRect.left && closeRect.right <= slotRect.right,
            noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
            selected,
            partial: qs('#sp-select-all').indeterminate,
            totalRendered: !!bar?.querySelector('.sp-bulk-total .amt-num'),
            barText: bar?.textContent.trim()
          };
        });
        if (!selectionState.barStable || !selectionState.tableStable || (width >= 1920 && !selectionState.tableFits) || !selectionState.rowStable || !selectionState.tableTopStable || !selectionState.searchTopStable || !selectionState.inline || !selectionState.closeVisible || !selectionState.noPageOverflow || selectionState.selected !== 2 || !selectionState.partial || !selectionState.totalRendered) {
          throw new Error(`Selection UI remounted or failed to sync: ${JSON.stringify(selectionState)}`);
        }
        await page.screenshot({ path: path.join(__dirname, `selection-${width}.png`) });
        if (width === 1440) {
          await page.evaluate(() => document.body.classList.add('dark-mode'));
          await page.screenshot({ path: path.join(__dirname, 'selection-dark-1440.png') });
          await page.evaluate(() => document.body.classList.remove('dark-mode'));
        }
        const selectionTransitions = await page.evaluate(() => {
          const bar = qs('#sp-bulk-bar');
          qs('#sp-select-all').click();
          const allSelected = [...qsa('#shopify-orders-table-body .sp-row-check')].every(check => check.checked);
          const barStable = bar === qs('#sp-bulk-bar');
          _clearShopifySelection();
          return { allSelected, barStable, cleared: !qs('#sp-bulk-bar') && !qs('#sp-select-all').checked && !_shopifySelectedIds.size };
        });
        if (!selectionTransitions.allSelected || !selectionTransitions.barStable || !selectionTransitions.cleared) {
          throw new Error(`Select-all or clear failed: ${JSON.stringify(selectionTransitions)}`);
        }
        await page.evaluate(() => { currentUser.role = 'staff'; renderShopifyOrders(); });
        console.log('selection-stability', JSON.stringify(selectionState));
      }
      if (width === 1440 || width === 390) {
        await page.evaluate(() => _toggleShopifyDatePopover());
        await page.screenshot({ path: path.join(__dirname, `date-filter-${width}.png`) });
        await page.evaluate(() => _closeShopifyDatePopover());
      }
      await page.evaluate(() => openSpOrderPeek('review-order-1'));
      await page.waitForSelector('#sp-peek.is-open');
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.screenshot({ path: path.join(__dirname, `detail-${width}.png`) });
      if (width === 1440) {
        const decisionView = await page.evaluate(() => {
          const order = _shopifyOrders[0];
          order.depositDecision = { reasonCode: 'first-order-trust' };
          order.depositDecisionHistory = [{ action: 'objection-recorded', after: order.depositDecision }];
          _spPeekRender();
          const card = qs('#sp-peek .sp-pk-decision-card');
          return { actions: [...card.querySelectorAll('button')].map(button => button.textContent.trim()), height: Math.round(card.getBoundingClientRect().height) };
        });
        await page.screenshot({ path: path.join(__dirname, 'detail-history-1440.png') });
        console.log('deposit-decision-preview', JSON.stringify(decisionView));
        await page.evaluate(() => {
          delete _shopifyOrders[0].depositDecision;
          delete _shopifyOrders[0].depositDecisionHistory;
          _spPeekRender();
        });
      }
      await page.evaluate(() => editShopifyOrder('review-order-1'));
      await page.waitForSelector('#shopify-edit-modal [role="dialog"]');
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.screenshot({ path: path.join(__dirname, `edit-${width}.png`) });
      await page.evaluate(async () => {
        _spEditRemoveModal();
        closeSpOrderPeek();
        await new Promise(resolve => setTimeout(resolve, 380));
        await openFuModal();
        qs('#fu-order-search').value = '2971';
        qs('#fu-modal-order-label').textContent = '2971';
        qs('#fu-modal-client-name').textContent = 'فاطمة حسن';
        qs('#fu-modal-client-row').style.display = 'block';
      });
      await new Promise(resolve => setTimeout(resolve, 250));
      await page.screenshot({ path: path.join(__dirname, `followup-${width}.png`) });
      await page.evaluate(() => {
        closeFuModal();
        followUps = [{ _id: 'review-followup', orderRef: '2971', clientName: 'فاطمة حسن', reason: 'عملية تأكيد الطلب', comments: [] }];
        openFuCommentPopup('review-followup');
      });
      await new Promise(resolve => setTimeout(resolve, 350));
      await page.screenshot({ path: path.join(__dirname, `trail-${width}.png`) });
      if (width === 1440 || width === 390) {
        const actions = await page.evaluate(() => {
          closeFuCommentPopup();
          currentLang = 'en';
          document.documentElement.lang = 'en';
          document.documentElement.dir = 'ltr';
          currentUser.role = 'admin';
          const order = _shopifyOrders[0];
          order.ref = '3021';
          order.client = 'Shorok Herbid';
          order.notes = 'confirmed\ncancelled';
          order.total = 1485;
          order.itemsTotal = 1365;
          order.shipCost = 120;
          order.items = [
            { productId: 'review-product', name: 'Glam Organizer Maroon', code: '50M', qty: 1, price: 740 },
            { productId: 'review-product-2', name: 'Coco Black Basket', code: '03', qty: 1, price: 625 }
          ];
          _shopifyOrders = [order];
          followUps = [];
          _spFuFetchedAt = Date.now();
          renderShopifyOrders();
          openSpOrderPeek(order._id);
          return [...qs('#sp-peek').querySelectorAll('button,a.sp-ct-btn')]
            .filter(el => el.getClientRects().length)
            .map(el => ({ text: el.textContent.trim().slice(0, 35), className: el.className, width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }));
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        await page.screenshot({ path: path.join(__dirname, `order-window-${width}.png`) });
        console.log(`order-window-actions-${width}`, JSON.stringify(actions));
        if (width === 390) await page.evaluate(async () => {
          closeSpOrderPeek();
          await new Promise(resolve => setTimeout(resolve, 240));
        });
      }
      if (width === 390) {
        await page.evaluate(() => { closeFuCommentPopup(); document.body.classList.add('dark-mode'); });
        await page.screenshot({ path: path.join(__dirname, 'orders-dark-390.png') });
        await page.evaluate(() => openSpOrderPeek('review-order-1'));
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.screenshot({ path: path.join(__dirname, 'detail-dark-390.png') });
        await page.evaluate(async () => {
          closeSpOrderPeek();
          await new Promise(resolve => setTimeout(resolve, 380));
          document.body.classList.remove('dark-mode');
          _spOrdersLoaded = false;
          _shopifyOrders = [];
          api = async () => { throw new Error('offline'); };
          await loadShopifyOrders();
        });
        await page.screenshot({ path: path.join(__dirname, 'error-390.png') });
      }
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        listMode: qs('#sp-orders-tab-content')?.dataset.layout,
        listDisplay: getComputedStyle(qs('#sp-mobile-list')).display,
        listColumns: getComputedStyle(qs('#sp-mobile-list')).gridTemplateColumns,
        pageTitle: getComputedStyle(qs('#shopify-page-header h2')).fontSize,
        followupWidth: Math.round(qs('#fu-comment-popup .fu-thread-modal').getBoundingClientRect().width),
        firstCard: [...(qs('#sp-mobile-list .sp-card')?.children || [])].map(el => ({ className: el.className, height: Math.round(el.getBoundingClientRect().height), marginTop: getComputedStyle(el).marginTop }))
      }));
      console.log(width, JSON.stringify({ ...layout, errors }));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
