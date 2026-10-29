import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from '../pickup-authorized-context';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const groupsSource = html.slice(html.indexOf('function _puSavePrepGroups('), html.indexOf('// ── Generate a unified group reference:'));
const liveSource = html.slice(html.indexOf('let _puOrdersRequest = null;'), html.indexOf('let _puBostaSyncRunning = false;'));
const order = (id: string, pickupStatus = 'Preparing', pickupRef: string | null = 'PREP') => ({
  _id: id, type: 'مبيعات', pickupStatus, pickupRef, items: [], total: 100,
});

function fixture(transactions: any[], pickupOrders: any[] = []) {
  const c: any = {
    transactions, _pickupOrders: pickupOrders, _puPrepGroups: [],
    _PU_PREP_LS_KEY: 'prep', localStorage: { getItem: () => null, setItem: jest.fn() },
    _puDirtyCards: new Set(), _pwBarcodePickStates: new Map(), window: {},
    _rtFetchTx: jest.fn(), _rtRefreshUI: jest.fn(), _rtToastEvent: jest.fn(),
    currentPage: 'movements', t: String, esc: String, setTimeout: jest.fn(), clearTimeout: jest.fn(),
  };
  runInNewContext(groupsSource + '\n' + liveSource, c);
  return c;
}

it('does not clear other Preparing transactions when a single live row rebuilds a partial group list', () => {
  const c = fixture([order('one'), order('two')]);
  c._puMergeLiveTransaction(order('one'));
  c._puSavePrepGroups();
  expect(c.transactions.map((o: any) => o.pickupStatus)).toEqual(['Preparing', 'Preparing']);
  expect(c.transactions[1].pickupRef).toBe('PREP');
});

it('keeps a Preparing event visible before the pickup page has fetched that order', () => {
  const c = fixture([order('one', 'Pending', null), order('two')]);
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'preparing', pickupRef: 'NEW' });
  expect(c.transactions[0]).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'NEW' });
  expect(c.transactions[1].pickupStatus).toBe('Preparing');
  expect(c._rtFetchTx).toHaveBeenCalledWith('one');
});

it('does not resurrect stale group membership over fresh Pending or Ready transactions', () => {
  const c = fixture([order('one', 'Pending', null), order('two', 'Ready', 'RUN')]);
  c._puPrepGroups = [{ prepRef: 'OLD', orders: [order('one'), order('two')] }];
  for (let i = 0; i < 3; i++) c._puSavePrepGroups();
  expect(c.transactions[0]).toMatchObject({ pickupStatus: 'Pending', pickupRef: null });
  expect(c.transactions[1]).toMatchObject({ pickupStatus: 'Ready', pickupRef: 'RUN' });
});

it('does not infer Pending when a server Preparing row has no group reference', () => {
  const c = fixture([order('one', 'Preparing', null)]);
  c._puLoadPrepGroups([order('one', 'Preparing', null)]);
  c._puSavePrepGroups();
  expect(c.transactions[0].pickupStatus).toBe('Preparing');
});

it('mirrors only explicitly confirmed local changes, including removal without a socket echo', () => {
  const c = fixture([order('one'), order('two'), order('three', 'Pending', null)]);
  c._puPrepGroups = [{ prepRef: 'PREP', orders: [order('two')] }];
  c._puSavePrepGroups([{ ...order('one', 'Pending', null), prepChecked: false }, order('three', 'Preparing', 'NEW')]);
  expect(c.transactions[0]).toMatchObject({ pickupStatus: 'Pending', pickupRef: null, prepChecked: false });
  expect(c.transactions[1]).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'PREP' });
  expect(c.transactions[2]).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'NEW' });
});

it('keeps a new Preparing event when an older initial pickup response arrives', async () => {
  const c = fixture([order('one', 'Pending', null)]);
  let release: any;
  Object.assign(c, {
    api: jest.fn(() => new Promise(resolve => { release = resolve; })), qs: () => null,
    _puPopulateShipCoFilter: jest.fn(), _puPaintCurrentView: jest.fn(), buildSidebar: jest.fn(),
    _puRefreshSecondary: jest.fn(), _pucoGroupKey: null, renderMovements: jest.fn(), toast: jest.fn(),
  });
  const loading = c.loadPickupOrders();
  c._puApplyRealtimeEvent({ ids: ['one'], action: 'preparing', pickupRef: 'NEW' });
  release([order('one', 'Pending', null)]);
  await loading;
  expect(c.transactions[0]).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'NEW' });
  expect(c._pickupOrders[0]).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'NEW' });
});

it.each([true, false])('updates selected orders only after preparation is accepted (accepted=%s)', async accepted => {
  const c = fixture([order('one', 'Pending', null), order('two')], [order('one', 'Pending', null)]);
  Object.assign(c, {
    _puPendingSelected: new Set(['one']), _genPrepRef: () => 'NEW', currentUser: { name: 'Admin' },
    api: accepted ? jest.fn().mockResolvedValue({ updated: 1 }) : jest.fn().mockRejectedValue(Error('offline')),
    toast: jest.fn(), fmtN: String, loadPickupOrders: jest.fn(), renderPickupBoard: jest.fn(),
  });
  runInNewContext(html.slice(html.indexOf('async function puPtMoveSelected('), html.indexOf('// ── Build a group card DOM element')), c);
  await c.puPtMoveSelected();
  expect(c.transactions[0].pickupStatus).toBe(accepted ? 'Preparing' : 'Pending');
  expect(c.transactions[1].pickupStatus).toBe('Preparing');
});

it('mirrors confirmed Ready transitions without waiting for a socket or a background reload', async () => {
  const row = order('one');
  const c = fixture([{ ...row }, order('two')], [row]);
  const modal = { dataset: { prepRef: 'PREP' } };
  Object.assign(c, {
    _puConfirmGroupIds: ['one'], _puPrepGroups: [{ prepRef: 'PREP', orders: [row] }],
    qs: (selector: string) => selector === '#pu-confirm-modal' ? modal : null,
    todayLocalISO: () => '2026-10-29', currentUser: { name: 'Admin' },
    api: jest.fn().mockResolvedValue({ updated: 1, pickupRef: 'RUN' }), toast: jest.fn(), fmtN: String,
    closePuConfirmModal: jest.fn(), _puMarkLanding: jest.fn(), renderPickupBoard: jest.fn(),
  });
  runInNewContext(html.slice(html.indexOf('async function puConfirmMoveToReady('), html.indexOf('// ── SVG icon helpers')), c);
  await c.puConfirmMoveToReady();
  expect(c.transactions[0]).toMatchObject({ pickupStatus: 'Ready', pickupRef: 'RUN', pickupDate: '2026-10-29' });
  expect(c.transactions[1].pickupStatus).toBe('Preparing');
});
