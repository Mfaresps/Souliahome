const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('async function _spDepRunBulkApprove(');
assert(start >= 0);
const source = html.slice(start, html.indexOf('\n}', start) + 2);

(async () => {
  const button = { disabled: false };
  const started = [];
  const pending = new Map();
  const approved = [];
  const toasts = [];
  let refreshed = 0;
  let reloaded = 0;
  const context = {
    qs: selector => selector === '#spdep-bulk-go' ? button : null,
    _spReceiptBusy: new Set(),
    _spDepSelectedIds: new Set(),
    api: url => {
      const id = url.match(/deposit-receipts\/([^/]+)\/approve$/)?.[1];
      started.push(id);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    _spApplyApprovedReceipt: (_orderId, receiptId) => approved.push(receiptId),
    _spRefreshReceiptViews: () => { refreshed++; },
    _spRefreshAfterReceiptApproval: () => { reloaded++; },
    toast: (...args) => toasts.push(args),
    tf: (_key, values) => values,
    fmtN: String,
  };
  vm.runInNewContext(`${source}\nthis.run = _spDepRunBulkApprove;`, context);
  const picked = [
    { o: { _id: 'a' }, r: { id: 'a1' } },
    { o: { _id: 'a' }, r: { id: 'a2' } },
    ...['b', 'c', 'd', 'e'].map(id => ({ o: { _id: id }, r: { id } })),
  ];
  const run = context.run(picked);
  assert.deepEqual(started, ['a1', 'b', 'c', 'd'], 'four orders start together, but a2 waits for a1');
  assert.equal(button.disabled, true);

  pending.get('a1').resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b', 'c', 'd', 'a2'], 'second receipt on the same order starts only after the first finishes');

  pending.get('b').reject(new Error('approval failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b', 'c', 'd', 'a2', 'e'], 'a failed order does not stop other orders');

  for (const id of ['c', 'd', 'a2', 'e']) pending.get(id).resolve({ success: true });
  await run;
  assert.deepEqual(approved.sort(), ['a1', 'a2', 'c', 'd', 'e']);
  assert.equal(context._spReceiptBusy.size, 0);
  assert.equal(refreshed, 1);
  assert.equal(reloaded, 1);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], true, 'partial failure remains visible');
  assert.equal(toasts[0][0].done, '5');
  assert.equal(toasts[0][0].failed, '1');
  console.log('PASS: bulk approval runs four orders concurrently, serializes receipts per order, and reports partial failure');
})().catch(error => { console.error(error); process.exitCode = 1; });
