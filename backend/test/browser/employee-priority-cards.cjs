const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/employee-priority-cards');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url()), file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://priority.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) &&
        /\.(html|css|woff2?|svg|png|webp)$/.test(file)) return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : /\.woff2?$/.test(file) ? 'font/woff2' : 'image/png', body: fs.readFileSync(file) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto('http://priority.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      Date.now = () => Date.parse('2026-10-27T18:10:00Z');
      currentUser = { _id: 'staff', name: 'Malak Abbas', role: 'staff', perms: ['dashboard', 'complaints', 'shopify-orders'] };
      users = [currentUser]; currentLang = 'ar'; currentPage = 'dashboard';
      document.documentElement.dir = 'rtl'; qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      qsa('.page').forEach(el => el.classList.toggle('active', el.id === 'page-dashboard'));
      const refs = ['2960', '2937', '2944', '2929', '2949', '2932'];
      const names = ['ناهد أحمد عبدالفتاح', 'ابتسام صالح', 'Radwa Nasr Ahmed Hamza', 'Dina Sayed', 'Amel Refat', 'هناء صابر'];
      const notes = ['رنيت ومردتش، هتابعها واتساب.', 'تم التواصل وهتحول ديبوزيت الشحن بس.', 'تم التواصل هاتفيًا وفي انتظار رد العميلة.', 'إعادة التواصل لتأكيد الطلب — موعد المتابعة: 2026-10-26T17:41:42.067Z — اتصال: لا يوجد رد', '@Fares يرجى مراجعة تفاصيل الطلب والتواصل مع العميلة لتأكيد العنوان.', 'Please call the customer to confirm the delivery address.'];
      _myWorkspace = { assignedOrdersTotal: 37, assignedOrdersInPeriod: 12, periodLabel: 'أكتوبر 2026', openFollowUpsCount: 6,
        points: { total: 89 }, adjustments: [], followUps: refs.map((ref, i) => ({ id: 'f' + i, ticketNo: 'FU-' + i, orderRef: ref,
          clientName: names[i], clientPhone: '01000002307', status: 'في انتظار العميل', reason: 'عملية تأكيد الطلب',
          deferredUntil: i === 3 ? '2026-10-26T17:41:42.067Z' : '2026-10-27T17:01:00Z', lastActivityAt: '2026-10-27T16:00:00Z',
          latestComment: { id: 'c' + i, text: notes[i], authorId: 'staff', authorName: 'Malak Abbas', at: '2026-10-27T16:00:00Z' } })) };
      _myWorkspaceRecipientId = 'staff'; _myShowOtherTasks = true; _myShowAllPriorities = true;
      onPageEnter = () => {}; renderDashWelcome(false); renderMyKpis(); buildSidebar(); initMobileNav();
      window.openedOrder = null; window.openedComment = null;
      openMyHomeFollowUp = index => { window.openedOrder = myFollowUpPriorities()[index].f.orderRef; };
      openMyFollowUpTrail = (id, comment) => { window.openedComment = { id, comment }; };
    });
    for (const [lang, width, dark] of [['ar', 1440, false], ['ar', 1024, false], ['ar', 390, false], ['ar', 320, false], ['en', 390, false], ['ar', 390, true]]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(({ lang, dark }) => { currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.body.classList.toggle('dark-mode', dark); renderMyKpis(); }, { lang, dark });
      await page.evaluate(() => document.fonts.ready);
      await new Promise(resolve => setTimeout(resolve, 350));
      const result = await page.evaluate(() => [...document.querySelectorAll('.employee-priority-card')].map(card => {
        const ref = card.querySelector('.employee-priority-ref'), range = document.createRange(); range.selectNodeContents(ref);
        const footer = card.querySelector('.employee-priority-footer').getBoundingClientRect();
        const comment = card.querySelector('.employee-priority-comment').getBoundingClientRect();
        const heading = card.querySelector('.employee-priority-heading').getBoundingClientRect();
        const appointment = card.querySelector('.employee-priority-schedule').getBoundingClientRect();
        return { ref: ref.textContent, refLines: range.getClientRects().length, overflow: card.scrollWidth > card.clientWidth + 1,
          footerBelow: footer.top >= comment.bottom, separateStatus: appointment.top > heading.bottom, iso: /\d{4}-\d{2}-\d{2}T\d{2}:/.test(card.innerText),
          inlineContacts: [...card.querySelectorAll('a[href^="tel:"],a[href*="vrobo"]')].some(a => a.getClientRects().length > 0) };
      }));
      assert.equal(result.length, 6);
      assert(result.every(card => card.refLines === 1 && !card.overflow && card.footerBelow && card.separateStatus && !card.iso && !card.inlineContacts), `${lang}/${width}: ${JSON.stringify(result)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.$eval('.employee-followup-preview', el => el.scrollIntoView({ block: 'start' }));
      const captureStyle = await page.addStyleTag({ content: '#header,#mobile-bottom-nav{visibility:hidden!important}' });
      await new Promise(resolve => setTimeout(resolve, 350));
      await (await page.$('.employee-followup-preview')).screenshot({ path: path.join(output, `${lang}-${width}${dark ? '-dark' : ''}.png`) });
      await captureStyle.evaluate(element => element.remove());
    }
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.remove('dark-mode'); renderMyKpis(); });
    await page.click('.employee-priority-more-button');
    await page.waitForSelector('.employee-priority-menu.show');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await page.$$eval('.employee-priority-menu a', links => links.length), 2);
    assert((await page.$eval('.employee-priority-menu a', link => link.href)).startsWith('tel:+20'));
    assert.equal(await page.$eval('.employee-priority-menu a[target="_blank"]', link => link.rel), 'noopener');
    await page.screenshot({ path: path.join(output, 'more-menu-mobile.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.employee-priority-more-button')), true);
    await page.click('.employee-priority-view');
    assert.equal(await page.evaluate(() => openedOrder), '2929');
    await page.click('.employee-priority-comment');
    assert.deepEqual(await page.evaluate(() => openedComment), { id: 'f3', comment: 'c3' });
    await page.evaluate(() => { _myShowAllPriorities = false; renderMyKpis(); });
    assert.equal(await page.$$eval('.employee-priority-card', cards => cards.length), 3);
    await page.click('.employee-stack-more');
    await page.waitForFunction(() => !_myPriorityCardsAnimating);
    assert.equal(await page.$$eval('.employee-priority-card', cards => cards.length), 6);
    await page.addScriptTag({ content: fs.readFileSync(path.join(publicDir, 'employee-followup-session.js'), 'utf8') });
    await page.$$eval('.employee-priority-record', buttons => buttons[1].click());
    assert.match(await page.$eval('.employee-session-order', el => el.textContent), /#2960/);
    await page.evaluate(() => closeModal());
    await page.evaluate(() => {
      _myWorkspace.adjustments = [{ points: -10, reason: 'سبب الخصم التجريبي', createdAt: '2026-10-26T10:00:00Z' }];
      _rfzLastAt = Date.now() - 180000;
      renderMyKpis();
    });
    assert.equal(await page.$$eval('.employee-point-message', nodes => nodes.length), 0);
    await page.click('.employee-points-history');
    assert.match(await page.$eval('#modal-content', el => el.textContent), /سبب الخصم التجريبي/);
    await page.evaluate(() => closeModal());
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(() => { window.scrollTo(0, 0); qs('#main')?.scrollTo(0, 0); });
      await page.$eval('#page-dashboard', el => el.scrollIntoView({ block: 'start' }));
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(output, `dashboard-${width}.png`) });
    }
    await page.evaluate(() => {
      _myWorkspace.followUps.push({ id: 'shipping', orderRef: '3001', autoSource: 'shipping-issue', deferredUntil: '2026-10-26T16:00:00Z', clientName: 'عميل التوصيل' });
      renderMyKpis();
    });
    await page.click('#employee-delivery-issues-tab');
    assert.deepEqual(await page.$$eval('.employee-priority-ref', refs => refs.map(ref => ref.textContent)), ['#3001']);
    await page.click('#employee-other-tasks-tab');
    assert.equal(await page.$$eval('.employee-priority-ref', refs => refs.some(ref => ref.textContent === '#3001')), false);
    assert.deepEqual(errors, []);
    console.log('Verified card layout at desktop/mobile widths, Arabic/English, dark mode, unbroken references, formatted dates, hidden contacts, menu keyboard controls, order/comment navigation and expansion.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
