import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = html.slice(html.indexOf('async function _runWithConcurrency('), html.indexOf('/**', html.indexOf('async function _confirmBulkSendShopify()')));

function fixture() {
  const nodes = new Map<string, any>();
  for (const id of ['sp-bulk-progress', 'sp-bulk-progress-fill', 'sp-bulk-completed', 'sp-bulk-ok', 'sp-bulk-failed', 'sp-bulk-status']) {
    nodes.set('#' + id, { textContent: '', style: {}, setAttribute: jest.fn() });
  }
  const orders = Array.from({ length: 7 }, (_, i) => ({ _id: String(i), ref: String(2800 + i), items: [{ qty: 2 }], status: 'pending' }));
  const modal = { _running: false, _sendable: orders.map(order => ({ order })), querySelector: () => ({ innerHTML: '' }) };
  nodes.set('#sp-bulk-confirm-modal', modal);
  nodes.set('#spb-carrier', { value: 'bosta' });
  const endBatch = jest.fn();
  const result = jest.fn();
  const group = jest.fn(async (_ids: string[], _choice: any) => ({ prepRef: 'PREP-1' }));
  let active = 0, maxActive = 0;
  const api = jest.fn(async (url: string) => {
    if (!url.endsWith('/approve')) return [];
    active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    if (url.includes('/1/')) throw Error('stock changed');
    return { success: true, txId: 'tx-' + url.split('/')[3] };
  });
  const selected = new Set(orders.map(o => o._id));
  const context: any = {
    qs: (selector: string) => nodes.get(selector),
    t: (key: string) => key,
    tf: (key: string, values: any) => key + ':' + JSON.stringify(values), esc: (value: string) => value,
    SP_CONFIRM_ICON: '', requestAnimationFrame: (fn: () => void) => fn(),
    window: { txNotifier: { beginBatch: () => endBatch, suppressCreated: jest.fn() } },
    _sppReadChoice: () => ({ on: true }), _sppCommit: group,
    _spDepositOf: () => ({ byMethod: { cash: 10 } }), _shopifySelectedIds: selected,
    api, _spShowBulkResult: result, loadShopifyOrders: jest.fn(async () => {}),
    _rtRefreshUI: jest.fn(), currentPage: 'shopify-orders', txItems: [], _txSaving: false,
  };
  runInNewContext(source, context);
  return { context, modal, nodes, selected, api, result, group, endBatch, maxActive: () => maxActive };
}

it('settles every attempt, keeps failed selections and prevents duplicate submissions', async () => {
  const env = fixture();
  const running = env.context._confirmBulkSendShopify();
  await env.context._confirmBulkSendShopify();
  await running;
  expect(env.api.mock.calls.filter(([url]) => url.endsWith('/approve'))).toHaveLength(7);
  expect(env.maxActive()).toBe(4);
  expect(env.nodes.get('#sp-bulk-completed').textContent).toBe('7');
  expect(env.nodes.get('#sp-bulk-progress').setAttribute).toHaveBeenLastCalledWith('aria-valuenow', '7');
  expect(env.nodes.get('#sp-bulk-progress-fill').style.transform).toBe('scaleX(1)');
  expect([...env.selected]).toEqual(['1']);
  expect(env.result).toHaveBeenCalledWith(env.modal, expect.objectContaining({ okCount: 6, total: 7, items: 12, errors: [expect.stringContaining('stock changed')] }));
  expect(env.group.mock.calls[0][0]).toHaveLength(6);
  expect(env.api.mock.calls.filter(([url]) => url === '/transactions/inventory')).toHaveLength(1);
  expect(env.endBatch).toHaveBeenCalledTimes(1);
  expect(env.modal._running).toBe(false);
  expect(env.context.window._souliaShopifyBatch).toBeNull();
});
