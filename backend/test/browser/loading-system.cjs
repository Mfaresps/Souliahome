const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof renderCspCards === 'function' && !!window.getComputedStyle);

    await page.evaluate(() => {
      const skeleton = document.createElement('span');
      skeleton.className = 'ss-skeleton';
      skeleton.style.cssText = 'display:block;width:120px;height:16px';
      document.body.append(skeleton);
      const button = document.createElement('button');
      button.id = 'loading-test-button';
      button.textContent = 'Save changes';
      button.setAttribute('aria-busy', 'true');
      document.body.append(button);
    });
    await page.waitForSelector('#loading-test-button.ss-action-busy .ss-action-loader');
    const busyButtonSize = await page.$eval('#loading-test-button', button => ({ width: button.offsetWidth, height: button.offsetHeight }));
    assert.equal(await page.$eval('.ss-skeleton', el => getComputedStyle(el, '::after').animationName), 'data-sheen');
    await page.$eval('#loading-test-button', button => button.setAttribute('aria-busy', 'false'));
    await page.waitForFunction(() => !document.querySelector('#loading-test-button .ss-action-loader'));
    const idleButtonSize = await page.$eval('#loading-test-button', button => ({ width: button.offsetWidth, height: button.offsetHeight }));
    assert.deepEqual(busyButtonSize, idleButtonSize, 'button feedback keeps the button geometry');

    const firstBatch = await page.evaluate(() => {
      currentUser = { _id: 'loading-test', role: 'admin', perms: [] };
      cspFolders = [{ _id: 'folder', name: 'Folder', icon: 'box' }];
      cspActiveFolderId = 'folder';
      cspCards = Array.from({ length: 65 }, (_, i) => ({
        _id: String(i), folderId: 'folder', title: `Card ${i}`, response: `Response ${i}`,
        cardType: 'response', tags: [], isActive: true,
      }));
      renderCspCards();
      return document.querySelectorAll('#csp-card-grid .csp-card').length;
    });
    assert.equal(firstBatch, 24, 'large card lists render a small first batch');
    await page.waitForFunction(() => document.querySelectorAll('#csp-card-grid .csp-card').length === 65);
    await page.evaluate(() => { cspCards = cspCards.slice(0, 5); renderCspCards(); });
    await page.waitForFunction(() => document.querySelectorAll('#csp-card-grid .csp-card').length === 5);

    const retained = await page.evaluate(async () => {
      api = async () => { throw new Error('Fixture unavailable'); };
      reportsUnlocked = true;
      currentReportData = { fixture: true };
      qs('#rep-stats').innerHTML = '<div id="retained-report">Previous report</div>';
      await loadReports();
      vaultLog = [{ _id: 'old' }];
      qs('#vault-table tbody').innerHTML = '<tr id="retained-vault"><td>Previous entry</td></tr>';
      await loadVaultLog();
      await loadCspPage();
      return {
        report: !!qs('#retained-report'),
        reportRetry: !!qs('#rep-stats .empty-v2-action-retry'),
        vault: !!qs('#retained-vault'),
        vaultRetry: !!qs('#vault-table + .ss-refresh-error .empty-v2-action-retry'),
        cards: qs('#csp-card-grid .csp-card')?.dataset.cardId,
        cspRetry: !!qs('#csp-card-grid .empty-v2-action-retry'),
      };
    });
    assert.deepEqual(retained, {
      report: true, reportRetry: true, vault: true, vaultRetry: true,
      cards: '0', cspRetry: true,
    });

    const draftsRetry = await page.evaluate(async () => {
      _draftsCache = null;
      await openDraftsDrawer();
      return !!qs('#drafts-drawer-list .empty-v2-action-retry');
    });
    assert.equal(draftsRetry, true, 'failed first draft load offers retry');

    const staffStates = await page.evaluate(() => {
      currentUser = { _id: 'staff', role: 'staff', perms: ['dashboard'] };
      _myRoster = null; _myRosterFailed = false;
      _myWorkspace = null; _myWsFailed = false;
      renderMyShift(); renderMyFollowUps();
      const loading = !!qs('#dash-shift-body .ss-skeleton') && !!qs('#dash-myfu-section .ss-skeleton');
      _myRosterFailed = true; _myWsFailed = true;
      renderMyShift(); renderMyFollowUps();
      return { loading, retry: !!qs('#dash-shift-body .empty-v2-action-retry') };
    });
    assert.deepEqual(staffStates, { loading: true, retry: true });

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.equal(await page.$eval('.ss-skeleton', el => getComputedStyle(el, '::after').animationName), 'none');
    assert.deepEqual(errors, []);
    console.log('PASS loading system: subtle shimmer, local action status, progressive cards, retained refresh data, retry, reduced motion.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
