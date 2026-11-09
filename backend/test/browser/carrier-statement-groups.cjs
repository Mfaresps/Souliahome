const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
}
const start = html.indexOf('function _csGroupDate(date)');
const end = html.indexOf('function renderCsStatement()', start);
const labelStart = html.indexOf('function _csLineLabel(l)');
const renderEnd = html.indexOf('function _cstDates()', end);
assert(labelStart >= 0 && start > labelStart && end > start && renderEnd > end);

let modal = '';
let statementHtml = '';
const raw = [
  { date: '2026-11-02', at: '2026-11-02T10:00:00', kind: 'collection', txId: 'a', ref: 'A', party: '<img>', in: 100, out: 0 },
  { date: '2026-11-02', at: '2026-11-02T10:00:00', kind: 'fees', txId: 'a', ref: 'A', in: 0, out: 15 },
  { date: '2026-11-02', at: '2026-11-02T11:00:00', kind: 'collection', txId: 'b', ref: 'B', in: 200, out: 0 },
  { date: '2026-11-02', at: '2026-11-02T11:00:00', kind: 'fees', txId: 'b', ref: 'B', in: 0, out: 25 },
  { date: '2026-11-02', at: '2026-11-02T11:30:00', kind: 'fees', txId: 'c', ref: 'C', in: 0, out: 10 },
  { date: '2026-11-02', at: '2026-11-02T23:59:58', kind: 'payout', ref: 'PAY-1', in: 0, out: 150 },
  { date: '2026-11-03', at: '2026-11-03T10:00:00', kind: 'collection', txId: 'd', ref: 'D', in: 50, out: 0 },
  { date: '2026-11-03', at: '2026-11-03T10:00:00', kind: 'fees', txId: 'd', ref: 'D', in: 0, out: 5 },
];
const context = vm.createContext({
  Map, Date, Number, String, raw,
  _cst: { from: '2026-11-02', to: '2026-11-03', data: { lines: raw, opening: 30, balance: 175, totals: { in: 350, out: 205 } } },
  _csLoc: () => 'en-GB',
  _csR2: n => Math.round((Number(n) || 0) * 100) / 100,
  _csMoney: n => Number(n || 0).toFixed(2),
  _csN: n => Number(n).toFixed(2),
  _csDate: date => date,
  _csCan: () => false,
  _payMethodLabel: value => value,
  isAdmin: () => false,
  qs: () => ({ set innerHTML(value) { statementHtml = value; } }),
  esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  escHtml: value => String(value ?? '').replace(/'/g, '&#39;'),
  t: (key, args = {}) => key.replace(/.*/, () => `${key}${args.d || ''}`),
  openModal: value => { modal = value; },
});
vm.runInContext(html.slice(labelStart, renderEnd), context);
const display = vm.runInContext('_csGroupStatementLines(raw, 30)', context);
assert.deepEqual(Array.from(display, line => line.kind), [
  'collection-group', 'fees-group', 'payout', 'collection-group', 'fees-group',
]);
assert.equal(display[0].in, 300);
assert.equal(display[0].groupCount, 3);
assert.equal(display[1].out, 50);
assert.equal(display[1].groupCount, 3);
assert.equal(display.at(-1).balance, 175);
assert.equal(raw.length, 8, 'Grouping leaves the original order entries intact');
vm.runInContext("openCsStatementGroup('2026-11-02')", context);
assert(modal.includes('#A') && modal.includes('#B') && modal.includes('#C'));
assert(modal.includes('&lt;img&gt;'), 'Order names are escaped in the details');
assert(!modal.includes('<img>'));
vm.runInContext('renderCsStatement()', context);
assert.equal((statementHtml.match(/openCsStatementGroup\(this\.dataset\.date\)/g) || []).length, 4);
assert(statementHtml.includes('csLed_collectionGroup') && statementHtml.includes('csLed_feesGroup'));
assert(statementHtml.includes('PAY-1'), 'Transfer remains a separate row');
assert(!statementHtml.includes('#A'), 'Individual orders appear in the group details');
process.stdout.write('Bosta statement groups same-day orders and keeps payouts separate.\n');
