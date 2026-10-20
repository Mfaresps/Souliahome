import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = html.slice(html.indexOf('let _puOrdersRequest = null;'), html.indexOf('let _puBostaSyncRunning = false;'));
const order = (extra = {}) => ({ _id: 'one', type: 'مبيعات', pickupStatus: 'Pending', total: 100, items: [{ qty: 1, price: 100 }], ...extra });
function fixture(rows: any[] = []) {
  const state = { hidden: true, textContent: '', innerHTML: '', dataset: {} };
  const column = { scrollTop: 130 };
  const render = jest.fn();
  const context: any = {
    _pickupOrders: rows, transactions: rows.map(row => ({ ...row })), _puDirtyCards: new Set(),
    _puBoardView: 'board', _pucoGroupKey: null, _pwSelId: 'one', currentPage: 'pickup-orders', _pickupPage: 3,
    _puLoadPrepGroups: jest.fn(), _puSavePrepGroups: jest.fn(), _puPopulateShipCoFilter: jest.fn(),
    _puSyncPrepStatusToTransactions: jest.fn(), renderPickupBoard: render,
    renderPickupRuns: jest.fn(), renderReadyToShipTable: jest.fn(), buildSidebar: jest.fn(),
    api: jest.fn(), refreshBostaPickupRequests: jest.fn(() => new Promise(() => {})),
    _puSyncShippedBostaStatuses: jest.fn(), _pwBarcodePickStates: new Map(),
    _rtFetchTx: jest.fn(), _rtRefreshUI: jest.fn(), _rtToastEvent: jest.fn(), toast: jest.fn(),
    _pucoGetGroup: jest.fn(), _pucoRenderOrders: jest.fn(), _pucoUpdateProgress: jest.fn(), closePuCardOrdersModal: jest.fn(),
    document: { querySelectorAll: () => [column], activeElement: null },
    qs: (selector: string) => selector === '#pu-load-state' ? state : null,
    window: {}, setTimeout, clearTimeout, Date, t: (key: string) => key, esc: (value: string) => value,
  };
  runInNewContext(source, context);
  return { context, render, state, column };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('renders primary data without waiting for Bosta, deduplicates requests and keeps pagination', async () => {
  const { context: c, state, render, column } = fixture();
  let release: any;
  c.api.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const first = c.loadPickupOrders();
  expect(c.loadPickupOrders()).toBe(first);
  expect(state.hidden).toBe(false);
  release([order()]); await first;
  expect(c.api).toHaveBeenCalledTimes(1);
  expect(c.refreshBostaPickupRequests).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledTimes(1);
  expect(state.hidden).toBe(true);
  expect(c._pickupPage).toBe(3);
  expect(column.scrollTop).toBe(130);
});

it('does not regress a live Ready transition when an older snapshot arrives', async () => {
  const { context: c } = fixture([order()]);
  let release: any;
  c.api.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const request = c.loadPickupOrders();
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'ready', pickupRef: 'RUN' });
  release([order()]); await request;
  expect(c._pickupOrders[0].pickupStatus).toBe('Ready');
  expect(c.transactions[0].pickupRef).toBe('RUN');
});

it('does not resurrect a cancelled or deleted order from an in-flight snapshot', async () => {
  const { context: c } = fixture([order()]);
  let release: any;
  c.api.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const request = c.loadPickupOrders();
  c._puMergeLiveTransaction({ _id: 'one' }, true);
  release([order()]); await request;
  expect(c._pickupOrders).toHaveLength(0);
});

it('updates all pickup stages and history, coalescing a burst into one paint', () => {
  const { context: c, render } = fixture([order()]);
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'preparing', pickupRef: 'PREP', groupMeta: { prepNote: 'Fragile' } });
  expect(c._pickupOrders[0].prepNote).toBe('Fragile');
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'prepCheck', prepChecked: true, pickupHistory: [{ action: 'prep-check' }] });
  expect(c.transactions[0].prepChecked).toBe(true);
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'ready', pickupRef: 'RUN' });
  expect(c._pickupOrders[0].pickupStatus).toBe('Ready');
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'undo' });
  expect(c._pickupOrders[0]).toMatchObject({ pickupStatus: 'Pending', pickupRef: null, prepChecked: false });
  jest.advanceTimersByTime(80);
  expect(render).toHaveBeenCalledTimes(1);
});

it('merges transaction edits while preserving local item drafts and detecting real conflicts', () => {
  const { context: c } = fixture([order()]);
  c._puRememberDraft(c._pickupOrders[0]);
  c._puDirtyCards.add('one');
  c._pickupOrders[0].items = [{ qty: 2, price: 100 }]; c._pickupOrders[0].total = 200;
  c._puMergeLiveTransaction(order({ client: 'Updated name' }));
  expect(c._pickupOrders[0]).toMatchObject({ client: 'Updated name', total: 200 });
  expect(runInNewContext('_puRemoteConflicts.size', c)).toBe(0);
  c._puMergeLiveTransaction(order({ total: 300 }));
  expect(c._pickupOrders[0].total).toBe(200);
  expect(runInNewContext('_puRemoteConflicts.has("one")', c)).toBe(true);
});

it('does not flag the saving operator\'s own socket echo as a conflicting edit', () => {
  const { context: c } = fixture([order()]);
  c._puRememberDraft(c._pickupOrders[0]); c._puDirtyCards.add('one');
  c._pickupOrders[0].total = 200;
  c._puMergeLiveTransaction(order({ total: 200 }));
  expect(runInNewContext('_puRemoteConflicts.size', c)).toBe(0);
});

it('keeps scanner input and selection intact until typing finishes', () => {
  const { context: c, render } = fixture([order()]);
  const focus = { matches: () => true, closest: (selector: string) => selector.includes('#pu-card-orders-modal'), addEventListener: jest.fn() };
  c.document.activeElement = focus;
  c._pucoGroupKey = 'PREP'; c._pucoGetGroup.mockReturnValue({ orders: c._pickupOrders });
  c._puMergeLiveTransaction(order({ client: 'Updated' }));
  jest.advanceTimersByTime(80);
  expect(render).toHaveBeenCalledTimes(1);
  expect(c._pucoRenderOrders).not.toHaveBeenCalled();
  c.document.activeElement = null;
  focus.addEventListener.mock.calls[0][1]();
  jest.advanceTimersByTime(80);
  expect(c._pucoRenderOrders).toHaveBeenCalledTimes(1);
});

it('retains displayed data on refresh failure and offers retry after initial failure', async () => {
  const { context: c, state } = fixture();
  c.api.mockRejectedValueOnce(Error('offline'));
  await c.loadPickupOrders();
  expect(state.innerHTML).toContain('loadFailedRetry');
  c.api.mockResolvedValueOnce([order()]); await c.loadPickupOrders();
  c.api.mockRejectedValueOnce(Error('offline')); await c.loadPickupOrders();
  expect(c._pickupOrders).toHaveLength(1);
  expect(state.hidden).toBe(true);
});

it('updates the workspace with an idle scanner focused and restores its focus', () => {
  const { context: c } = fixture([order()]);
  const scanner = { id: 'pw-order-scan', value: '', matches: () => true, closest: () => null, focus: jest.fn() };
  c.document.activeElement = scanner; c.CSS = { escape: (text: string) => text };
  c.qs = (selector: string) => selector === '#pw-order-scan' ? scanner : null;
  c._pucoGroupKey = 'PREP'; c._pucoGetGroup.mockReturnValue({ orders: c._pickupOrders });
  c._puQueueLivePaint(); jest.advanceTimersByTime(80);
  expect(c._pucoRenderOrders).toHaveBeenCalledTimes(1);
  expect(scanner.focus).toHaveBeenCalledWith({ preventScroll: true });
});

it('closes a group removed remotely even while its search field has focus', () => {
  const { context: c } = fixture([order()]);
  c.document.activeElement = { matches: () => true, closest: () => true };
  c._pucoGroupKey = 'REMOVED'; c._pucoGetGroup.mockReturnValue(null);
  c._puQueueLivePaint(); jest.advanceTimersByTime(80);
  expect(c.closePuCardOrdersModal).toHaveBeenCalledTimes(1);
});
