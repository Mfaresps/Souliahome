const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const intro = html.slice(html.indexOf('function _pwScanIntroHtml('), html.indexOf('function _pwScanGuidanceHtml('));
const skip = html.slice(html.indexOf('async function pwSkipDamagedLabel('), html.indexOf('async function pwScanOrderUnit('));
assert.ok(intro.startsWith('function _pwScanIntroHtml('));
assert.ok(skip.startsWith('async function pwSkipDamagedLabel('));

const order = {_id: 'demo', items: [{lineId: 'line-1', qty: 1, name: 'Basket'}]};
const summary = {lines: [{lineId: 'line-1', qty: 1, units: [], skippedCount: 0}]};
const state = {loading: false, summary};
const rendered = [];
let failRequest = false;
const context = {
  currentLang: 'en', order, state, crypto: require('node:crypto'),
  _pwSelId: 'demo', _pickupOrders: [order],
  _pwPickState: () => state, _puRequireEdit: () => true,
  hasPerm: () => true, esc: String, fmtN: String,
  _pwLoadPickSummary: async () => { state.summary = summary; return summary; },
  _pwIncompletePickLines: () => [], _pwScanFocus: () => {},
  qs: () => null, CSS: {escape: String},
  window: {InvoiceUnitIdentities: {changed: () => {}}},
  api: async () => {
    if (failRequest) throw new Error('Could not save');
    summary.lines[0].skippedCount = 1;
    return {prepChecked: false};
  },
};
vm.createContext(context);
vm.runInContext(`${intro}\n${skip}`, context);
context._pwRenderWork = () => rendered.push(context._pwScanIntroHtml(order, state));

(async () => {
  await context.pwSkipDamagedLabel('demo', 'line-1');
  assert.equal(state.summary.lines[0].skippedCount, 1);
  assert.ok(rendered.every(markup => !markup.includes('data-pw-scan-result')));
  assert.match(rendered.at(-1), /All pieces accounted for/);

  order.prepChecked = true;
  context._pwRenderWork();
  assert.ok(!rendered.at(-1).includes('data-pw-scan-result'));

  state.summary.lines[0].skippedCount = 0;
  state.exceptionAttempts = {};
  failRequest = true;
  await context.pwSkipDamagedLabel('demo', 'line-1');
  assert.match(rendered.at(-1), /pw-scan-feedback pw-station-result is-error/);
  console.log('PASS: prepare without scan stays silent, approval stays silent, errors remain visible.');
})().catch(error => { console.error(error); process.exitCode = 1; });
