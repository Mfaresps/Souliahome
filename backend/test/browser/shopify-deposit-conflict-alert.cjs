const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} is missing`);
  const declaration = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
  return source.slice(declaration, source.indexOf('\n}', start) + 2);
}

const harness = new Function(`
  let order, modal = '', opened = '';
  const currentLang = 'ar', esc = String, _spReceiptJs = value => JSON.stringify(value);
  const _spOrderById = () => order;
  const openModal = html => { modal = html; };
  const openShopifyEditReview = () => { opened = 'edit'; };
  const showShopifyCancelReason = () => { opened = 'cancel'; };
  ${['_spDepositActionIssues', '_spOpenDepositIssue', '_spWarnDepositAction', '_spToggleShipWithoutDeposit', 'openSpReceiptForm'].map(fn).join('\n')}
  return { setOrder: value => { order = value; modal = ''; opened = ''; }, modal: () => modal,
    opened: () => opened, toggle: _spToggleShipWithoutDeposit, add: openSpReceiptForm,
    view: _spOpenDepositIssue, issues: _spDepositActionIssues };
`)();

(async () => {
  const base = { _id: 'o1', ref: '3023', status: 'pending', cancelled: false };
  harness.setOrder({ ...base, editRequest: { status: 'معلق' } });
  harness.add('o1');
  assert.match(harness.modal(), /شوف التعديل/);
  harness.view('o1', 'edit');
  assert.equal(harness.opened(), 'edit');

  harness.setOrder({ ...base, cancelRequest: { status: 'معلق' } });
  await harness.toggle('o1');
  assert.match(harness.modal(), /طلب إلغاء قيد المراجعة/);
  harness.view('o1', 'cancel');
  assert.equal(harness.opened(), 'cancel');

  harness.setOrder({ ...base, cancelled: true });
  harness.add('o1');
  assert.match(harness.modal(), /الأوردر ملغي/);

  harness.setOrder({ ...base, editRequest: { status: 'معتمد' } });
  assert.equal(harness.issues({ ...base, editRequest: { status: 'معتمد' } }).length, 0);
  console.log('PASS deposit and no-deposit actions show the relevant order warning and review link');
})().catch(error => { console.error(error); process.exitCode = 1; });
