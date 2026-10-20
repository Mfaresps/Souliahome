import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = html.slice(html.indexOf('let _spOrdersRequest = null;'), html.indexOf('function switchShopifyTab('));

function fixture(existing: any[] = []) {
  const host = { clientWidth: 1000, dataset: { layout: 'cards' }, setAttribute: jest.fn() };
  const loading = { hidden: true, innerHTML: '', dataset: { state: '' }, setAttribute: jest.fn() };
  const api = jest.fn<Promise<any[]>, any[]>();
  const render = jest.fn();
  const context: any = {
    qs: (selector: string) => selector === '#sp-orders-tab-content' ? host : selector === '#sp-orders-loading' ? loading : null,
    _shopifyOrders: existing, _initShopifySubnav: jest.fn(), _getHiddenSpCols: () => new Set(),
    SP_COL_W_FIXED: 34, SP_COL_W: { ref: 132, total: 128 }, api,
    t: (key: string) => key, esc: (value: string) => value,
    _spkRender: jest.fn(), _spSyncAuditPaymentRows: jest.fn(), _spRefreshReceiptViews: jest.fn(),
    renderShopifyOrders: render, buildSidebar: jest.fn(), localStorage: { getItem: () => 'seen' },
    _spSubnavTab: 'orders', console: { error: jest.fn() },
    document: { getElementById: () => null },
  };
  runInNewContext(source, context);
  return { context, host, loading, api, render };
}

it('deduplicates order requests and treats an empty result as a loaded page', async () => {
  const env = fixture();
  let release: (orders: any[]) => void = () => {};
  env.api.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const first = env.context.loadShopifyOrders();
  expect(env.loading.hidden).toBe(false);
  expect(env.loading.innerHTML).toContain('sp-orders-loading-cards');
  expect(env.context.loadShopifyOrders()).toBe(first);
  release([]); await first;
  expect(env.api).toHaveBeenCalledTimes(1);
  expect(env.loading.hidden).toBe(true);
  env.api.mockResolvedValueOnce([]);
  const next = env.context.loadShopifyOrders();
  expect(env.loading.hidden).toBe(true);
  await next;
  expect(env.render).toHaveBeenCalledTimes(2);
});

it('keeps already displayed data when a background refresh fails', async () => {
  const orders = [{ _id: 'one', status: 'pending', ref: '2859' }];
  const env = fixture(orders);
  env.api.mockRejectedValueOnce(Error('offline'));
  await env.context.loadShopifyOrders();
  expect(env.context._shopifyOrders).toBe(orders);
  expect(env.loading.hidden).toBe(true);
  expect(env.host.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'false');
});

it('shows a retry state for an initial failure and permits a successful retry', async () => {
  const env = fixture();
  env.api.mockRejectedValueOnce(Error('offline'));
  await env.context.loadShopifyOrders();
  expect(env.loading.dataset.state).toBe('error');
  expect(env.loading.innerHTML).toContain('loadFailedRetry');
  env.api.mockResolvedValueOnce([{ _id: 'one', status: 'pending' }]);
  await env.context.loadShopifyOrders();
  expect(env.loading.hidden).toBe(true);
  expect(env.context._shopifyOrders).toHaveLength(1);
});

it('uses available content width and a hysteresis band to avoid scrollbar-driven oscillation', () => {
  const { context, host } = fixture();
  host.clientWidth = 1300; expect(context._spEnsureOrdersLayout()).toBe('table');
  host.clientWidth = 1270; expect(context._spEnsureOrdersLayout()).toBe('table');
  host.clientWidth = 1240; expect(context._spEnsureOrdersLayout()).toBe('cards');
  host.clientWidth = 1270; expect(context._spEnsureOrdersLayout()).toBe('cards');
  host.clientWidth = 1300; expect(context._spEnsureOrdersLayout()).toBe('table');
});
