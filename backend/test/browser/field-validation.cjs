/* Shared validation runs against the real application helpers and styles, without API writes. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');
const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map(match => match[0]).join('\n');
const validation = html.slice(html.indexOf('function _fieldValue('), html.indexOf('// Initial draft load from server'));
const out = path.join(root, 'artifacts/field-validation');
fs.mkdirSync(out, { recursive: true });
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [language, width] of [['ar', 1440], ['en', 390]]) {
      await page.goto('about:blank');
      await page.setViewport({ width, height: 950 });
      await page.setContent(`<html dir="${language === 'ar' ? 'rtl' : 'ltr'}"><head>${styles}</head><body>
        <form id="sample" style="margin:20px;padding:20px;max-width:800px;background:var(--surface)">
          <h2>${language === 'ar' ? 'بيانات العميل' : 'Customer details'}</h2>
          <label class="form-group">${language === 'ar' ? 'اسم العميل' : 'Customer name'}<input id="name" required aria-describedby="name-hint"></label><small id="name-hint">${language === 'ar' ? 'اكتب الاسم بالكامل' : 'Enter the full name'}</small>
          <label class="form-group">${language === 'ar' ? 'البريد الإلكتروني' : 'Email'}<input id="email" type="email" required></label>
          <label class="form-group">${language === 'ar' ? 'الكمية' : 'Quantity'}<input id="amount" type="number" min="1" max="10" step="1" required data-require-nonzero="true"></label>
          <label class="form-group">${language === 'ar' ? 'نوع المشكلة' : 'Issue category'}<select id="category" required><option value="">${language === 'ar' ? 'اختر' : 'Choose'}</option><option value="product">Product</option></select></label>
          <label class="form-group">${language === 'ar' ? 'وصف المشكلة' : 'Description'}<textarea id="description" required></textarea></label>
          <label><input id="confirm" type="checkbox" required>${language === 'ar' ? 'تأكيد البيانات' : 'Confirm details'}</label>
          <input id="disabled" required disabled><input id="hidden" required hidden>
          <button type="button" id="draft">${language === 'ar' ? 'حفظ مسودة وإغلاق' : 'Save draft'}</button>
          <button type="submit" id="save">${language === 'ar' ? 'حفظ' : 'Save'}</button>
          <button type="reset" id="reset">${language === 'ar' ? 'مسح' : 'Reset'}</button>
        </form><button id="outside">Outside</button><div id="dynamic"></div>
        <script>let currentLang=${JSON.stringify(language)},submitCount=0;document.querySelector('#sample').onsubmit=e=>{e.preventDefault();submitCount++};</script>
      </body></html>`);
      await page.addScriptTag({ content: validation });
      // A hidden required control is intentionally excluded from native submission as well.
      await page.$eval('#hidden', element => { element.disabled = true; });
      for (const selector of ['#name', '#email', '#amount', '#category', '#description', '#confirm']) {
        await page.focus(selector); await page.focus('#outside');
      }
      await page.click('#draft');
      await page.$eval('#sample', form => form.checkValidity());
      assert.equal(await page.$$eval('.is-invalid,.field-error-msg.show', elements => elements.length), 0, 'blur, drafts and passive validity checks stay neutral');
      await page.screenshot({ path: path.join(out, `before-save-${language}-${width}.png`) });
      await page.click('#save');
      assert.equal(await page.evaluate(() => submitCount), 0, 'required fields still block saving');
      assert.equal(await page.$$eval('.is-invalid', elements => elements.length), 6);
      assert.equal(await page.$eval('#name', element => getComputedStyle(element).animationName), 'none', 'validation never shakes');
      assert.equal(await page.$eval('#disabled', element => element.hasAttribute('aria-invalid')), false);
      assert.equal(await page.$eval('#name', element => element.getAttribute('aria-describedby').split(' ').length), 2);
      const errorNodes = await page.$$eval('.field-error-msg', elements => elements.length);
      await page.click('#save');
      assert.equal(await page.$$eval('.field-error-msg', elements => elements.length), errorNodes, 'repeated saves reuse error messages');
      await page.screenshot({ path: path.join(out, `after-save-${language}-${width}.png`) });
      await page.type('#name', 'Nour');
      assert.equal(await page.$eval('#name', element => element.hasAttribute('aria-invalid')), false);
      assert.equal(await page.$eval('#name', element => element.getAttribute('aria-describedby')), 'name-hint', 'original field guidance survives clearing an error');
      assert.equal(await page.$eval('#name', element => getComputedStyle(element._errorMsgEl).display), 'none');
      await page.type('#email', 'wrong');
      assert.equal(await page.$eval('#email', element => element.getAttribute('aria-invalid')), 'true', 'a nonempty invalid email is still invalid');
      await page.type('#email', '@example.test');
      assert.equal(await page.$eval('#email', element => element.hasAttribute('aria-invalid')), false);
      await page.$eval('#amount', element => { element.value = '20'; element.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.equal(await page.$eval('#amount', element => element.getAttribute('aria-invalid')), 'true', 'out-of-range numbers remain invalid');
      await page.$eval('#amount', element => { element.value = '2'; element.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.select('#category', 'product'); await page.type('#description', 'Issue details'); await page.click('#confirm');
      assert.equal(await page.$$eval('.is-invalid', elements => elements.length), 0);
      await page.click('#save');
      assert.equal(await page.evaluate(() => submitCount), 1);
      await page.click('#reset');
      assert.equal(await page.$eval('#sample', form => !!form.dataset.validationAttempted), false);
      await page.focus('#name'); await page.focus('#outside');
      assert.equal(await page.$$eval('.is-invalid', elements => elements.length), 0, 'reset restores pristine validation');
      await page.evaluate(() => {
        document.querySelector('#dynamic').innerHTML = '<div id="scope"><input id="required-meta" data-required="true"><input id="nonzero" type="number" required data-require-nonzero="true" value="0"></div>';
      });
      await page.focus('#required-meta'); await page.focus('#outside');
      assert.equal(await page.$eval('#required-meta', element => element.hasAttribute('aria-invalid')), false, 'newly inserted fields start neutral');
      assert.equal(await page.evaluate(() => validateRequired(document.querySelector('#scope')).ok), false);
      await page.type('#required-meta', 'Ready');
      await page.$eval('#nonzero', element => { element.value = '0'; element.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(await page.$eval('#nonzero', element => element.getAttribute('aria-invalid')), 'true', 'nonzero requirements survive live correction');
      await page.$eval('#nonzero', element => { element.value = '3'; element.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.equal(await page.evaluate(() => validateRequired(document.querySelector('#scope')).ok), true);
      await page.evaluate(() => {
        const element = document.querySelector('#required-meta');
        element.value = '   '; validateRequired(document.querySelector('#scope'));
      });
      assert.equal(await page.$eval('#required-meta', element => element.getAttribute('aria-invalid')), 'true', 'whitespace is not a required value');
    }
    assert.deepEqual(errors, []);
    console.log('PASS: pristine forms, draft actions, explicit submit, quiet inline errors, correction with native constraints, reset, dynamic fields, nonzero and whitespace rules in Arabic/English. All inline scripts parse.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
