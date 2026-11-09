// Populated notification DOM audit. Blocks every API write and shipping sync.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const { createHash } = require('node:crypto');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  let browser;
  try {
    const admin = await mongoose.connection.db.collection('users').findOne(
      { role: process.env.TEST_ROLE || 'admin', isActive: { $ne: false } },
      { projection: { _id: 1, username: 1, name: 1, role: 1 } });
    if (!admin) throw new Error('No active account for requested role');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((t, user) => {
      localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(user));
    }, token, { _id: String(admin._id), username: admin.username, name: admin.name, role: admin.role });
    const blockedWrites = [], errors = [], requests = [];
    await page.setRequestInterception(true);
    page.on('request', request => {
      const route = new URL(request.url()).pathname;
      if (route.startsWith('/api/')) requests.push(route);
      if (route.startsWith('/api/') && request.method() !== 'GET') {
        blockedWrites.push(`${request.method()} ${route}`);
        return request.respond({ status: 405, contentType: 'application/json', body: '{}' });
      }
      if (route.startsWith('/api/shipping/sync/')) return request.respond({ status: 200,
        contentType: 'application/json', body: '{}' });
      request.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto((process.env.TEST_ORIGIN || 'http://127.0.0.1:8081') + '/#dashboard',
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.souliaPushAppReady && _dashFuLoaded && followUps.length > 0,
      { timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 400));
    const snapshot = () => page.evaluate(() => {
      const panel = document.querySelector('#notif-panel'), center = document.querySelector('#nc-overlay');
      return {
        documentNodes: document.getElementsByTagName('*').length,
        panelNodes: panel?.getElementsByTagName('*').length || 0,
        panelListNodes: document.querySelector('#notif-list')?.getElementsByTagName('*').length || 0,
        centerNodes: center?.getElementsByTagName('*').length || 0,
        centerCards: document.querySelectorAll('#nc-main [data-notification-id]').length,
        panelCards: document.querySelectorAll('#notif-list [data-notification-id]').length,
        allNotifications: typeof _ncAllNotifs !== 'undefined' ? _ncAllNotifs.length : 0,
        badge: document.querySelector('#notif-badge')?.textContent || '',
        largestPages: [...document.querySelectorAll('#main > .page')]
          .map(node => ({ id: node.id, nodes: node.getElementsByTagName('*').length,
            active: node.classList.contains('active') }))
          .sort((a, b) => b.nodes - a.nodes).slice(0, 6),
      };
    });
    const closed = await snapshot();
    await page.evaluate(() => openNotifCenter());
    await page.waitForFunction(() => document.querySelector('#nc-overlay')?.classList.contains('active') &&
      document.querySelectorAll('#nc-main [data-notification-id]').length > 0, { timeout: 15000 });
    const open = await snapshot();
    const ids = await page.evaluate(() => _ncAllNotifs.map(row => row.id));
    let expanded = null;
    if (process.env.PHASE10_EXPAND_ALL === '1') {
      while (await page.$('.nc-load-more')) await page.click('.nc-load-more');
      const renderedIds = await page.evaluate(() => [...document.querySelectorAll('#nc-main [data-notification-id]')]
        .map(node => node.dataset.notificationId));
      expanded = { ...(await snapshot()), allIdsRendered: renderedIds.length === ids.length &&
        new Set(renderedIds).size === ids.length && renderedIds.every(id => ids.includes(id)) };
    }
    await page.evaluate(() => closeNotifCenter({ navigation: true }));
    const closedAgain = await snapshot();
    let userPage = null;
    if (process.env.PHASE10_USERS === '1') {
      const requestOffset = requests.length;
      await page.evaluate(() => navigateTo('users'));
      await page.waitForFunction(() => currentPage === 'users' &&
        document.querySelectorAll('#users-tbody tr').length > 0, { timeout: 15000 });
      await new Promise(resolve => setTimeout(resolve, 200));
      userPage = { rows: await page.evaluate(() => document.querySelectorAll('#users-tbody tr').length),
        requests: requests.slice(requestOffset) };
    }
    const result = { closed, open, expanded, closedAgain, userPage,
      notificationCount: ids.length, notificationIdHash: createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
      blockedWrites, errors };
    const output = process.env.PHASE10_OUTPUT || 'phase10-notification-before.json';
    fs.writeFileSync('../artifacts/' + output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { if (browser) await browser.close(); await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
