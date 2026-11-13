// Settings save bar («في تعديلات مش محفوظة · تجاهل · تحديث») over the SHIPPED index.html:
// the real Settings markup, the real save functions and the real bar code, with a fake API.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); assert.ok(i > 0 && j > i, 'extract ' + a); return html.slice(i, j); };
const start = html.indexOf('<div class="page" id="page-settings">');
const end = html.indexOf('</div><!-- /page-settings -->', start) + '</div><!-- /page-settings -->'.length;
const barCode = cut('// ─── SETTINGS SAVE BAR', '// ─── BACKUP BUTTON BUSY STATE');
const perfCode = cut('const PERF_CFG_DEFAULTS', '/** Compact day-pill summary');
const csCode = cut('// ── Settings card ──', '/** Refreshes settings (vault balances)');
const fillCode = cut('  // ── Print / policy settings', '  const _defCarrier');
const tr = cut('  prdUnsaved:{', '  prdCardPriceNote:{');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', r => r.respond({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html dir="rtl"><body><div id="main">' + html.slice(start, end) + '</div></body></html>' }));
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    for (const name of ['navigation-shell.css', 'settings-responsive.css']) await page.addStyleTag({ path: path.join(root, name) });
    await page.evaluate((tr) => {
      window.qs = s => document.querySelector(s); window.qsa = s => [...document.querySelectorAll(s)];
      window.currentLang = 'ar';
      window.TR = eval('({' + tr + '})');
      window.t = (k, p) => { const e = TR[k]; let v = e ? (e[currentLang] || e.ar) : k; if (p) for (const x in p) v = v.replace('{' + x + '}', p[x]); return v; };
      window.esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
      window.fmtN = String; window.isAdmin = () => true;
      window.toasts = []; window.toast = (m, err) => toasts.push((err ? 'ERR:' : '') + m);
      window.guards = {}; window.registerUnsavedGuard = (k, f) => { guards[k] = f; };
      window.confirmAnswer = true; window.confirms = 0;
      window.showConfirm = async () => { confirms++; return confirmAnswer; };
      window.calls = []; window.failNext = false;
      window.api = async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        await new Promise(r => setTimeout(r, 30));
        if (failNext) { failNext = false; throw new Error('boom'); }
        return Object.assign({}, settings, JSON.parse(opts.body), { autoSettleSince: '2026-11-12' });
      };
      window._csVaultCardsHtml = (v, fn) => ['كاش', 'تحويل بنكي'].map(m => `<button type="button" class="vc" data-v="${m}" onclick="${fn}('${m}')">${m}</button>`).join('');
      window._csMarkVault = () => {}; window._csDate = String;
      window.settings = { companyLegalName: 'Soulia LLC', companyPhone: '0100', printIncludePolicy: true,
        printPolicySales: 'line one', printPolicyFontSize: 10, printPolicyFontWeight: 'normal', printPolicyHighlight: false,
        performanceConfig: { deliveryPoints: 2 }, autoSettleEnabled: false, autoSettleReviewLimit: 20 };
      qs('#page-settings').classList.add('active');
      qs('#emp-perf-criteria-section').style.display = '';
    }, tr);
    await page.addScriptTag({ content: perfCode + '\n' + csCode + '\n' + barCode +
      '\nfunction renderSettings(){ try { renderCsSettingsCard(); } catch(_){}\n' + fillCode + '\n}\nrenderSettings(); _initPerfCriteriaUI();' });

    const bar = () => page.evaluate(() => ({ hidden: qs('#stg-savebar').hidden, txt: qs('#stg-savebar-txt').textContent }));
    const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };

    ok((await bar()).hidden, 'clean page: no bar');
    // the forms lost their own save buttons and per-field auto-saves
    ok(await page.evaluate(() => !qsa('#page-settings [data-stg-form] button').some(b => /save|حفظ/i.test(b.getAttribute('onclick') || ''))
      && !qsa('#page-settings [data-stg-form] [onchange]').length), 'no per-form save buttons or onchange saves');

    await page.evaluate(() => { qsa('.stg-panel').forEach(p => p.classList.remove('active')); qs('#stg-panel-printing').classList.add('active'); });
    await page.focus('#set-company-name'); await page.keyboard.type(' Ltd');
    let b = await bar(); ok(!b.hidden && b.txt === 'في تعديلات مش محفوظة', 'typing shows the bar');
    ok(await page.evaluate(() => guards.settings()), 'leave-page guard is armed');
    await page.evaluate(() => { const el = qs('#set-company-name'); el.value = 'Soulia LLC'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok((await bar()).hidden, 'typing the saved value back hides the bar');

    await page.evaluate(() => {
      const a = qs('#set-company-name'); a.value = 'Soulia Trading'; a.dispatchEvent(new Event('input', { bubbles: true }));
      const s = qs('#set-policy-sales'); s.value = 'line one\nline two'; s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    b = await bar(); ok(b.txt === 'تعديلات مش محفوظة في 2 أقسام', 'two forms edited: bar names the count');
    await page.evaluate(() => renderSettings());
    ok(await page.evaluate(() => qs('#set-company-name').value === 'Soulia Trading' && qs('#set-policy-sales').value.includes('two')),
      'a live renderSettings() does not wipe pending edits');

    // layout: the bar sits on screen, centred, inside the content column
    for (const [w, h] of [[1440, 900], [390, 800]]) {
      await page.setViewport({ width: w, height: h });
      await page.evaluate(() => scrollTo(0, 0));
      const r = await page.$eval('#stg-savebar', e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, bt: b.bottom, h: b.height }; });
      await page.screenshot({ path: path.resolve(__dirname, `../../../artifacts/settings-savebar-${w}.png`) });
      ok(r.l >= 0 && r.r <= w + 0.5 && r.bt <= h + 0.5 && r.h < 70, `bar visible and inside the screen at ${w}px (${Math.round(r.t)}-${Math.round(r.bt)})`);
    }
    await page.setViewport({ width: 1440, height: 900 });

    // Update: both forms saved through their own functions, one toast, bar gone
    await page.click('#stg-savebar-save');
    ok(await page.evaluate(() => qs('#stg-savebar-save').disabled && qs('#stg-savebar').classList.contains('is-busy')), 'busy while saving');
    await page.waitForFunction(() => qs('#stg-savebar').hidden, { timeout: 3000 });
    const c = await page.evaluate(() => ({ calls, toasts }));
    ok(c.calls.length === 2 && c.calls[0].body.companyLegalName === 'Soulia Trading' && c.calls[1].body.printPolicySales === 'line one\nline two',
      'update saved both forms with the typed values');
    ok(c.toasts.length === 1 && c.toasts[0] === 'تم حفظ التعديلات', 'one success toast, not one per form');
    ok(await page.evaluate(() => qs('#set-company-name').value === 'Soulia Trading'), 'saved values stay in the fields');

    // failure keeps the edits and the bar
    await page.evaluate(() => { toasts.length = 0; const el = qs('#perf-cfg-deliveryPoints'); el.value = '9'; el.dispatchEvent(new Event('input', { bubbles: true })); failNext = true; });
    await page.click('#stg-savebar-save');
    await page.waitForFunction(() => !qs('#stg-savebar-save').disabled, { timeout: 3000 });
    await new Promise(r => setTimeout(r, 50));
    ok(await page.evaluate(() => !qs('#stg-savebar').hidden && qs('#perf-cfg-deliveryPoints').value === '9' && toasts.some(t => t.startsWith('ERR:'))),
      'a failed save keeps the bar, the value and shows the error');

    // discard: confirm declined keeps edits; accepted restores
    await page.evaluate(() => { confirmAnswer = false; });
    await page.click('#stg-savebar-discard'); await new Promise(r => setTimeout(r, 30));
    ok(await page.evaluate(() => qs('#perf-cfg-deliveryPoints').value === '9' && !qs('#stg-savebar').hidden), 'discard asks first; "keep editing" keeps the edit');
    await page.evaluate(() => { confirmAnswer = true; const r = qs('#set-policy-font-size'); r.value = '13'; r.dispatchEvent(new Event('input', { bubbles: true }));
      qs('#set-print-policy').click(); });
    await page.click('#stg-savebar-discard'); await new Promise(r => setTimeout(r, 30));
    ok(await page.evaluate(() => qs('#perf-cfg-deliveryPoints').value === '2' && qs('#set-policy-font-size').value === '10'
      && qs('#policy-font-size-val').textContent === '10' && qs('#set-print-policy').checked === true && qs('#stg-savebar').hidden),
      'discard restores number, range (and its label) and switch');

    // Bosta card: picking a vault (not an input) marks it dirty; update saves and redraws
    await page.evaluate(() => { calls.length = 0; toasts.length = 0; qs('#stg-autosettle-card .vc[data-v="كاش"]').click(); });
    ok(!(await bar()).hidden, 'vault pick in the Bosta card shows the bar');
    await page.click('#stg-savebar-save');
    await page.waitForFunction(() => qs('#stg-savebar').hidden, { timeout: 3000 });
    ok(await page.evaluate(() => calls.length === 1 && calls[0].body.autoSettleVaultMethod === 'كاش' && toasts[0] === 'تم حفظ التعديلات'), 'Bosta card saved');

    // English
    await page.evaluate(() => { currentLang = 'en'; const el = qs('#set-company-phone'); el.value = '0111'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok((await bar()).txt === 'Unsaved changes', 'English text');
    assert.deepEqual(errors, []); console.log('  ✓ no page errors');
    console.log('PASS settings-savebar');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
