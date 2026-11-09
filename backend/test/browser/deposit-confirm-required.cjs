// «Record deposit» with the confirm box unticked: the row must turn red, shake, stay red until
// ticked, then clear. Uses the shipped CSS (index.html + deposit-entry-compact.css) and the shipped
// _spDepShake / _spDepSyncConfirm, extracted from index.html — never copied.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const pub = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const compact = fs.readFileSync(path.join(pub, 'deposit-entry-compact.css'), 'utf8');
const fn = name => {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0, i = html.indexOf('{', start);
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  return html.slice(start, i + 1);
};
const out = process.argv[2] || path.resolve(__dirname, '../../../artifacts/deposit-confirm-required');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const results = [];
  for (const [lang, dark] of [['ar', false], ['en', false], ['en', true]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 560, height: 360 });
    await page.setContent(`<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${css}</style><style>${compact}</style></head>
      <body class="${dark ? 'dark-mode' : ''}" style="padding:24px">
      <div id="modal-content" class="modal spdep-modal spdep-entry-modal" style="max-width:500px;padding:20px 28px">
        <label class="spdep-confirm-check"><input type="checkbox" id="spdep-confirm-check" onchange="_spDepSyncConfirm()"><span class="spdep-confirm-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5 9-10"/></svg></span><span class="spdep-confirm-text"><span>${lang === 'ar' ? 'راجعت المبلغ والخزنة' : 'I checked the amount and vault'}</span><bdi class="spdep-confirm-employee">Souliahome</bdi></span></label>
        <button class="btn btn-primary" id="spdep-submit-btn" disabled style="width:100%;margin-top:14px">Record deposit</button>
      </div>
      <script>
        const qs = s => document.querySelector(s); const toast = m => { window.__toast = m; }; let _spReceiptForm = null;
        ${fn('_spDepShake')}
        ${fn('_spDepSyncConfirm')}
      </script></body></html>`);
    const row = '.spdep-confirm-check';
    const before = await page.$eval(`${row} .spdep-confirm-box`, el => getComputedStyle(el).borderColor);
    await page.evaluate(() => _spDepShake(document.querySelector('.spdep-confirm-check'), 'Tick'));
    await new Promise(r => setTimeout(r, 120));
    const mid = await page.$eval(row, el => getComputedStyle(el).transform);
    await new Promise(r => setTimeout(r, 600));
    const after = await page.$eval(row, el => ({ cls: el.className, box: getComputedStyle(el.querySelector('.spdep-confirm-box')).borderColor,
      text: getComputedStyle(el.querySelector('.spdep-confirm-text>span')).color, shadow: getComputedStyle(el).boxShadow }));
    await page.screenshot({ path: path.join(out, `${lang}${dark ? '-dark' : ''}-required.png`) });
    await page.click(row);
    const cleared = await page.$eval(row, el => el.classList.contains('is-required'));
    const name = `${lang}${dark ? ' dark' : ''}`;
    const red = c => { const [r, g, b] = c.match(/\d+/g).map(Number); return r > 150 && r > g + 60 && r > b + 60; };
    const check = (ok, what) => { results.push([ok, `${name}: ${what}`]); };
    check(mid !== 'none', 'row is moving mid-shake');
    check(after.cls.includes('is-required'), 'stays marked after the shake ends');
    check(red(after.box) && !red(before), 'tick box turns red');
    check(red(after.text), 'label turns red');
    check(after.shadow !== 'none', 'row keeps its red outline after the shake');
    check(!cleared, 'ticking clears the red state');
    await page.close();
  }
  await browser.close();
  for (const [ok, what] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (results.some(([ok]) => !ok)) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
