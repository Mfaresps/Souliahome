// Real populated API, read-only browser verification. All non-GET API calls are blocked.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  let browser;
  try {
    const admin = await mongoose.connection.db.collection('users').findOne(
      { role: 'admin', isActive: { $ne: false } },
      { projection: { _id: 1, username: 1, name: 1, role: 1 } });
    if (!admin) throw new Error('No active admin account');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    const followupInitiators = [];
    cdp.on('Network.requestWillBeSent', event => {
      if (event.request.url.includes('/api/followups'))
        followupInitiators.push({ at: event.timestamp, stack: event.initiator?.stack?.callFrames?.slice(0, 5)
          .map(frame => `${frame.functionName}:${frame.lineNumber + 1}`) || [] });
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);
    await page.evaluateOnNewDocument(({ token, user, briefing }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      if (briefing) localStorage.setItem('soulia_adb_autoshow_enabled', '1');
      window.__phase7 = { longTasks: [], interactive: 0, lcp: 0 };
      new PerformanceObserver(list => list.getEntries().forEach(entry =>
        window.__phase7.longTasks.push({ start: entry.startTime, duration: entry.duration })))
        .observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(list => list.getEntries().forEach(entry => {
        window.__phase7.lcp = entry.startTime;
      })).observe({ type: 'largest-contentful-paint', buffered: true });
      const tick = () => {
        if (!window.__phase7.interactive && window.souliaPushAppReady === true &&
            document.querySelector('#app')?.style.display === 'block' &&
            !document.querySelector('#splash-screen')) window.__phase7.interactive = performance.now();
        if (!window.__phase7.interactive) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { token, user: { _id: String(admin._id), username: admin.username,
      name: admin.name, role: admin.role }, briefing: process.env.TEST_BRIEFING === '1' });
    const api = [], assets = [], errors = [], blockedWrites = [];
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/') && request.method() !== 'GET') {
        blockedWrites.push(`${request.method()} ${url.pathname}`);
        return request.respond({ status: 405, contentType: 'application/json', body: '{}' });
      }
      // This GET performs a carrier sync on the server; keep the audit read-only.
      if (url.pathname.startsWith('/api/shipping/sync/'))
        return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
      if (process.env.BASELINE_ENDPOINTS === '1' &&
          ['/api/followups/dashboard-summary', '/api/transactions/dashboard-overview'].includes(url.pathname)) {
        const oldPath = url.pathname === '/api/followups/dashboard-summary'
          ? '/api/followups' : '/api/transactions/startup-overview';
        api.push({ path: oldPath, at: performance.now() });
        return request.continue({ url: url.origin + oldPath + url.search });
      }
      if (url.pathname.startsWith('/api/')) api.push({ path: url.pathname + url.search, at: performance.now() });
      request.continue();
    });
    page.on('response', async response => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/') && response.request().resourceType() !== 'script') return;
      try {
        const bytes = (await response.buffer()).length;
        const alias = process.env.BASELINE_ENDPOINTS === '1'
          ? { '/api/followups/dashboard-summary': '/api/followups',
            '/api/transactions/dashboard-overview': '/api/transactions/startup-overview' }[url.pathname]
          : null;
        (url.pathname.startsWith('/api/') ? api : assets).filter(row =>
          row.path === url.pathname + url.search || row.path === url.pathname || row.path === alias)
          .slice(-1).forEach(row => {
            row.bytes = bytes;
            row.status = response.status();
            if (row.at) row.ms = Math.round(performance.now() - row.at);
          });
        if (!url.pathname.startsWith('/api/')) assets.push({ path: url.pathname, bytes, status: response.status() });
      } catch (_) {}
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
    const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8081';
    await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.souliaPushAppReady && currentPage === 'dashboard', { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 900));
    await page.waitForFunction(() => _dashFuLoaded && followUps.length > 0, { timeout: 20000 });
    const startupCount = api.length;
    const startup = await page.evaluate(() => ({
      dcl: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0,
      lcp: window.__phase7.lcp,
      interactive: window.__phase7.interactive,
      tbt: window.__phase7.longTasks.filter(task => task.start >=
        (performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0) &&
        task.start < window.__phase7.interactive)
        .reduce((total, task) => total + Math.max(0, task.duration - 50), 0),
      domNodes: document.getElementsByTagName('*').length,
      coreLoaded: !!performance.getEntriesByType('resource').find(e => e.name.includes('/app-core.js')),
      vaultLoaded: Array.isArray(vaultLog) && vaultLog.length > 0,
    }));
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]));
    startup.scriptMs = Math.round((metrics.ScriptDuration || 0) * 1000);
    startup.taskMs = Math.round((metrics.TaskDuration || 0) * 1000);
    startup.longTaskOver50Ms = Math.round((await page.evaluate(() => window.__phase7.longTasks
      .reduce((total, task) => total + Math.max(0, task.duration - 50), 0))));
    const dashboardSnapshot = await page.evaluate(() => ({
      shippingKpis: [...document.querySelectorAll('#dash-ship-kpis .ds-skpi-n')].map(el => el.textContent.trim()),
      notificationRows: _collectNotificationUpdates().map(row => [row.id, row.title, row.desc, row.page]),
      followupCount: followUps.length,
      unseenFollowups: _fuUnseenCount(),
      transactionsCount: transactions.length,
      activeTransactionCount: _transactionActiveCount,
      followupBadgeCount: document.querySelectorAll('.ds-fu-badge').length,
    }));
    const notificationHash = createHash('sha256').update(JSON.stringify(dashboardSnapshot.notificationRows)).digest('hex');
    const dashboard = { ...dashboardSnapshot, notificationRows: undefined, notificationHash,
      notificationCount: dashboardSnapshot.notificationRows.length };
    if (process.env.TEST_REOPEN === '1') {
      await page.evaluate(() => {
        localStorage.setItem('soulia_adb_autoshow_enabled', '1');
        reopenAdminBriefing();
      });
      await page.waitForFunction(() => vaultLog.length > 0 &&
        document.querySelector('#adb-overlay')?.classList.contains('active'), { timeout: 15000 });
      console.log(JSON.stringify({ mode: 'read-only-post-boot-briefing', startupCount,
        vaultRequestsOnReopen: api.slice(startupCount).filter(row => row.path === '/api/vault').length,
        errors, blockedWrites }, null, 2));
      return;
    }
    if (process.env.TEST_TRAIL === '1') {
      const trailId = await page.evaluate(() => String(followUps[0]?._id || ''));
      if (!trailId) throw new Error('No populated follow-up available for detail verification');
      await page.evaluate(id => openMyFollowUpTrail(id), trailId);
      await page.waitForFunction(id => document.querySelector('#fu-comment-popup')?.classList.contains('show') &&
        String(fuCommentTargetId) === id, { timeout: 15000 }, trailId);
      const detail = await page.evaluate(id => {
        const row = followUps.find(f => String(f._id) === id);
        return { loaded: !!row, commentsLoaded: Array.isArray(row?.comments), commentCount: row?.comments?.length || 0 };
      }, trailId);
      console.log(JSON.stringify({ mode: 'read-only-dashboard-follow-up-detail', detail,
        requests: api.slice(startupCount), errors, blockedWrites }, null, 2));
      return;
    }
    const from = performance.now();
    await page.evaluate(() => navigateTo('followups'));
    await page.waitForFunction(() => currentPage === 'followups' && followUps.length > 0
      && document.querySelectorAll('#fu-tbody tr').length > 0, { timeout: 20000 });
    const followups = { ms: Math.round(performance.now() - from),
      rows: await page.evaluate(() => document.querySelectorAll('#fu-tbody tr').length),
      records: await page.evaluate(() => followUps.length),
      hasFullComments: await page.evaluate(() => followUps.some(row => Array.isArray(row.comments) && row.comments.length > 0)),
      api: api.slice(startupCount).map(row => row.path) };
    const invoiceFrom = performance.now();
    const linked = await page.evaluate(() => {
      const row = followUps.find(f => transactions.some(t => t._id === f.transactionId || t.ref === f.orderRef));
      const tx = row && transactions.find(t => t._id === row.transactionId || t.ref === row.orderRef);
      if (tx) openOrderView(tx._id);
      return !!tx;
    });
    if (linked) {
      await page.waitForFunction(() => currentPage === 'invoice-view'
        && document.querySelector('#inv-view-content')?.children.length > 0, { timeout: 20000 });
      await page.waitForFunction(() => transactions.find(t => t._id === window._invoiceViewTxId)?._fullyHydrated,
        { timeout: 20000 });
    }
    const invoice = { linked, ms: Math.round(performance.now() - invoiceFrom),
      hydrated: await page.evaluate(() => transactions.find(t => t._id === window._invoiceViewTxId)?._fullyHydrated || false) };
    console.log(JSON.stringify({ mode: 'read-only-live-browser', startup, dashboard, startupCount,
      startupApiBytes: api.slice(0, startupCount).reduce((sum, row) => sum + (row.bytes || 0), 0),
      startupApi: api.slice(0, startupCount), followups, invoice,
      loadedScripts: assets.map(row => row.path), followupInitiators, errors, blockedWrites }, null, 2));
  } finally { if (browser) await browser.close(); await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
