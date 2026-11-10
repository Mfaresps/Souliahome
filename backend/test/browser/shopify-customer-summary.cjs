const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { buildClientProfiles } = require('../../dist/clients/client-profile.util');
const out = path.resolve(__dirname, '../../../artifacts/clients-profile');
fs.mkdirSync(out, { recursive: true });
const user = { _id: 'summary-test', name: 'Review', role: 'admin', perms: [] };
const order = { _id: 'summary-order', shopifyId: 'summary-site', ref: '3077', client: 'مروي عبد الحليم',
  phone: '01000812575', status: 'pending', total: 770, notes: 'confirmed', shippingGov: 'الجيزة', shippingCity: 'فيصل',
  shippingAddress: 'شارع فهمي متفرع من حسن الصبان، الطالبية فيصل',
  shopifyCreatedAt: '2026-11-07', editRequest: { status: 'معتمد' }, items: [{ code: '32', name: 'Ribbon Storage', qty: 1, price: 447, total: 447 }], depositReceipts: [{ id: 'summary-receipt', amount: 323, method: 'Instapay',
    status: 'معتمد', vaultEntryId: 'entry-1', vaultTxNo: 'SAL-1221', noImage: true, noImageAuth: 'otp',
    noImageReason: 'Cash in store', submittedBy: 'Review', submittedAt: '2026-11-07T09:08:00Z',
    senderName: 'Customer', senderHandle: 'customer@instapay', transferReference: '955386166910' }], comments: [] };
const profile = buildClientProfiles([], [order])[0];
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [], measurements = [];
    let releaseHistory, holdHistory = true, summaryProfile = profile, summaryReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument(user => {
      localStorage.setItem('token', 'summary-fixture'); localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('soulia_lang_pref', 'en');
      localStorage.setItem('soulia-push-prompt:' + user._id, 'dismissed');
    }, user);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      let body = [];
      if (url.pathname === '/api/auth/me') body = user;
      if (url.pathname === '/api/settings') body = {};
      if (url.pathname.endsWith('/deposit-decision-options')) body = { reasons: [{ code: 'prefers-cod', ar: 'يفضل الدفع عند الاستلام', en: 'Prefers COD' }], exceptions: [] };
      if (url.pathname === '/api/notifications' || url.pathname === '/api/notifications/preferences') body = { preferences: { enabled: false }, language: 'en', subscriptions: [] };
      if (url.pathname === '/api/clients') body = [profile];
      if (url.pathname === '/api/clients/profile') body = profile;
      if (url.pathname === '/api/clients/order-profile') {
        summaryReads++;
        const responseProfile = summaryProfile;
        if (holdHistory) {
          holdHistory = false;
          releaseHistory = () => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(responseProfile) });
          return;
        }
        body = responseProfile;
      }
      if (url.pathname === '/api/shopify/orders/detail/' + order._id) body = order;
      if (url.pathname === '/api/transactions/startup-overview') body = { rows: [], activeCount: 0 };
      if (url.pathname === '/api/shopify/orders/summary-page') body = { rows: [], page: 1, limit: 30, total: 0, allCount: 0,
        pendingCount: 0, tabCount: 0, filterCounts: {}, baseCount: 0, starredCount: 0, filteredIds: [], selectionRows: [],
        depositSummary: {}, panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} } };
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:8080/#shopify-orders', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#splash-screen') && typeof openSpOrderPeek === 'function');
    await page.evaluate(async order => {
      _shopifyOrders = [order]; await openSpOrderPeek(order._id); await document.fonts.ready;
    }, order);
    await page.waitForSelector('#sp-peek.is-open .cp-order-evidence');
    await new Promise(resolve => setTimeout(resolve, 400));
    const before = await page.$eval('#sp-peek .sp-peek', el => el.getBoundingClientRect().height);
    assert.equal(typeof releaseHistory, 'function');
    await releaseHistory();
    await page.waitForFunction(() => document.querySelector('#sp-peek .cp-badge')?.textContent === '1ST order');
    const after = await page.$eval('#sp-peek .sp-peek', el => el.getBoundingClientRect().height);
    assert.ok(Math.abs(after - before) < 2, `async history changed height: ${before} -> ${after}`);
    assert.equal(await page.$('#sp-peek .sp-pk-body .cp-order-evidence'), null);
    assert.equal(await page.$('#sp-peek .sp-pk-header-note'), null, 'confirmation markers are not customer notes');
    assert.equal(await page.$eval('#sp-peek', el => el.textContent.includes('The available history is insufficient')), false);
    await page.evaluate(() => { for (let i = 0; i < 8; i++) { _apiWriteRevision++; _spPeekRender(); } });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(summaryReads, 1, 'unrelated writes and redraws reuse customer history');
    assert.equal(await page.$eval('#sp-peek .cp-order-evidence', el => /Checking|Limited|سجل محدود/.test(el.textContent)), false);
    for (const lang of ['en', 'ar']) for (const width of [320, 390, 768, 1440]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(lang => {
        currentLang = lang; document.documentElement.dir = document.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelector('#sp-peek').dir = document.dir; _spPeekRender();
      }, lang);
      await new Promise(resolve => setTimeout(resolve, 350));
      const result = await page.evaluate(() => {
        const panel = document.querySelector('#sp-peek .sp-peek'), name = panel.querySelector('.sp-pk-client'),
          badge = panel.querySelector('.cp-badge'), summary = panel.querySelector('.cp-order-evidence small');
        const rect = panel.getBoundingClientRect(), nameRect = name.getBoundingClientRect(), badgeRect = badge.getBoundingClientRect();
        const phoneRect = panel.querySelector('.sp-pk-phone-row').getBoundingClientRect();
        const regionRect = panel.querySelector('.sp-pk-region').getBoundingClientRect(), addressRect = panel.querySelector('.sp-pk-address-detail').getBoundingClientRect();
        return { width: innerWidth, height: rect.height, overflow: panel.scrollWidth > panel.clientWidth + 1,
          nameWidth: nameRect.width, sameRow: Math.abs(nameRect.top - badgeRect.top) < 6,
          phoneBesideName: Math.abs(phoneRect.top - nameRect.top) < 8,
          regionFirst: regionRect.bottom <= addressRect.top + 1,
          region: panel.querySelector('.sp-pk-region').textContent,
          actions: Math.round(panel.querySelector('.sp-pk-actions>summary').getBoundingClientRect().width),
          contactVisible: panel.querySelector('.sp-ct-btn').checkVisibility(),
          summary: summary?.textContent || '', firstOrder: badge.textContent, inBounds: rect.left >= 0 && rect.right <= innerWidth + 1 };
      });
      assert.equal(result.overflow, false, `${lang}/${width}: drawer overflow`);
      assert.equal(result.inBounds, true); assert.equal(result.sameRow, true);
      assert.equal(result.regionFirst, true); assert.equal(result.region, 'الجيزة · فيصل');
      if (width >= 768) assert.equal(result.phoneBesideName, true, 'desktop phone sits next to the name');
      assert.ok(result.nameWidth > 60); assert.equal(result.actions, 28); assert.equal(result.contactVisible, false);
      assert.equal(result.summary, '', 'a first order has no delivery KPIs');
      assert.equal(result.firstOrder, lang === 'ar' ? 'الطلب 1' : '1ST order');
      measurements.push({ lang, ...result });
      await page.click('#sp-peek .sp-pk-actions>summary');
      assert.equal(await page.$eval('#sp-peek .sp-pk-actions', el => el.open), true);
      assert.equal(await page.$eval('#sp-peek .sp-pk-action-menu', el => el.checkVisibility()), true);
      const menu = await page.$eval('#sp-peek .sp-pk-action-menu', el => ({
        left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right,
        links: [...el.querySelectorAll('a')].map(a => a.getAttribute('href')), print: !!el.querySelector('.sp-pk-print-action'),
        label: el.textContent, height: el.closest('.sp-peek').getBoundingClientRect().height,
      }));
      assert.ok(menu.left >= 0 && menu.right <= width + 1, `${lang}/${width}: action menu in bounds`);
      assert.equal(menu.links.length, 3); assert.equal(menu.print, true);
      assert.match(menu.links[0], /^https:\/\/wa.me\//); assert.match(menu.links[2], /^tel:/);
      assert.ok(Math.abs(menu.height - result.height) < 2, 'opening actions must not resize the drawer');
      await page.screenshot({ path: path.join(out, `order-summary-${lang}-${width}.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#sp-peek .sp-pk-actions', el => el.open), false);
      assert.equal(await page.$eval('#sp-peek', el => el.classList.contains('is-open')), true);
      assert.equal(await page.$eval('#sp-peek .sp-pk-actions>summary', el => el === document.activeElement), true);
    }
    assert.equal(summaryReads, 1, 'resizing, language changes and menus do not reload history');
    await page.evaluate(() => {
      currentLang = 'en'; document.documentElement.dir = 'ltr'; document.querySelector('#sp-peek').dir = 'ltr'; _spPeekRender();
      const handlers = {};
      SouliaClients.bindSocket({ on(name, handler) { handlers[name] = handler; return this; } });
      window.__historyChanged = () => handlers['tx:created']();
    });
    const prior = (id, extra = {}) => ({ _id: id, type: 'مبيعات', client: order.client, phone: order.phone,
      ref: id, date: '2026-10-01', pickupStatus: 'Delivered', total: 500, ...extra });
    const refreshSummary = async (previous, title) => {
      summaryProfile = buildClientProfiles(previous, [order])[0]; holdHistory = true; releaseHistory = null;
      const old = await page.$eval('#sp-peek .cp-order-evidence', el => el.textContent), reads = summaryReads;
      await page.evaluate(() => { __historyChanged(); for (let i = 0; i < 8; i++) _spPeekRender(); });
      const until = Date.now() + 5000;
      while (!releaseHistory && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(typeof releaseHistory, 'function', 'live history refresh starts');
      assert.equal(await page.$eval('#sp-peek .cp-order-evidence', el => el.textContent), old, 'previous summary stays visible during refresh');
      assert.equal(summaryReads, reads + 1, 'a refresh burst makes one request');
      await releaseHistory();
      await page.waitForFunction(title => document.querySelector('#sp-peek .cp-badge')?.textContent === title, {}, title);
      return page.$eval('#sp-peek .cp-order-evidence small', el => el.textContent);
    };
    const delivered1 = prior('3001'), delivered2 = prior('3002', { date: '2026-10-02' });
    const second = await refreshSummary([delivered1], '2ND order');
    assert.equal(second, '1 order delivered before · 100% success');
    const third = await refreshSummary([delivered1, delivered2], '3RD order');
    assert.equal(third, '2 orders delivered before · 100% success');
    for (const lang of ['en', 'ar']) for (const width of [320, 390, 768, 1440]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(lang => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelector('#sp-peek').dir = document.documentElement.dir; _spPeekRender();
      }, lang);
      await new Promise(resolve => setTimeout(resolve, 300));
      const deliveryLayout = await page.evaluate(() => {
        const block = document.querySelector('#sp-peek .sp-pk-cust-top'), summary = block.querySelector('.cp-order-summary');
        const address = block.querySelector('.sp-pk-address'), contact = block.querySelector('.sp-pk-cust-id');
        const a = address.getBoundingClientRect(), c = contact.getBoundingClientRect(), style = getComputedStyle(address);
        return { overflow: block.scrollWidth > block.clientWidth + 1, icon: !!summary.querySelector('.cp-summary-check'),
          colour: getComputedStyle(summary.querySelector('.cp-summary-delivered')).color,
          rate: summary.querySelector('.cp-summary-positive')?.textContent,
          overlap: Math.min(c.right, a.right) - Math.max(c.left, a.left) > 1 && Math.min(c.bottom, a.bottom) - Math.max(c.top, a.top) > 1,
          beside: a.left >= c.right || a.right <= c.left,
          topDifference: Math.abs(a.top - c.top), below: a.top >= c.bottom - 1,
          background: style.backgroundColor, border: style.borderTopWidth };
      });
      assert.equal(deliveryLayout.overflow, false, `${lang}/${width}: customer details do not overflow`);
      assert.equal(deliveryLayout.overlap, false, `${lang}/${width}: evidence does not overlap the address`);
      assert.equal(deliveryLayout.background, 'rgba(0, 0, 0, 0)'); assert.equal(deliveryLayout.border, '0px');
      if (width >= 900) { assert.equal(deliveryLayout.beside, true); assert.ok(deliveryLayout.topDifference <= 4); }
      else assert.equal(deliveryLayout.below, true);
      assert.equal(deliveryLayout.icon, true); assert.equal(deliveryLayout.colour, 'rgb(40, 115, 77)');
      assert.match(deliveryLayout.rate, /100%/);
      await page.screenshot({ path: path.join(out, `third-order-success-${lang}-${width}.png`) });
    }
    const addressCases = [
      { region: 'Cairo', address: '102، العنوان بالتفصيل الأوتوستراد - المعادي، الدور (10)، شقة (106)', direction: 'rtl' },
      { region: 'القاهرة', address: '102 Autostrad Road, Maadi, Floor (10), Apt (106)', direction: 'ltr' },
      { region: 'Cairo', address: 'فيلا 38، Villa 38، كمبوند الوادي، التجمع الأول', direction: 'rtl' },
    ];
    for (const lang of ['en', 'ar']) for (const width of [320, 1440]) for (const sample of addressCases) {
      await page.setViewport({ width, height: 1000 });
      const actual = await page.evaluate(({ lang, sample }) => {
        currentLang = lang; document.documentElement.dir = document.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelector('#sp-peek').dir = document.dir;
        Object.assign(_spOrderById('summary-order'), { shippingGov: sample.region, shippingCity: '', shippingAddress: sample.address });
        _spPeekRender();
        const region = document.querySelector('#sp-peek .sp-pk-region'), detail = document.querySelector('#sp-peek .sp-pk-address-detail');
        const textRect = el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect(); };
        const cityText = textRect(region), addressText = textRect(detail), edge = lang === 'ar' ? 'right' : 'left';
        return { regionDirection: getComputedStyle(region).direction, addressDirection: getComputedStyle(detail).direction,
          alignment: getComputedStyle(detail).textAlign, text: detail.textContent,
          alignmentDifference: Math.abs(cityText[edge] - addressText[edge]),
          overflow: detail.scrollWidth > detail.clientWidth + 1 };
      }, { lang, sample });
      assert.equal(actual.regionDirection, sample.region === 'Cairo' ? 'ltr' : 'rtl');
      assert.equal(actual.addressDirection, sample.direction, `${lang}/${width}: address follows its text language`);
      assert.equal(actual.alignment, lang === 'ar' ? 'right' : 'left');
      assert.ok(actual.alignmentDifference < 2, `${lang}/${width}: city and address share the same text edge`);
      assert.equal(actual.text, sample.address); assert.equal(actual.overflow, false);
      if (width === 1440 && sample === addressCases[0])
        await page.screenshot({ path: path.join(out, `address-direction-${lang}-${width}.png`) });
    }
    await page.evaluate(order => {
      Object.assign(_spOrderById('summary-order'), { shippingGov: order.shippingGov, shippingCity: order.shippingCity, shippingAddress: order.shippingAddress });
      currentLang = 'en'; document.documentElement.dir = document.dir = 'ltr'; document.querySelector('#sp-peek').dir = 'ltr'; _spPeekRender();
    }, order);
    const fifth = await refreshSummary([delivered1, delivered2,
      prior('3003', { date: '2026-10-03', pickupStatus: 'Pending', bostaStatus: 'RETURNED' }),
      prior('3004', { date: '2026-10-04', pickupStatus: 'Pending', cancelled: true }),
      prior('ignored', { date: '2026-10-05', cancelled: true, cancelReasonCode: 'duplicate-order' })], '5TH order');
    assert.match(fifth, /2 orders delivered before · 1 failed · 1 cancelled · 67% success/);
    assert.equal(await page.$('#sp-peek .cp-summary-positive'), null, 'lower delivery success is not given the positive colour');
    assert.equal(/\b0 (failed|cancelled|delivered)/.test(fifth), false);
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.querySelector('#sp-peek').dir = 'rtl'; _spPeekRender(); });
    assert.equal(await page.$('#sp-peek .sp-pk-head .sp-edit-status'), null);
    assert.equal(await page.$eval('#sp-peek .sp-pk-items-section>summary b', el => el.nextElementSibling.classList.contains('sp-edit-status')), true);
    await page.evaluate(() => { openShopifyEditReview = id => { window.__reviewedOrder = id; }; });
    await page.click('#sp-peek .sp-pk-items-section .sp-edit-status');
    assert.equal(await page.evaluate(() => window.__reviewedOrder), order._id);
    assert.equal(await page.$eval('#sp-peek .sp-pk-items-section', el => el.open), true, 'edit action does not collapse Items');
    for (const [status, expected] of [['معلق', 'Edit request'], ['قيد التنفيذ', 'Edit request'], ['مرفوض', 'Rejected'], ['معتمد', 'Edited']]) {
      await page.evaluate(status => {
        currentLang = 'en'; document.querySelector('#sp-peek').dir = 'ltr';
        _spOrderById(_spPeekId).editRequest.status = status; _spPeekRender();
      }, status);
      assert.equal(await page.$('#sp-peek .sp-pk-head .sp-edit-status'), null);
      assert.equal(await page.$eval('#sp-peek .sp-pk-items-section>summary .sp-edit-status', el => el.textContent.trim()), expected);
      assert.equal(await page.$eval('#sp-peek .sp-pk-items-section>summary .sp-edit-status svg', el => el.getAttribute('viewBox')), '0 0 24 24');
    }
    await page.evaluate(() => {
      const order = _spOrderById(_spPeekId); window.__priorReceiptFixture = structuredClone(order.depositReceipts);
      order.depositReceipts = [
        { id: 'previous-hour', status: 'معتمد', amount: 323, method: 'Instapay', submittedAt: new Date(Date.now() - 3600000).toISOString() },
        { id: 'previous-minute', status: 'معلق', amount: 100, method: 'Vodafone Cash', submittedAt: new Date(Date.now() - 60000).toISOString() },
        { id: 'excluded-draft', status: 'مسودة', amount: 900, submittedById: 'someone-else' },
        { id: 'excluded-refund', status: 'مُسترد', amount: 800 },
        { id: 'excluded-withdrawn', status: 'مسحوب', amount: 700 },
        { id: 'excluded-rejected', status: 'مرفوض', amount: 600 },
      ];
    });
    for (const lang of ['ar', 'en']) for (const width of [320, 390, 1440]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(async lang => { currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; await openSpReceiptForm(_spPeekId); }, lang);
      await page.waitForSelector('#sp-receipt-form .spdep-previous');
      const previous = await page.$eval('#sp-receipt-form', el => ({ title: el.querySelector('h3').textContent,
        rows: el.querySelectorAll('.spdep-previous li').length,
        amounts: [...el.querySelectorAll('.spdep-previous-amount')].map(e => e.textContent),
        times: [...el.querySelectorAll('.spdep-previous time')].map(e => e.textContent),
        pending: el.querySelectorAll('.spdep-previous-pending').length,
        icons: el.querySelectorAll('.spdep-previous-vault :is(svg,img)').length,
        overflow: el.scrollWidth > el.clientWidth + 1 }));
      assert.match(previous.title, lang === 'ar' ? /إضافة عربون آخر/ : /Add another deposit/);
      assert.equal(previous.rows, 2); assert.equal(previous.pending, 1); assert.ok(previous.icons >= 2);
      assert.ok(previous.amounts.some(v => /323/.test(v)) && previous.amounts.some(v => /100/.test(v)));
      assert.ok(previous.times.includes(lang === 'ar' ? 'منذ ساعة' : '1 hour ago'));
      assert.ok(previous.times.includes(lang === 'ar' ? 'منذ دقيقة' : '1 minute ago'));
      assert.equal(previous.overflow, false);
      await page.screenshot({ path: path.join(out, `previous-deposit-${lang}-${width}.png`) });
      await page.evaluate(() => _spCancelReceiptForm());
    }
    const firstDeposit = await page.evaluate(async () => {
      const order = _spOrderById(_spPeekId), previous = order.depositReceipts;
      const editableOthers = _spPreviousDeposits(order, 'previous-minute').map(r => r.id);
      order.depositReceipts = []; currentLang = 'en'; await openSpReceiptForm(order._id);
      const title = qs('#sp-receipt-form h3').textContent, hasHistory = !!qs('.spdep-previous');
      await _spCancelReceiptForm(); order.depositReceipts = __priorReceiptFixture;
      return { title, hasHistory, editableOthers };
    });
    assert.match(firstDeposit.title, /Add deposit/); assert.equal(firstDeposit.hasHistory, false);
    assert.deepEqual(firstDeposit.editableOthers, ['previous-hour']);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.click('#sp-peek .spdep-peek-details>summary');
    assert.equal(await page.$eval('#sp-peek .spdep-peek-details', el => el.open), true);
    await page.evaluate(() => { _spPeekRender(); _spPeekRender(); });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await page.$eval('#sp-peek .spdep-peek-details', el => el.open), true, 'receipt stays open across live redraws');
    assert.match(await page.$eval('#sp-peek .spdep-receipt-fields', el => el.textContent), /955386166910/);
    assert.match(await page.$eval('#sp-peek .spdep-receipt-fields', el => el.textContent), /SAL-1221/);
    await page.screenshot({ path: path.join(out, 'receipt-expanded-ar-1440.png') });
    await page.focus('#sp-peek .spdep-peek-details>summary'); await page.keyboard.press('Enter');
    assert.equal(await page.$eval('#sp-peek .spdep-peek-details', el => el.open), false);
    await page.evaluate(() => _spPeekRender());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await page.$eval('#sp-peek .spdep-peek-details', el => el.open), false, 'receipt stays closed across redraws');
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const touch = await page.evaluate(() => ({ coarse: matchMedia('(pointer:coarse)').matches,
      actions: Math.round(document.querySelector('#sp-peek .sp-pk-actions>summary').getBoundingClientRect().width) }));
    assert.equal(touch.coarse, true); assert.equal(touch.actions, 28);
    await cdp.detach();
    await page.click('#sp-peek .sp-pk-actions>summary');
    await page.click('#sp-peek .sp-pk-ref');
    assert.equal(await page.$eval('#sp-peek .sp-pk-actions', el => el.open), false, 'outside click closes actions');
    await page.evaluate(() => { printSpPeekPreview = id => { window.__printedOrder = id; }; });
    await page.focus('#sp-peek .sp-pk-actions>summary');
    await page.keyboard.press('Enter');
    await page.click('#sp-peek .sp-pk-print-action');
    assert.equal(await page.evaluate(() => window.__printedOrder), order._id);
    assert.equal(await page.$eval('#sp-peek .sp-pk-actions', el => el.open), false, 'print closes actions');
    await page.click('#sp-peek .sp-pk-client .cp-invoice-customer');
    await page.waitForSelector('.cp-profile');
    await page.waitForSelector('#sp-peek', { hidden: true });
    assert.equal(await page.evaluate(() => SouliaClients.currentProfile().key), profile.key);
    // Deposit objections are recorded only beside Call in the follow-up trail.
    await page.evaluate(order => {
      _shopifyOrders = [order];
      window.__followupPreviewOrder = order;
      followUps = [{ _id: 'trail-actions', orderRef: order.ref, clientName: order.client, clientPhone: order.phone,
        reason: 'تأكيد الطلب', status: 'جديد', comments: [
          { _id: 'note-1', authorId: 'staff-1', authorName: 'Malak Abbas', text: 'Please call the customer.', createdAt: '2026-11-07T09:08:00Z' },
          { _id: 'note-2', authorId: 'staff-2', authorName: 'Fares', text: 'تم التواصل مع العميل ومتابعة الطلب.', createdAt: '2026-11-07T09:10:00Z' },
          { _id: 'note-3', authorId: 'staff-1', authorName: 'Malak Abbas', text: 'Customer will confirm the address tomorrow.', createdAt: '2026-11-07T09:12:00Z' },
        ], createdAt: '2026-11-07T09:08:00Z' }];
    }, order);
    for (const lang of ['ar', 'en']) for (const width of [320, 390, 1440]) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(lang => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelector('.fu-thread-modal').dir = document.documentElement.dir;
        openFuCommentPopup('trail-actions');
      }, lang);
      await page.waitForSelector('#fu-comment-popup.show .fu-deposit-objection-btn');
      const actions = await page.evaluate(() => {
        const modal = document.querySelector('.fu-thread-modal'), row = document.querySelector('#fu-call-attempt-row'),
          call = row.querySelector('#fu-call-attempt-btn'), objection = row.querySelector('.fu-deposit-objection-btn');
        return { call: call.textContent.trim(), objection: objection.textContent.trim(), sameGroup: call.parentNode === objection.parentNode,
          icons: !!call.querySelector('svg') && !!objection.querySelector('svg'), overflow: modal.scrollWidth > modal.clientWidth + 1,
          bannerButton: !!document.querySelector('#fu-comment-reason-banner [onclick*="openDepositObjectionForRef"]'),
          outside: depositDecisionSummaryHtml(_shopifyOrders[0], true),
          history: depositDecisionSummaryHtml({ ..._shopifyOrders[0], depositDecision: { reasonCode: 'prefers-cod' } }, true) };
      });
      assert.equal(actions.call, lang === 'en' ? 'Call' : 'اتصال');
      assert.equal(actions.objection, lang === 'en' ? 'Objection' : 'اعتراض');
      assert.equal(actions.sameGroup, true); assert.equal(actions.icons, true); assert.equal(actions.overflow, false);
      assert.equal(actions.bannerButton, false); assert.equal(actions.outside, '');
      assert.equal(actions.history.includes('openDepositObjectionForRef'), false);
      await new Promise(resolve => setTimeout(resolve, 250));
      await page.screenshot({ path: path.join(out, `trail-actions-${lang}-${width}.png`) });
    }
    await page.click('#fu-call-attempt-btn');
    assert.equal(await page.$$('#fu-call-attempt-row [onclick*="logFuCallAttempt"]').then(rows => rows.length), 2);
    assert.ok(await page.$('#fu-call-attempt-row .fu-deposit-objection-btn'));
    await page.evaluate(() => { _fuAwaitingOutcome = false; _fuRenderCallAttemptRow(); });
    await page.$eval('#fu-comment-text', el => { el.value = 'Draft stays while recording objection'; });
    await page.click('#fu-comment-popup .fu-deposit-objection-btn');
    await page.waitForSelector('dialog[open] #dd-reason');
    assert.equal(await page.$('dialog[open] #dd-exception'), null, 'objection does not enable shipping without deposit');
    await page.click('dialog[open] .dd-close');
    assert.equal(await page.$eval('#fu-comment-text', el => el.value), 'Draft stays while recording objection');
    await page.setViewport({ width: 390, height: 900 });
    const design = await page.evaluate(async () => {
      const first = qs('#fu-comment-thread [data-comment-id="note-1"]');
      const card = first.querySelector('.fu-timeline-content'), style = getComputedStyle(card);
      const originalApi = api;
      api = async (url, options) => {
        if (url === '/followups/trail-actions/comments' && options.method === 'POST') {
          const f = followUps[0];
          return { ...f, comments: [...f.comments, { _id: 'new-note', authorId: currentUser._id, authorName: 'Review',
            text: JSON.parse(options.body).text, createdAt: new Date().toISOString() }] };
        }
        return originalApi(url, options);
      };
      qs('#fu-comment-text').value = 'New note appears softly.'; await saveFuComment();
      api = originalApi;
      const fresh = qs('#fu-comment-thread [data-comment-id="new-note"]');
      const result = { background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderRadius,
        retained: first === qs('#fu-comment-thread [data-comment-id="note-1"]'), animation: getComputedStyle(fresh).animationName };
      _fuRenderCommentThread();
      result.retainedNew = fresh === qs('#fu-comment-thread [data-comment-id="new-note"]');
      // A newer empty follow-up must not hide the employee conversation in an older one.
      followUps.push({ _id: 'new-empty', orderRef: followUps[0].orderRef, comments: [], createdAt: '2026-11-10T12:00:00Z' });
      _shopifyOrders = [__followupPreviewOrder];
      _shopifyDateFilter = { from: '', to: '' }; _shopifyTab = 'all'; shopifyPage = 1;
      qs('#sp-orders-tab-content').dataset.layout = 'cards'; // The fixture page is behind the profile, so it has no measurable width.
      _spServerEnabled = false; _spFuFetchedAt = Date.now(); renderShopifyOrders();
      const paid = document.querySelector('#sp-mobile-list .sp-card-deposit-paid .sp-card-fu-last');
      result.paidPreview = paid?.textContent.includes('New note appears softly.');
      return result;
    });
    assert.equal(design.background, 'rgb(246, 247, 248)'); assert.equal(design.border, '1px'); assert.equal(design.radius, '10px');
    assert.equal(design.retained, true); assert.equal(design.retainedNew, true); assert.equal(design.animation, 'fuNoteEnter');
    assert.equal(design.paidPreview, true, 'paid order cards retain the employee follow-up preview');
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.screenshot({ path: path.join(out, 'neutral-trail-notes-en-390.png') });
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) followUps[0].comments.push({ _id: 'old-' + i, authorName: 'Review', text: 'Earlier note ' + i, createdAt: '2026-11-08T10:00:00Z' });
      _fuRenderCommentThread(); qs('#fu-comment-thread').scrollTop = 0;
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    const keptScroll = await page.evaluate(() => {
      qs('#fu-comment-thread').scrollTop = 0;
      followUps[0].comments.push({ _id: 'live-note', authorName: 'Malak', text: 'Incoming update', createdAt: new Date().toISOString() });
      _fuRenderCommentThread(); return qs('#fu-comment-thread').scrollTop;
    });
    assert.ok(keptScroll < 2, 'incoming comments do not pull the reader to the bottom');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const reduced = await page.evaluate(() => {
      followUps[0].comments.push({ _id: 'reduced-note', authorName: 'Review', text: 'Reduced motion update', createdAt: new Date().toISOString() });
      _fuRenderCommentThread();
      return getComputedStyle(qs('#fu-comment-thread [data-comment-id="reduced-note"]')).animationName;
    });
    assert.equal(reduced, 'none');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    const outside = await page.evaluate(async () => {
      closeFuCommentPopup(); followUps = followUps.filter(f => f._id === 'trail-actions');
      _spFuFetchedAt = Date.now(); await openSpOrderPeek(__followupPreviewOrder._id);
      _spPeekFuRows = structuredClone(followUps);
      const originalApi = api; let release;
      api = (url, options) => url.startsWith('/followups/shopify-order?') ? new Promise(resolve => { release = resolve; }) : originalApi(url, options);
      const pending = _spPeekLoadFu(true);
      const f = { ...followUps[0], comments: [...followUps[0].comments,
        { _id: 'outside-new', authorName: 'Fares', text: 'Outside preview stays current', createdAt: new Date().toISOString() }] };
      followUps[0] = f; _spPeekSyncFollowUps(f);
      release([]); await pending; api = originalApi;
      const kept = qs('#sp-pk-fu').textContent.includes('Outside preview stays current');
      followUps[0] = { ...f, comments: f.comments.filter(c => c._id !== 'outside-new') }; _spPeekSyncFollowUps(followUps[0]);
      const removed = !qs('#sp-pk-fu').textContent.includes('Outside preview stays current');
      closeSpOrderPeek(); openFuCommentPopup('trail-actions');
      return { kept, removed };
    });
    assert.equal(outside.kept, true, 'a stale scoped response cannot hide a freshly saved staff comment');
    assert.equal(outside.removed, true, 'deletions also update the outside preview');
    await page.evaluate(() => {
      currentUser = { ...currentUser, role: 'staff', perms: ['followups', 'shopify-orders'] }; _fuRenderCallAttemptRow();
    });
    assert.equal(await page.$('#fu-call-attempt-row .fu-deposit-objection-btn'), null, 'permission still controls recording');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ ok: true, before, after, measurements, customerNameLink: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
