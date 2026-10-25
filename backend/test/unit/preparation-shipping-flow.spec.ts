import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = html.slice(html.indexOf('function _bsfIsBostaOrder('), html.indexOf('async function bulkSendToBosta('));
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const orders = [1, 2].map(n => ({_id: String(n), ref: '310' + n, client: 'Customer ' + n,
    carrierCode: 'Bosta', shippingAddress: 'Address', shippingGov: 'Cairo', phone: '01000000000'}));
  const context: any = {
    carrierIntegration: () => 'bosta', transactions: orders, _awbPrintsOf: () => [],
    _awbOrderCopies: (id: string) => orders.filter(o => o._id === id),
    _awbPrepareSoon: jest.fn(), _awbForget: jest.fn(), _pwScanFocus: jest.fn(), _pwSelId: '2',
    _pucoGetGroup: () => null, markMovRecentlyUpdated: jest.fn(), qs: () => null,
    window: {matchMedia: () => ({matches: true})}, setTimeout: jest.fn(),
    t: (key: string, params: any) => key === 'bsfPrepared' ? `Order #${params.ref} prepared successfully` : key,
    esc: String, _AWB_PRINTER_SVG: '', printBostaAwb: jest.fn(), api: jest.fn(),
  };
  runInNewContext(source, context);
  context._bsfRender = jest.fn();
  return {c: context, orders, state: () => runInNewContext('_bsfState', context)};
}

it('holds preparation through Send and preserves the original order identity', async () => {
  const {c, orders, state} = fixture();
  let sent: any;
  c.api.mockReturnValue(new Promise(resolve => {sent = resolve;}));
  let released = false;
  c._bsfMaybeOffer(orders[0]).then(() => {released = true;});
  const task = c._bsfSend();
  await turn();
  expect(released).toBe(false);
  expect(state().docked).toBeUndefined();
  expect(c._pwScanFocus).not.toHaveBeenCalled();
  expect(c.api.mock.calls[0][0]).toBe('/shipping/create-order/1');
  sent({bostaOrderId: 'shipment', trackingNumber: 'TR-1'});
  await task;
  expect(state().stage).toBe('sent');
  expect(orders[0]).toMatchObject({bostaOrderId: 'shipment', bostaTrackingNumber: 'TR-1'});
  expect((orders[1] as any).bostaOrderId).toBeUndefined();
  expect(released).toBe(false);
});

it('holds the current order while printing and permits retry after a cancelled or failed print', async () => {
  const {c, orders, state} = fixture();
  Object.assign(orders[0], {bostaOrderId:'shipment'});
  let complete: any;
  c.printBostaAwb.mockReturnValue(new Promise(resolve => {complete = resolve;}));
  let released = false;
  c._bsfMaybeOffer(orders[0]).then(() => {released = true;});
  const printing = c._bsfPrint(); await turn();
  expect(released).toBe(false);
  expect(state().stage).toBe('printing');
  expect(state().docked).toBeUndefined();
  complete(false); await printing;
  expect(state().stage).toBe('sent');
  expect(c.setTimeout).not.toHaveBeenCalled();
  expect(released).toBe(false);
});

it('shows a retryable shipping error without rolling back successful preparation', async () => {
  const {c, orders, state} = fixture();
  c.api.mockRejectedValue(new Error('Carrier unavailable'));
  c._bsfMaybeOffer(orders[0]); await c._bsfSend();
  expect(state()).toMatchObject({stage:'error', error:'Carrier unavailable'});
  c.api.mockResolvedValue({bostaOrderId:'shipment'}); await c._bsfSend();
  expect(state().stage).toBe('sent');
});

it('queues subsequent completed orders instead of silently dropping their shipment offer', async () => {
  const {c, orders, state} = fixture();
  c._bsfMaybeOffer(orders[0]);
  const next = c._bsfMaybeOffer(orders[1]);
  expect(c._bsfMaybeOffer(orders[1])).toBe(next);
  let released = false; next.then(() => {released = true;});
  c._bsfClose(); await turn();
  expect(state().id).toBe('2'); expect(released).toBe(false);
  c._bsfClose(); await turn(); expect(released).toBe(true);
});

it('shows the prepared reference in the success title with the customer underneath', () => {
  const {c, orders} = fixture();
  const content = c._bsfStageHtml({stage:'ask'}, orders[0]);
  expect(content).toContain('Order #3101 prepared successfully');
  expect(content).toContain('<div class="bsf-sub">Customer 1</div>');
});

it('waits for confirmed printing and the success scene before releasing the next order', async () => {
  const { c, orders, state } = fixture();
  Object.assign(orders[0], { bostaOrderId: 'shipment', bostaTrackingNumber: 'TR-1' });
  let result: any = 'pending';
  c._bsfMaybeOffer(orders[0]).then((printed: boolean) => { result = printed; });
  c.printBostaAwb.mockResolvedValue(true);
  await c._bsfPrint();
  expect(result).toBe('pending');
  expect(state().stage).toBe('printed');
  expect(c._bsfStageHtml(state(), orders[0])).toContain('bsf-ps-feed');
  expect(c.setTimeout).toHaveBeenCalledWith(expect.any(Function), 4300);
  c.setTimeout.mock.calls[0][0]();
  await turn();
  expect(result).toBe(true);
});

it('postponing shipping does not authorize automatic advancement', async () => {
  const { c, orders } = fixture();
  const decision = c._bsfMaybeOffer(orders[0]);
  c._bsfClose();
  await expect(decision).resolves.toBe(false);
});

it.each([false, true])('records a print only after the user confirms physical output (confirmed=%s)', async confirmed => {
  const c: any = {
    currentLang: 'en', showConfirm: jest.fn().mockResolvedValue(confirmed),
    _awbPrinting: false, _awbPrintsOf: () => [],
    _awbPrepare: jest.fn().mockResolvedValue({ pages: [] }), _awbPrintInFrame: jest.fn().mockResolvedValue(undefined),
    _awbPrepared: new Map(), _awbRecordPrint: jest.fn(), _awbBusy: jest.fn(),
    setTimeout: jest.fn(), clearTimeout: jest.fn(), toast: jest.fn(), t: String
  };
  runInNewContext(html.slice(html.indexOf('function _awbConfirmPrinted('), html.indexOf('/* ══ AWB print log')), c);
  await expect(c.printBostaAwb('1')).resolves.toBe(confirmed);
  expect(c._awbRecordPrint).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  expect(c.showConfirm).toHaveBeenCalledTimes(1);
});

it('keeps confirmation hidden until the print preview closes', async () => {
  let closePreview: any;
  const c: any = {
    currentLang: 'en', showConfirm: jest.fn().mockResolvedValue(true),
    _awbPrinting: false, _awbPrintsOf: () => [],
    _awbPrepare: async () => ({ pages: [] }),
    _awbPrintInFrame: () => new Promise(resolve => { closePreview = resolve; }),
    _awbPrepared: new Map(), _awbRecordPrint: jest.fn(), _awbBusy: jest.fn(),
    setTimeout: jest.fn(), clearTimeout: jest.fn(), toast: jest.fn(), t: String
  };
  runInNewContext(html.slice(html.indexOf('function _awbConfirmPrinted('), html.indexOf('/* ══ AWB print log')), c);
  const printing = c.printBostaAwb('1');
  await turn();
  expect(c.showConfirm).not.toHaveBeenCalled();
  expect(c._awbRecordPrint).not.toHaveBeenCalled();
  closePreview();
  await printing;
  expect(c.showConfirm).toHaveBeenCalledWith('Label printed?', expect.objectContaining({
    confirmLabel: 'Yes, printed', cancelLabel: 'No, again'
  }));
});

it('waits for afterprint even when print returns immediately and preview stays open', async () => {
  let afterprint: any;
  const fr: any = {
    setAttribute: jest.fn(), style: {}, remove: jest.fn(),
    contentDocument: { open() {}, write() {}, close() {}, images: [] },
    contentWindow: { addEventListener: (_event: string, callback: any) => { afterprint = callback; }, focus() {}, print: jest.fn() }
  };
  const c: any = {
    document: { createElement: () => fr, body: { appendChild() {} } },
    _awbLabelHtml: () => '', setTimeout: jest.fn()
  };
  runInNewContext(html.slice(html.indexOf('function _awbPrintInFrame('), html.indexOf('function _awbBusy(')), c);
  let completed = false;
  const printing = c._awbPrintInFrame({}).then(() => { completed = true; });
  await turn();
  expect(fr.contentWindow.print).toHaveBeenCalled();
  expect(completed).toBe(false);
  expect(c.setTimeout).not.toHaveBeenCalled();
  afterprint();
  await printing;
  expect(completed).toBe(true);
});

it('waits for return from the fallback PDF tab before asking for confirmation', async () => {
  let focused = true;
  let check: any;
  const c: any = {
    document: { hidden: false, hasFocus: () => focused, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval: (callback: any) => { check = callback; return 1; }, clearInterval: jest.fn()
  };
  runInNewContext(html.slice(html.indexOf('function _awbWaitForLabelTab('), html.indexOf('function _awbConfirmPrinted(')), c);
  let completed = false;
  const waiting = c._awbWaitForLabelTab({ closed: false }).then(() => { completed = true; });
  check(); await turn(); expect(completed).toBe(false);
  focused = false; check(); await turn(); expect(completed).toBe(false);
  focused = true; check(); await waiting; expect(completed).toBe(true);
});

it.each([1, 2])('keeps completed orders in preparation and advances only after successful print (group size=%s)', async count => {
  const orders = Array.from({ length: count }, (_, i) => ({ _id: String(i + 1), items: [{ lineId: 'line', qty: 1 }], prepChecked: false }));
  const group = { prepRef: 'group', orders };
  let printed: any;
  const c: any = {
    _pickupOrders: orders, _puPrepGroups: [group], _pucoColType: 'prep', _pucoGroupKey: 'group', _pwSelId: '1',
    qs: () => null, CSS: { escape: String }, window: { matchMedia: () => ({ matches: true }) },
    _pwEnsurePickLines: jest.fn(), api: jest.fn().mockResolvedValue({ lines: [{ lineId: 'line', qty: 1, units: [{ status: 'prepared' }] }] }),
    _pwIncompletePickLines: () => [], _pwPickState: () => ({}), _pwLoadPickSummary: jest.fn(),
    _puSetLocalPrepChecked: (id: string, checked: boolean) => { orders.find(o => o._id === id)!.prepChecked = checked; },
    _puPersistPrepCheck: jest.fn().mockResolvedValue(undefined), _bsfIsBostaOrder: () => true,
    _bsfMaybeOffer: () => new Promise(resolve => { printed = resolve; }), _pwFlipRender: jest.fn(),
    _pwOrderForDisplay: (rows: any[]) => rows, _pwNextPending: (rows: any[]) => rows.find(o => !o.prepChecked),
    pwSelectOrder: jest.fn(), _pucoUpdateProgress: jest.fn(), _puUpdatePrepGroupProgress: jest.fn(), _puSavePrepGroups: jest.fn(),
    closePuCardOrdersModal: jest.fn(), prepGroupMoveToReady: jest.fn()
  };
  runInNewContext(html.slice(html.indexOf('async function _pucoTickOrderImpl('), html.indexOf('let _pucoAddSuggestIdx')), c);
  await c._pucoTickOrderImpl('1', true);
  expect(orders[0].prepChecked).toBe(true);
  expect(c._pucoUpdateProgress).toHaveBeenCalledWith(group);
  expect(c.pwSelectOrder).not.toHaveBeenCalled();
  printed(true); await turn();
  expect(c.pwSelectOrder).toHaveBeenCalledTimes(count === 2 ? 1 : 0);
  expect(c.closePuCardOrdersModal).not.toHaveBeenCalled();
  expect(c.prepGroupMoveToReady).not.toHaveBeenCalled();
});
