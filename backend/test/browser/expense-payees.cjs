// Saved expense parties (ads agency / employee / subscription) + period + auto title.
// Real app at 8080 (TEST_ORIGIN), API answered here. Screenshots: artifacts/expense-payees/.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/expense-payees');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('  ✓', msg); };

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const curMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevMonth = `${prevDate.getFullYear()}-${pad(prevDate.getMonth() + 1)}`;
const lastDayOf = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const arMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('ar-EG-u-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };

async function open(browser, { lang = 'ar', width = 1440, dark = false, role = 'admin', payees = [], expenses = [] } = {}) {
  const page = await browser.newPage();
  const errors = [], saves = [], payeeWrites = [], pointsAsked = [];
  const state = { payees: payees.map(p => ({ ...p })), expenses: expenses.map(e => ({ ...e })) };
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /expense-payees|xp|is not|undefined/i.test(m.text())) errors.push('console: ' + m.text()); });
  await page.setViewport({ width, height: 1000 });
  await page.evaluateOnNewDocument((lang, dark, role) => {
    localStorage.setItem('token', 'xp-test');
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Owner', role, perms: ['expenses'] }));
    localStorage.setItem('soulia_lang_pref', lang);
    localStorage.setItem('soulia-push-prompt:u1', 'dismissed'); // the push invitation would cover the form
    if (dark) localStorage.setItem('darkMode', 'true');
  }, lang, dark, role);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url()); const p = url.pathname; const m = request.method();
    if (!p.startsWith('/api/')) return request.continue();
    const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/api/expenses/payees' && m === 'GET') {
      return respond(state.payees.map(x => (x.kind === 'salary' && role !== 'admin') ? { ...x, amount: 0, amountHidden: true } : x));
    }
    if (p === '/api/expenses/payees' && m === 'POST') {
      const body = JSON.parse(request.postData() || '{}'); payeeWrites.push({ m, body });
      const row = { _id: 'p' + (state.payees.length + 1) + 'aaaaaaaaaaaaaaaaaaaaaa'.slice(0, 22), active: true, lastUsedAt: '', ...body };
      state.payees.push(row); return respond(row, 201);
    }
    if (p.startsWith('/api/expenses/payees/') && m === 'PUT') {
      const body = JSON.parse(request.postData() || '{}'); payeeWrites.push({ m, body });
      const row = state.payees.find(x => x._id === p.split('/').pop()); Object.assign(row, body); return respond(row);
    }
    if (p === '/api/expenses' && m === 'POST') {
      const body = JSON.parse(request.postData() || '{}'); saves.push(body);
      const payee = state.payees.find(x => x._id === body.payeeId);
      const row = { _id: 'x' + saves.length, status: 'معلق', ...body, payeeName: payee?.name || '', payeeKind: payee?.kind || '' };
      if (body.salary) { const s = body.salary; s.pointsBonus = Math.max(0, s.points) * s.pointValue; s.net = s.base + s.pointsBonus + s.overtime - s.deductions; row.amount = s.net; }
      delete row.updatePayeeAmount; state.expenses.unshift(row); return respond(row, 201);
    }
    if (p === '/api/expenses') return respond(state.expenses);
    if (/^\/api\/expenses\/[^/]+$/.test(p)) return respond(state.expenses.find(x => x._id === p.split('/').pop()) || {});
    if (p.startsWith('/api/employee-performance/points/')) { pointsAsked.push(url.searchParams.get('month')); return respond({ points: 200, month: url.searchParams.get('month'), label: 'm' }); }
    if (p === '/api/users' || p === '/api/users/mentionable') return respond([{ _id: '64f000000000000000000009', name: 'Ahmed Ali', username: 'ahmed', isActive: true, jobTitle: 'Customer Service' }, { _id: '64f000000000000000000008', name: 'Old Staff', username: 'old', isActive: false }]);
    if (p === '/api/auth/me') return respond({ _id: 'u1', name: 'Owner', role, perms: ['expenses'] });
    if (p === '/api/settings') return respond({ lang, darkMode: dark });
    if (p === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
    if (p === '/api/notifications' || p === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
    return respond([]);
  });
  await page.goto(origin + '/#expenses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof openExpenseModal === 'function' && window.SouliaExpensePayees && !document.querySelector('#splash-screen'), { timeout: 30000 });
  // The push-notification invitation opens on its own over the form; it is not part of this test.
  await page.evaluate(() => {
    const shut = () => document.querySelectorAll('#push-onboarding[open]').forEach(d => { try { d.close(); } catch (_) {} d.removeAttribute('open'); });
    shut(); new MutationObserver(shut).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });
  });
  await page.evaluate(() => { window.__toasts = []; const o = window.toast; window.toast = (m, err) => { window.__toasts.push({ m, err: !!err }); try { o(m, err); } catch (_) {} }; });
  return { page, errors, saves, payeeWrites, state, pointsAsked };
}

const newExpense = async (page, cat) => {
  await page.evaluate(() => { closeModal?.(); openExpenseModal(); });
  await page.waitForSelector('#em-cat');
  if (cat) { await page.select('#em-cat', cat); if (['اعلانات', 'مرتبات', 'اشتراكات'].includes(cat)) await page.waitForSelector('#em-xp'); }
};
const waitPicker = (page) => page.waitForFunction(() => document.querySelector('#xp-q') || document.querySelector('.xp-sel') || document.querySelector('.xp-form'), { timeout: 10000 });
const val = (page, sel) => page.$eval(sel, i => i.value);
const save = (page) => page.evaluate(() => saveExpense(''));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  try {
    /* ── A: admin, Arabic ─────────────────────────────────────── */
    const a = await open(browser, { expenses: [] });
    await newExpense(a.page, 'إيجارات');
    ok(!(await a.page.$('#em-xp')), 'rent shows no party section');
    ok(!!(await a.page.$('#modal-overlay .pm-sel-btn .exp-cat-ic')), 'category uses the app dropdown with its coloured icon');
    ok((await a.page.$$('.exp-filters-row .pm-sel')).length === 2, 'filter bar uses the app dropdowns too');
    await a.page.click('#modal-overlay .pm-sel:has(#em-cat) .pm-sel-btn');
    const catOpts = await a.page.$$eval('.pm-sel-panel .pm-sel-opt', o => o.map(x => x.textContent.trim()));
    ok(catOpts.includes('إعلانات') && catOpts.includes('مواصلات وتنقل') && catOpts.includes('أخرى'), 'category names spelled correctly');
    await a.page.keyboard.press('Escape');
    await a.page.$eval('#em-amount', i => { i.value = ''; });
    await a.page.type('#em-amount', '1234567.891');
    ok((await val(a.page, '#em-amount')) === '1,234,567.89', 'typing groups thousands and keeps two decimals');
    await a.page.$eval('#em-amount', i => { i.value = ''; });
    await a.page.select('#em-cat', 'اعلانات');
    await a.page.waitForSelector('#em-xp');
    await waitPicker(a.page);
    ok((await a.page.$eval('#em-xp .exp-form-section-title', e => e.textContent.trim())) === 'شركة الإعلان والفترة', 'ads section title');
    ok(await a.page.$eval('[data-xp="period"][data-v="cur"]', b => b.classList.contains('is-on')), 'current month is the default period');

    // Missing agency blocks the save.
    await a.page.type('#em-amount', '100');
    await a.page.$eval('#em-desc', i => { i.value = 'test'; });
    await save(a.page);
    ok(a.saves.length === 0 && (await a.page.evaluate(() => __toasts.at(-1)?.m)) === 'اختر شركة الإعلان أو أضفها', 'saving an ad expense without an agency is refused');
    ok(!!(await a.page.$('#em-xp .xp-msg.is-error')), 'the agency field shows the error');
    await a.page.$eval('#em-desc', i => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await a.page.$eval('#em-amount', i => { i.value = ''; });

    // Add a new agency from the search box.
    await a.page.type('#xp-q', 'Nova Media');
    await a.page.waitForSelector('.xp-opt.is-add');
    ok((await a.page.$eval('.xp-opt.is-add', o => o.textContent)).includes('Nova Media'), 'typed name offers «إضافة»');
    await a.page.keyboard.press('Enter');
    await a.page.waitForSelector('.xp-form #xp-f-name');
    ok(a.saves.length === 0, 'Enter in the search box did not save the expense');
    ok((await val(a.page, '#xp-f-name')) === 'Nova Media', 'the form opens with the typed name');
    ok(await a.page.$eval('[data-xp="f-platform"][data-v="meta"]', b => b.classList.contains('is-on')), 'Meta is the default platform');
    await a.page.click('[data-xp="f-platform"][data-v="tiktok"]');
    await a.page.type('#xp-f-amount', '8000');
    await a.page.screenshot({ path: path.join(output, 'ads-add-ar-1440.png') });
    await a.page.click('[data-xp="f-save"]');
    await a.page.waitForSelector('.xp-sel');
    const created = a.payeeWrites[0];
    ok(created && created.body.kind === 'ads' && created.body.platform === 'tiktok' && created.body.amount === 8000, 'POST /expenses/payees with kind, platform, amount');
    ok((await val(a.page, '#em-amount')) === '8,000', 'the usual budget fills the amount, with a thousands separator');
    const t1 = await val(a.page, '#em-desc');
    ok(t1 === `إعلانات Nova Media (TikTok) — لشهر ${arMonth(curMonth)}`, 'auto title: ' + t1);

    await a.page.click('[data-xp="period"][data-v="prev"]');
    ok((await val(a.page, '#em-desc')) === `إعلانات Nova Media (TikTok) — لشهر ${arMonth(prevMonth)}`, 'changing the period rewrites the title');
    await a.page.screenshot({ path: path.join(output, 'ads-selected-ar-1440.png') });
    await save(a.page);
    await a.page.waitForFunction(() => !document.querySelector('#modal-overlay.active'), { timeout: 10000 })
      .catch(async e => { console.log('toasts:', JSON.stringify(await a.page.evaluate(() => __toasts)), 'saves:', a.saves.length); throw e; });
    const s1 = a.saves[0];
    ok(s1 && s1.payeeId === a.state.payees[0]._id && s1.periodFrom === `${prevMonth}-01` && s1.periodTo === lastDayOf(prevMonth), 'expense saved with payeeId and the previous month');
    ok(!('updatePayeeAmount' in s1), 'amount unchanged → payee amount not touched');

    // Second time: recent chip, duplicate warning, custom title kept.
    await newExpense(a.page, 'اعلانات');
    await a.page.waitForSelector('.xp-chip');
    ok((await a.page.$eval('.xp-chip', c => c.textContent.trim())) === 'Nova Media', 'the saved agency appears as a one-click chip');
    await a.page.click('.xp-chip');
    await a.page.waitForSelector('.xp-sel');
    ok((await val(a.page, '#em-amount')) === '8,000', 'picking it again fills the amount');
    await a.page.$eval('#em-amount', i => { i.value = ''; });
    await a.page.type('#em-amount', '9500');
    await a.page.waitForFunction(() => !document.querySelector('#xp-save-amount-row').hidden);
    ok(!(await a.page.$eval('#xp-save-amount', c => c.checked)), 'a different amount offers «حفظ كمبلغ معتاد», unticked');
    await a.page.click('#xp-save-amount');
    await a.page.$eval('#em-desc', i => { i.value = 'حملة الجمعة البيضاء'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await a.page.click('[data-xp="period"][data-v="prev"]');
    ok((await val(a.page, '#em-desc')) === 'حملة الجمعة البيضاء', 'a title typed by hand is kept when the period changes');
    ok(!!(await a.page.$('[data-xp="use-title"]')), 'the suggested title is offered with «استخدمه»');
    await a.page.evaluate(() => { window.__confirms = []; window.showConfirm = (q) => { window.__confirms.push(q); return Promise.resolve(false); }; });
    await save(a.page);
    ok(a.saves.length === 1 && (await a.page.evaluate(() => __confirms.length)) === 1, 'same agency + same month asks before saving (declined → nothing saved)');
    ok((await a.page.evaluate(() => __confirms[0])).includes('Nova Media'), 'the warning names the agency');
    await a.page.click('[data-xp="period"][data-v="cur"]');
    await save(a.page);
    await a.page.waitForFunction(() => !document.querySelector('#modal-overlay.active'), { timeout: 10000 });
    ok(a.saves[1].updatePayeeAmount === true && a.saves[1].periodFrom === `${curMonth}-01` && a.saves[1].desc === 'حملة الجمعة البيضاء', 'saved with «update usual amount» and the hand-written title');

    // Salary: the employee comes from the ACTIVE user accounts (a disabled one is not offered).
    await newExpense(a.page, 'مرتبات');
    await waitPicker(a.page);
    const emps = await a.page.$$eval('.xp-emps .xp-chip', c => c.map(x => x.textContent.trim()));
    ok(emps.includes('Ahmed Ali') && !emps.includes('Old Staff'), 'active employees are offered, a disabled account is not: ' + emps.join(', '));
    await a.page.type('#xp-q', 'Ahm');
    await a.page.waitForSelector('.xp-list:not([hidden]) .xp-opt');
    ok((await a.page.$eval('.xp-list', l => l.textContent)).includes('لم يُسجَّل مرتبه بعد'), 'the search lists the account, marked «salary not set yet»');
    await a.page.$eval('#xp-q', i => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await a.page.click('.xp-emps .xp-chip.is-new');
    await a.page.waitForSelector('.xp-sel');
    ok(a.payeeWrites.at(-1).body.userId === '64f000000000000000000009' && a.payeeWrites.at(-1).body.kind === 'salary', 'picking an account creates its salary record, linked to the account');
    ok((await val(a.page, '#em-desc')) === `مرتب Ahmed Ali — لشهر ${arMonth(curMonth)}`, 'salary title');
    await a.page.click('#xp-s-base', { clickCount: 3 });
    await a.page.type('#xp-s-base', '9000');
    ok((await val(a.page, '#em-amount')) === '9,000', 'base salary fills the amount');
    // Salary breakdown: base + points × value + overtime − deductions = the amount.
    ok(!!(await a.page.$('.xp-sal')), 'admin gets «تفاصيل المرتب»');
    ok(await a.page.$eval('#em-amount', i => i.readOnly), 'the amount is derived from the breakdown (read-only)');
    await a.page.click('[data-xp="sal-fetch"]');
    await a.page.waitForFunction(() => document.querySelector('#xp-s-points')?.value === '200', { timeout: 10000 });
    ok(a.pointsAsked.at(-1) === curMonth, 'points are read for the period\'s month (' + a.pointsAsked.at(-1) + ')');
    await a.page.type('#xp-s-pv', '2');
    ok((await a.page.$eval('#xp-s-bonus', b => b.textContent)).includes('400'), '200 points × 2 = 400 bonus');
    await a.page.type('#xp-s-ot', '300');
    await a.page.type('#xp-s-otn', '10 ساعات إضافية');
    await a.page.type('#xp-s-ded', '150');
    await a.page.type('#xp-s-dedn', 'تأخير يومين');
    ok((await val(a.page, '#em-amount')) === '9,550', 'amount = 9,000 + 400 + 300 − 150 = 9,550');
    ok((await a.page.$eval('#em-amount-words', w => w.textContent)).includes('تسعة آلاف وخمسمائة وخمسون جنيهاً'), 'the amount is written in words');
    ok(!(await a.page.$eval('#xp-save-amount-row', r => r.hidden)), 'a new point value offers to save it on the employee');
    await a.page.screenshot({ path: path.join(output, 'salary-breakdown-ar-1440.png') });
    await save(a.page);
    await a.page.waitForFunction(() => !document.querySelector('#modal-overlay.active'), { timeout: 10000 });
    const sv = a.saves.at(-1);
    ok(sv.salary && sv.salary.points === 200 && sv.salary.pointValue === 2 && sv.salary.overtime === 300 && sv.salary.deductions === 150
      && sv.salary.pointsMonth === curMonth && sv.salary.deductionsNote === 'تأخير يومين' && sv.amount === 9550, 'the breakdown is sent with the expense');
    const salId = a.state.expenses.find(x => x.salary)._id;
    const doc = await a.page.evaluate(id => SouliaExpensePayees.salaryDocHtml(expenses.find(x => x._id === id)), salId);
    for (const s of ['إشعار صرف مرتب', 'ادفعوا لأمر', 'Ahmed Ali', '200 نقطة', 'تأخير يومين',
      'فقط تسعة آلاف وخمسمائة وخمسون جنيهاً مصرياً لا غير', '9,550.00', 'يُصرف للمستفيد الأول', 'مرتب شهر ' + arMonth(curMonth),
      'صُرف نقدًا', '<b>المدير</b>', '<b>المستلم</b>']) {
      ok(doc.includes(s), 'notice/cheque contains «' + s + '»');
    }
    // Owner: no «رقم المصروف/المستند» label, no status, no per-point rate, no word «شيك», no «اسم الموظف».
    for (const s of ['رقم المستند', 'رقم المصروف', 'بانتظار الاعتماد', 'معلق', 'حالة المصروف', '× 2', 'للنقطة', 'شيك', 'اسم الموظف']) {
      ok(!doc.includes(s), 'notice/cheque does not print «' + s + '»');
    }
    ok(/خدمة العملاء|Customer Service/.test(doc), 'the slip states the employee\'s job title');
    ok(doc.includes(`<title>مرتب Ahmed Ali — لشهر ${arMonth(curMonth)}</title>`), 'the PDF file is named after the expense: مرتب Ahmed Ali — لشهر ' + arMonth(curMonth));
    const plain = await a.page.evaluate(() => _expPrintTitle({ desc: 'فاتورة كهرباء: المخزن/الدور 2', category: 'كهرباء ومياه', date: '2026-11-05' }));
    ok(plain === 'فاتورة كهرباء- المخزن-الدور 2 — 5-11-2026', 'an expense without a period is named with its date, unsafe characters removed: ' + plain);
    const docPage = await browser.newPage();
    await docPage.setViewport({ width: 800, height: 1130 });
    await docPage.setContent(doc.replace(/@import url\([^)]*\);/, ''), { waitUntil: 'domcontentloaded' });
    ok(await docPage.evaluate(() => document.body.innerText.includes('ادفعوا لأمر')), 'the slip document renders');
    const docFile = path.join(output, 'salary-slip.html');
    fs.writeFileSync(docFile, doc.replace(/@import url\([^)]*\);/, ''));
    await docPage.goto('file:///' + docFile.replace(/\\/g, '/'), { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 400));
    // (Headless capture of this page comes out blank here; the HTML file is kept for a manual look.)
    await docPage.close();
    await a.page.evaluate(id => openExpenseDetail(id), salId);
    await a.page.waitForSelector('.xp-dsal');
    ok((await a.page.$$('.xp-dsal-row')).length === 5, 'details window lists base, bonus, overtime, deductions, net');
    ok(await a.page.evaluate(id => { let called = ''; const o = SouliaExpensePayees.printSalary; SouliaExpensePayees.printSalary = x => { called = x; }; printExpenseDetails(id); SouliaExpensePayees.printSalary = o; return called === id; }, salId),
      'the regular «طباعة» on a salary expense prints the salary notice + cheque');
    await a.page.evaluate(() => closeModal());

    // Yearly subscription covers 12 months.
    await newExpense(a.page, 'اشتراكات');
    await waitPicker(a.page);
    await a.page.type('#xp-q', 'Shopify');
    await a.page.waitForSelector('.xp-opt.is-add');
    await a.page.keyboard.press('Enter');
    await a.page.waitForSelector('[data-xp="f-cycle"][data-v="yearly"]');
    await a.page.click('[data-xp="f-cycle"][data-v="yearly"]');
    await a.page.type('#xp-f-amount', '12000');
    await a.page.click('[data-xp="f-save"]');
    await a.page.waitForSelector('.xp-sel');
    const sum = await a.page.$eval('.xp-period-sum', e => e.textContent);
    ok(sum.includes('12 شهرًا'), 'a yearly subscription covers 12 months: ' + sum.trim());
    const endYm = (() => { const [y, m] = curMonth.split('-').map(Number); const d = new Date(y, m - 1 + 11, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })();
    await a.page.$eval('#em-desc', () => {});
    await save(a.page);
    await a.page.waitForFunction(() => !document.querySelector('#modal-overlay.active'), { timeout: 10000 });
    ok(a.saves.at(-1).periodTo === lastDayOf(endYm) && a.saves.at(-1).desc.startsWith('اشتراك Shopify — لفترة'), 'yearly period saved: ' + a.saves.at(-1).periodFrom + ' → ' + a.saves.at(-1).periodTo);

    // Paying ahead: next month, several months, and custom dates.
    await newExpense(a.page, 'اعلانات');
    await a.page.waitForSelector('.xp-chip');
    await a.page.click('.xp-chip');
    await a.page.waitForSelector('.xp-sel');
    const nextYm = (() => { const [y, m] = curMonth.split('-').map(Number); const d = new Date(y, m, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })();
    await a.page.click('[data-xp="period"][data-v="next"]');
    ok((await val(a.page, '#em-desc')).endsWith(`لشهر ${arMonth(nextYm)}`), 'next month: ' + await val(a.page, '#em-desc'));
    ok(!!(await a.page.$('.xp-ahead')), 'a future period is marked «دفع مقدّم»');
    await a.page.click('[data-xp="period"][data-v="multi"]');
    ok(!!(await a.page.$('#xp-mstart')) && (await val(a.page, '#xp-mstart')) === nextYm, 'several months start from the chosen month');
    await a.page.click('[data-xp="period-n"][data-v="6"]');
    const sixEnd = (() => { const [y, m] = nextYm.split('-').map(Number); const d = new Date(y, m - 1 + 5, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })();
    ok((await a.page.$eval('.xp-period-sum', e => e.textContent)).includes(arMonth(sixEnd).split(' ')[0]), '6 months end in ' + sixEnd);
    await a.page.screenshot({ path: path.join(output, 'ads-ahead-ar-1440.png') });
    await a.page.$eval('#em-amount', i => { i.value = ''; });
    await a.page.type('#em-amount', '12000');
    a.page.evaluate(() => { window.showConfirm = () => Promise.resolve(true); });
    await save(a.page);
    await a.page.waitForFunction(() => !document.querySelector('#modal-overlay.active'), { timeout: 10000 });
    ok(a.saves.at(-1).periodFrom === `${nextYm}-01` && a.saves.at(-1).periodTo === lastDayOf(sixEnd), 'saved for 6 months ahead: ' + a.saves.at(-1).periodFrom + ' → ' + a.saves.at(-1).periodTo);
    await newExpense(a.page, 'اعلانات');
    await a.page.waitForSelector('.xp-chip');
    await a.page.click('.xp-chip');
    await a.page.waitForSelector('.xp-sel');
    await a.page.click('[data-xp="period"][data-v="custom"]');
    const rb = await a.page.$eval('.xp-range-btn', b => ({ t: b.textContent.replace(/\s+/g, ' ').trim(), w: b.getBoundingClientRect().width }));
    ok(rb.w > 120 && rb.t.includes(arMonth(curMonth)), 'custom range is a readable button with the range written on it: ' + rb.t);
    await a.page.click('.xp-range-btn');
    await a.page.waitForSelector('.drx-d[data-date]', { visible: true, timeout: 5000 });
    const d5 = `${curMonth}-05`, d20 = `${curMonth}-20`;
    const onTop = await a.page.$eval(`.drx-d[data-date="${d5}"]`, b => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.drx-d') === b; });
    ok(onTop, 'the app calendar opens above the expense window');
    await a.page.click(`.drx-d[data-date="${d5}"]`);
    await a.page.click(`.drx-d[data-date="${d20}"]`);
    await a.page.click('.drx-ok');
    await a.page.waitForFunction(() => !document.querySelector('.drx-d[data-date]')?.offsetParent || true);
    const after = await a.page.$eval('.xp-range-btn', b => b.textContent.replace(/\s+/g, ' ').trim());
    ok(after.includes('5') && after.includes('20'), 'the picked range is written on the button: ' + after);
    ok(await a.page.evaluate(() => document.querySelector('#modal-overlay').classList.contains('active')), 'the expense window stays open');
    await (await a.page.$('#em-xp')).screenshot({ path: path.join(output, 'ads-custom-dates.png') });
    await a.page.evaluate(() => closeModal());

    // The expenses table has no checkbox column (owner): 8 headers, every row and separator spans 8.
    const tbl = await a.page.evaluate(() => ({
      th: document.querySelectorAll('#exp-table thead th').length,
      chk: document.querySelectorAll('#exp-table input[type=checkbox]').length,
      spans: [...document.querySelectorAll('#exp-tbody td[colspan]')].map(td => td.colSpan),
      cells: [...document.querySelectorAll('#exp-tbody tr.exp-clickable-row')].map(r => r.children.length),
    }));
    ok(tbl.th === 8 && tbl.chk === 0 && tbl.spans.every(s => s === 8) && tbl.cells.length && tbl.cells.every(c => c === 8), 'expenses table: no checkbox column, 8 aligned columns ' + JSON.stringify(tbl));
    await (await a.page.$('.exp-table-wrap')).screenshot({ path: path.join(output, 'expenses-table.png') });

    // Details window shows the party and period.
    await a.page.evaluate(id => openExpenseDetail(id), a.state.expenses.find(x => x.payeeKind === 'ads')._id);
    await a.page.waitForSelector('.exp-detail-grid');
    const grid = await a.page.$eval('.exp-detail-grid', g => g.textContent);
    ok(grid.includes('شركة الإعلان') && grid.includes('Nova Media') && grid.includes('الفترة'), 'details show the agency and the period');

    // Editing a saved one: the agency card is pre-selected, the title follows the period.
    await a.page.evaluate(id => { closeModal(); openExpenseModal(id); }, a.state.expenses.find(x => x.payeeKind === 'ads' && x.desc.startsWith('إعلانات'))._id);
    await a.page.waitForSelector('.xp-sel');
    ok((await a.page.$eval('.xp-sel b', b => b.textContent)) === 'Nova Media', 'edit opens with the saved agency');
    await a.page.click('[data-xp="period"][data-v="cur"]');
    ok((await val(a.page, '#em-desc')) === `إعلانات Nova Media (TikTok) — لشهر ${arMonth(curMonth)}`, 'an untouched auto title follows the new period on edit');
    ok(a.errors.length === 0, 'no page errors (admin): ' + a.errors.join(' | '));
    await a.page.close();

    /* ── B: staff, English, phone, dark ──────────────────────── */
    const b = await open(browser, { lang: 'en', width: 390, dark: true, role: 'staff', payees: [
      { _id: 'p9aaaaaaaaaaaaaaaaaaaaaa', kind: 'salary', name: 'Mona Adel', amount: 7000, active: true, lastUsedAt: '2026-11-01' },
    ] });
    await newExpense(b.page, 'مرتبات');
    await waitPicker(b.page);
    await b.page.type('#xp-q', 'Someone New');
    await b.page.waitForSelector('.xp-list:not([hidden])');
    ok(!(await b.page.$('.xp-opt.is-add')) && (await b.page.$eval('.xp-list', l => l.textContent)).includes('a manager adds them'), 'staff cannot add an employee');
    await b.page.$eval('#xp-q', i => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await b.page.click('.xp-chip');
    await b.page.waitForSelector('.xp-sel');
    ok((await val(b.page, '#em-amount')) === '' && (await b.page.$eval('.xp-sel .xp-sub', s => s.textContent)).includes('managers only'), 'staff never see the stored salary');
    ok((await val(b.page, '#em-desc')).startsWith('Salary — Mona Adel — for '), 'English title');
    await b.page.type('#em-amount', '7000');
    ok((await val(b.page, '#em-amount')) === '7,000', 'a typed amount is grouped (7,000)');
    ok(!(await b.page.$('.xp-sal')), 'staff get no salary breakdown')
    ok(await b.page.$eval('#xp-save-amount-row', r => r.hidden), 'staff are not offered to change a salary');
    await (await b.page.$('#em-xp')).screenshot({ path: path.join(output, 'salary-en-390-dark.png') });
    ok((await b.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'no horizontal overflow at 390');
    ok(b.errors.length === 0, 'no page errors (staff): ' + b.errors.join(' | '));
    await b.page.close();

    console.log(`PASS expense-payees (${checks} checks)`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
