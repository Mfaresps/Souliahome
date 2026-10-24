/* Shipped mobile navigation and notification permissions; all requests intercepted.
 * Run: node backend/test/browser/navigation-permissions.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new vm.Script(match[1]);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') {
        return request.respond({ status: 200, contentType: 'text/html', body: html });
      }
      if (url.pathname === '/push-navigation.js') {
        return request.respond({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(publicDir, 'push-navigation.js'), 'utf8') });
      }
      if (request.resourceType() === 'script') {
        return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      }
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      currentLang = 'en';
      window.messages = []; window.entries = []; window.requests = [];
      toast = (message, error) => messages.push({ message, error });
      onPageEnter = page => entries.push(page);
      api = async url => { requests.push(url); return []; };
      transactions = [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', ref: '123', type: 'مبيعات', items: [] }];
      const denied = [];
      for (const role of ['staff', 'viewer']) {
        currentUser = { _id: 'test-user', role, perms: ['shopify-orders'] };
        txDirty = false;
        navigateTo('shopify-orders');
        buildSidebar(); initMobileNav();
        const baseline = location.href;
        const before = entries.length;
        const hidden = ['mnav-movements', 'mnav-inventory', 'mnav-fab'].every(id => qs('#' + id).hidden);
        // Force the hidden mobile button's handler as well as all invoice paths.
        qs('#mnav-movements').click();
        navigateTo('movements');
        _doNavigateTo('invoice-view', false);
        openOrderView('aaaaaaaaaaaaaaaaaaaaaaaa');
        showInvoiceDetail('aaaaaaaaaaaaaaaaaaaaaaaa');
        showRestrictedPurchaseDetail(transactions[0]);
        goToTxAndHighlight('aaaaaaaaaaaaaaaaaaaaaaaa');
        onNotifClick('movements', 'delivered-test', null, 'tx', 'aaaaaaaaaaaaaaaaaaaaaaaa');
        // Direct invoice permalink follows the popstate branch used by back/forward.
        history.replaceState(null, '', '#transactions/orders/view/sales-123');
        window.dispatchEvent(new PopStateEvent('popstate'));
        const afterLink = currentPage;
        history.replaceState(null, '', baseline);
        qs('#inv-view-content').innerHTML = 'stale invoice';
        renderInvoiceViewPage();
        const cleared = qs('#inv-view-content').innerHTML === '';
        window.souliaPushAppReady = true;
        const requestCount = requests.length;
        const pushResult = await window.souliaNavigateNotification('/?pushRecord=tx:aaaaaaaaaaaaaaaaaaaaaaaa&pushType=delivered');
        denied.push({ role, hidden, page: currentPage, afterLink, unchangedUrl: location.href === baseline,
          entries: entries.length - before, cleared, pushResult, pushRequests: requests.length - requestCount,
          invoiceModal: qs('#inv-detail-overlay').classList.contains('active') });
      }
      currentUser = { _id: 'allowed', role: 'staff', perms: ['movements', 'inventory'] };
      navigateTo('movements');
      const allowed = currentPage === 'movements' && !qs('#mnav-movements').hidden && !qs('#mnav-inventory').hidden;
      openOrderView('aaaaaaaaaaaaaaaaaaaaaaaa');
      const allowedInvoice = currentPage === 'invoice-view' && location.hash.includes('sales-123');
      currentUser = { role: 'staff', perms: ['complaints', 'categories'] };
      const aliases = _canAccessPage('followups') && _canAccessPage('collection-profile');
      currentUser = { role: 'admin', perms: [] };
      navigateTo('movements');
      const admin = currentPage === 'movements' && !qs('#mnav-movements').hidden;
      currentUser = null;
      const loggedOut = !_canAccessPage('movements');
      return { denied, allowed, allowedInvoice, aliases, admin, loggedOut, errors: messages.filter(m => m.error).length };
    });
    for (const row of result.denied) {
      assert.equal(row.hidden, true, row.role + ' mobile buttons hidden');
      assert.equal(row.page, 'shopify-orders');
      assert.equal(row.afterLink, 'shopify-orders');
      assert.equal(row.unchangedUrl, true);
      assert.equal(row.entries, 0, 'Denied routes never enter or load a page');
      assert.equal(row.cleared, true);
      assert.equal(row.invoiceModal, false);
      assert.equal(row.pushResult, false);
      assert.equal(row.pushRequests, 0, 'Denied delivery push never fetches invoice data');
    }
    for (const key of ['allowed', 'allowedInvoice', 'aliases', 'admin', 'loggedOut']) assert.equal(result[key], true, key);
    assert.ok(result.errors > 0, 'Denied access gives feedback');
    console.log('PASS: staff/viewer mobile bypasses, invoice notifications, direct links, delivery push, stale content, permitted staff and admin navigation.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
