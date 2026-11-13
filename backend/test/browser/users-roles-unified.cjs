// Roles are the only place access is granted (Nov 13, 2026). The user window shows the
// account's role and lets you pick another; it never sends a permission list.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const role = (slug, name, baseRole, perms, users = [], extra = {}) => ({ slug, name, description: name + ' role', system: true, locked: false, baseRole, perms, users, ...extra });
const roles = [
  role('super-admin', 'Super Admin', 'admin', ['dashboard'], [{ id: '1', username: 'admin', name: 'Owner', isActive: true }], { locked: true }),
  role('admin', 'Admin', 'admin', ['dashboard'], [{ id: '5', username: 'fares', name: 'Fares', isActive: true }], { locked: true }),
  role('sales', 'Sales', 'staff', ['dashboard', 'movements', 'shopify-orders', 'clients'], [{ id: '2', username: 'sara', name: 'Sara', isActive: true }]),
  role('accountant', 'Accountant', 'staff', ['dashboard', 'vault', 'expenses', 'reports']),
  role('viewer', 'Viewer', 'viewer', ['dashboard']),
];
const accounts = [
  { _id: '1', username: 'admin', name: 'Owner', role: 'admin', perms: [], roleId: null, isActive: true },
  { _id: '5', username: 'fares', name: 'Fares', role: 'admin', perms: [], roleId: null, isActive: true },
  { _id: '2', username: 'sara', name: 'Sara', role: 'staff', perms: roles[2].perms, roleId: 'sales', isActive: true, jobTitle: 'Sales Representative' },
  { _id: '3', username: 'hassan', name: 'Hassan', role: 'staff', perms: ['dashboard', 'inventory', 'products'], roleId: null, isActive: true },
];
const unassigned = [{ id: '3', username: 'hassan', name: 'Hassan', tier: 'staff', permCount: 3, isActive: true }];

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const results = [];
  const check = (name, ok) => { results.push([name, !!ok]); if (!ok) console.log('FAIL', name); };
  try {
    for (const variant of [{ lang: 'ar', width: 1440 }, { lang: 'en', width: 390, dark: true }]) {
      const page = await browser.newPage();
      const errors = []; const writes = [];
      page.on('pageerror', e => errors.push(e.stack || e.message));
      await page.setViewport({ width: variant.width, height: 900 });
      await page.evaluateOnNewDocument((lang) => {
        localStorage.setItem('token', 'unified-test');
        localStorage.setItem('user', JSON.stringify({ id: '5', _id: '5', username: 'fares', name: 'Fares', role: 'admin', perms: [] }));
        localStorage.setItem('soulia_lang_pref', lang);
      }, variant.lang);
      await page.setRequestInterception(true);
      page.on('request', req => {
        const url = new URL(req.url()); const p = url.pathname; const m = req.method();
        if (!p.startsWith('/api/')) return req.continue();
        const json = (body, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (p === '/api/roles' && m === 'GET') return json({ roles, unassigned, canManage: true });
        if (p === '/api/roles/migrate-legacy') {
          const body = JSON.parse(req.postData() || '{}'); writes.push({ p, m, body });
          return json({ dryRun: body.dryRun !== false, moved: body.dryRun === false ? 1 : 0, createdRoles: [{ slug: 'custom-hassan', name: 'Hassan (custom)', baseRole: 'staff', perms: [] }],
            users: [{ id: '3', username: 'hassan', name: 'Hassan', action: 'create', role: { slug: 'custom-hassan', name: 'Hassan (custom)' }, before: ['dashboard', 'inventory', 'products'], after: ['dashboard', 'inventory', 'products', 'products-edit'], added: ['products-edit'], dropped: [] }] });
        }
        if (p.startsWith('/api/roles/')) { writes.push({ p, m, body: JSON.parse(req.postData() || '{}') }); return json({ assigned: true }); }
        if (p === '/api/users' && m === 'GET') return json(accounts);
        if (p === '/api/users' && m === 'POST') { writes.push({ p, m, body: JSON.parse(req.postData()) }); return json({ _id: '9' }); }
        if (p.startsWith('/api/users/') && m === 'PUT') { writes.push({ p, m, body: JSON.parse(req.postData()) }); return json(accounts[3]); }
        if (p === '/api/auth/me') return json({ id: '5', _id: '5', username: 'fares', name: 'Fares', role: 'admin', perms: [], isActive: true });
        if (p.startsWith('/api/security-audit/')) return json([]);
        return json(p === '/api/transactions/startup-overview' ? { rows: [], activeCount: 0 } : {});
      });
      await page.goto(origin + '/#users', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => typeof openUserModal === 'function' && window.SouliaRBAC && Array.isArray(users) && users.length === 4, { timeout: 30000 });
      if (variant.dark) await page.evaluate(() => document.body.classList.add('dark-mode'));
      await page.evaluate(() => window.SouliaRBAC.ensure().then(() => renderUsers()));
      const tag = `[${variant.lang} ${variant.width}]`;

      // Users table: the role column names the ROLE; legacy says so.
      const roleCells = await page.evaluate(() => [...document.querySelectorAll('#users-tbody td[data-col="u-role"], #users-grid .users-mcard-meta .user-role-badge')].map(el => el.textContent.trim()));
      if (process.env.SHOT_DIR) await page.screenshot({ path: require('path').join(process.env.SHOT_DIR, `users-${variant.lang}-${variant.width}.png`) });
      check(`${tag} table names roles`, roleCells.some(t => /Sales|مبيعات/.test(t)));
      check(`${tag} legacy account reads «no role»`, roleCells.some(t => /No role|بدون دور/.test(t)));
      check(`${tag} role filter lists roles`, await page.$$eval('#users-role-filter option', o => o.map(x => x.value).includes('accountant')));
      await page.evaluate(() => { const s = document.querySelector('#users-role-filter'); s.value = 'sales'; renderUsers(); });
      check(`${tag} filter by role`, await page.evaluate(() => document.querySelectorAll('#users-tbody tr').length === 1 && /Sara/.test(document.querySelector('#users-tbody').textContent)));
      await page.evaluate(() => { const s = document.querySelector('#users-role-filter'); s.value = ''; renderUsers(); });

      // Legacy account: note, role list, summary, no per-user checkboxes.
      await page.evaluate(() => { openUserModal('3'); _umTab('role'); });
      await page.waitForSelector('input[name="um-role"]');
      check(`${tag} no per-user permission checkboxes`, (await page.$$('.perm-cb')).length === 0);
      check(`${tag} legacy note`, await page.$eval('#um-role-body', el => /3/.test(el.querySelector('.um3-note')?.textContent || '')));
      check(`${tag} roles offered (owner excluded)`, (await page.$$('input[name="um-role"]')).length === 4);
      await page.click('input[name="um-role"][value="sales"]').catch(() => page.evaluate(() => { const i = document.querySelector('input[name="um-role"][value="sales"]'); i.checked = true; _umPickRole('sales'); }));
      check(`${tag} summary shows the role's groups`, await page.$eval('#um-role-sum', el => el.querySelectorAll('.um3-mod').length >= 2 && /4/.test(el.textContent)));
      if (process.env.SHOT_DIR) { await page.evaluate(() => document.querySelector('.um3-mod')?.setAttribute('open','')); await page.screenshot({ path: require('path').join(process.env.SHOT_DIR, `um-${variant.lang}-${variant.width}.png`) }); }
      check(`${tag} footer names the role`, await page.$eval('#um-foot-role', el => /Sales|مبيعات/.test(el.textContent)));
      const noOverflow = await page.evaluate(() => { const m = document.querySelector('.um2'); return m && m.scrollWidth <= m.clientWidth + 1; });
      check(`${tag} window has no sideways overflow`, noOverflow);
      await page.evaluate(() => saveUser('3'));
      await page.waitForFunction(() => !document.querySelector('#modal-overlay.active'), { timeout: 5000 }).catch(() => {});
      const put = writes.find(w => w.p === '/api/users/3');
      check(`${tag} profile save carries no permissions`, put && !('perms' in put.body) && !('role' in put.body));
      check(`${tag} new role assigned through the role`, writes.some(w => w.p === '/api/roles/sales/assign' && w.body.userId === '3'));

      // Own account: cannot change own role.
      await page.evaluate(() => { openUserModal('5'); _umTab('role'); });
      await page.waitForSelector('input[name="um-role"]');
      check(`${tag} own role is locked`, await page.$$eval('input[name="um-role"]', l => l.every(i => i.disabled)));
      writes.length = 0;
      await page.evaluate(() => saveUser('5'));
      await new Promise(r => setTimeout(r, 300));
      check(`${tag} own save never assigns`, !writes.some(w => w.p.includes('/assign')));

      // New account: a role is required, and is sent as roleId.
      await page.evaluate(() => { openUserModal(); });
      await page.waitForSelector('input[name="um-role"]');
      await page.evaluate(() => { document.querySelector('#um-username').value = 'nour'; document.querySelector('#um-name').value = 'Nour'; document.querySelector('#um-password').value = 'secret12'; });
      writes.length = 0;
      await page.evaluate(() => saveUser(''));
      check(`${tag} no role → not sent, role tab shown`, !writes.length && await page.$eval('[data-um-panel="role"]', el => !el.hidden));
      // Job title suggests a role.
      await page.evaluate(() => { _umTab('account'); const s = document.querySelector('#um-jobtitle-select'); s.value = 'Accountant'; _umOnJobTitleChange(s); });
      check(`${tag} job title suggests the role`, await page.$eval('#um-job-tpl-hint', el => !el.hidden && /Accountant|محاسب/.test(el.textContent)));
      await page.evaluate(() => document.querySelector('#um-job-tpl-hint .perm-tpl-btn').click());
      check(`${tag} suggestion picks the role`, await page.$eval('input[name="um-role"][value="accountant"]', i => i.checked));
      await page.evaluate(() => saveUser(''));
      await new Promise(r => setTimeout(r, 300));
      const post = writes.find(w => w.p === '/api/users' && w.m === 'POST');
      check(`${tag} create sends roleId, no perms`, post && post.body.roleId === 'accountant' && !('perms' in post.body));

      // Roles page: legacy notice → dry run → move.
      await page.evaluate(() => navigateTo('roles'));
      await page.waitForSelector('#rbac-migrate', { timeout: 10000 });
      await page.click('#rbac-migrate');
      await page.waitForSelector('#rbac-migrate-go');
      check(`${tag} migration preview lists the account and the added key`, await page.$eval('#rbac-dialog', el => /Hassan/.test(el.textContent) && /\+1/.test(el.textContent)));
      check(`${tag} preview is a dry run`, writes.some(w => w.p === '/api/roles/migrate-legacy' && w.body.dryRun === true) && !writes.some(w => w.p === '/api/roles/migrate-legacy' && w.body.dryRun === false));
      if (process.env.SHOT_DIR) await page.screenshot({ path: require('path').join(process.env.SHOT_DIR, `migrate-${variant.lang}-${variant.width}.png`) });
      await page.click('#rbac-migrate-go');
      await page.waitForFunction(() => !document.querySelector('#rbac-dialog').open, { timeout: 5000 });
      check(`${tag} move applies`, writes.some(w => w.p === '/api/roles/migrate-legacy' && w.body.dryRun === false));
      check(`${tag} no page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check(`${tag} no page errors`, errors.length === 0);
      if (errors.length) console.log(errors.join('\n'));
      await page.close();
    }
  } finally { await browser.close(); }
  const failed = results.filter(r => !r[1]);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
