import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = readFileSync(resolve(__dirname, '../../../frontend/public/pickup-daily-shipping.js'), 'utf8');
const grab = (name: string) => html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))![0];
function fixture() {
  const context: any = { currentLang: 'en', document: {}, _puReturnGroupBusy: false, qsa: () => [],
    _bostaPickupRequestsKnown: true, _bostaPickupRequests: [], _bostaPickupRequestsState: 'ready',
    esc: value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    fmtJT: value => 'EGP ' + value,
  };
  runInNewContext(grab('_puCanViewShipmentTotals') + '\n' + grab('_puShippingReceivedRef') + '\n' + grab('_puDisplayStatus') + '\n' + source + '\n' + grab('_buildPickupRuns'), context);
  return context;
}
const order = (id: string, extra: any = {}) => ({ _id: id, shipCo: 'Bosta', pickupStatus: 'Ready',
  bostaOrderId: 'b-' + id, bostaStatus: 'CREATED', total: 500,
  shipmentEvents: [{ type: 'sent', at: '2026-10-21T08:00:00Z', bostaOrderId: 'b-' + id }], ...extra });

it.each(['admin', 'manager', 'staff', 'viewer', 'unknown', undefined])('restricts shipment aggregates for role %s', role => {
  const c = fixture();
  c.currentUser = role ? { role, perms: ['movements', 'reports'] } : null;
  c.document.createElement = () => ({ dataset: {}, addEventListener() {}, innerHTML: '' });
  const allowed = role === 'admin' || role === 'manager';
  const group = c._puDailyShippingGroups([order('a'), order('b')])[0];
  const card = c._puDailyGroupCard(group);
  const row = c._puDailyRunRowHtml(group, 0, false).split('</tr>')[0];
  expect(c._puCanViewShipmentTotals()).toBe(allowed);
  expect(card.innerHTML.includes('EGP 1000')).toBe(allowed);
  expect(card.innerHTML.includes('Group total')).toBe(allowed);
  expect(row.includes('EGP 1000')).toBe(allowed);
  expect(row.includes('<td hidden></td>')).toBe(!allowed);
});

it('clears a previously rendered aggregate when switching to a restricted role', () => {
  const c = fixture();
  const element = { hidden: false, textContent: '' };
  c.qs = () => element;
  runInNewContext(grab('_puSetShipmentTotal'), c);
  for (const role of ['admin', 'staff', 'manager', 'viewer']) {
    c.currentUser = { role };
    c._puSetShipmentTotal('pu-shipped-col-amt', 1000);
    const allowed = role === 'admin' || role === 'manager';
    expect(element.hidden).toBe(!allowed);
    expect(element.textContent).toBe(allowed ? 'EGP 1000' : '');
  }
});

it('combines the same carrier and Cairo dispatch day across original preparation references and stages', () => {
  const c = fixture();
  const rows = [order('a', { pickupRef: 'OLD-1' }), order('b', { pickupRef: 'OLD-2', pickupStatus: 'Shipped', bostaStatus: 'IN_TRANSIT' }),
    order('c', { pickupStatus: 'Delivered', bostaStatus: 'DELIVERED' })];
  const group = c._puDailyShippingGroups(rows);
  expect(group).toHaveLength(1); expect(group[0].orders).toHaveLength(3);
  expect(group[0].pickupDate).toBe('2026-10-21');
  expect(rows[0].pickupStatus).toBe('Ready'); expect(rows[0].pickupRef).toBe('OLD-1');
  const runs = c._buildPickupRuns(rows);
  expect(runs).toHaveLength(2);
  expect(runs.find(run => run.pickupRef === 'OLD-1').orders.map(o => o._id)).toEqual(['a']);
  expect(runs.find(run => run.isDailyShipping).orders.map(o => o._id)).toEqual(['b', 'c']);
});

it('keeps all 30 Ready ticket members and the same total across board and table, including an unregistered order', () => {
  const c = fixture();
  c._puDateStr = value => String(value || '').slice(0, 10);
  runInNewContext(grab('_puBuildGroups'), c);
  const rows = Array.from({ length: 29 }, (_, i) => order(String(i), {
    pickupRef: '105-22OCT', pickupDate: '2026-10-23', date: '2026-10-22',
    total: i === 0 ? 52848 : 0,
    shipmentEvents: [{ type: 'sent', at: i === 0 ? '2026-10-22T08:00:00Z' : '2026-10-23T08:00:00Z' }],
  }));
  rows.push(order('unregistered', { pickupRef: '105-22OCT', pickupDate: '2026-10-23', date: '2026-10-22',
    bostaOrderId: '', bostaStatus: '', shipmentEvents: [], total: 1450 }));
  const board = c._puBuildGroups(rows)[0];
  const runs = c._buildPickupRuns(rows);
  expect(runs).toHaveLength(1);
  expect(runs[0].pickupRef).toBe(board.pickupRef);
  expect(runs[0].orders).toHaveLength(30);
  expect(runs[0].orders.map(o => o._id).sort()).toEqual(board.orders.map(o => o._id).sort());
  expect(runs[0].orders.reduce((sum, o) => sum + o.total, 0)).toBe(54298);
  expect(runs[0].isDailyShipping).toBeUndefined();
});

it('uses Cairo midnight and the current shipment registration rather than invoice date or collection day', () => {
  const c = fixture();
  const original = order('a', { date: '2026-09-01', shippedAt: '2026-10-24T08:00:00Z', pickupDate: '2026-10-24',
    shipmentEvents: [{ type: 'sent', at: '2026-10-21T21:30:00Z', bostaOrderId: 'b-a' }] });
  expect(c._puDailyShippingGroups([original])[0].pickupDate).toBe('2026-10-22');
  original.bostaOrderId = 'new';
  original.shipmentEvents.push({ type: 'resent', at: '2026-10-23T08:00:00Z', bostaOrderId: 'new' });
  expect(c._puDailyShippingGroups([original])[0].pickupDate).toBe('2026-10-23');
});

it('keeps different days and carriers apart and does not invent a dispatch date from invoice date', () => {
  const c = fixture();
  const unknown = order('d', { shipmentEvents: [], date: '2026-01-01' });
  const groups = c._puDailyShippingGroups([order('a'), order('b', { shipCo: 'Other' }),
    order('c', { shipmentEvents: [{ type: 'sent', at: '2026-10-22T08:00:00Z' }] }), unknown]);
  expect(groups).toHaveLength(4);
  expect(groups.at(-1).pickupDate).toBe('');
  expect(c._puDailyDateLabel(groups.at(-1))).toBe('Dispatch date not recorded');
});

it('excludes unregistered ready/manual orders, deduplicates identities and preserves manual runs', () => {
  const c = fixture();
  const manual = order('m', { deliverySource: 'MANUAL', pickupRef: 'MANUAL', pickupStatus: 'Shipped' });
  const ready = { _id: 'r', pickupStatus: 'Ready', pickupRef: 'READY' };
  const rows = [order('a'), order('a'), ready, manual];
  expect(c._puDailyShippingGroups(rows)[0].orders).toHaveLength(1);
  expect(c._buildPickupRuns(rows)).toHaveLength(3);
});

it('shows confirmed, pending and uncovered pickup counts without counting duplicate requests twice', () => {
  const c = fixture();
  c._bostaPickupRequests = [
    { status: 'created', orderIds: ['a'], scheduledDate: '2026-10-22' },
    { status: 'created', orderIds: ['a'] }, { status: 'pending', orderIds: ['b'] }, { status: 'rejected', orderIds: ['c'] },
  ];
  const result = c._puDailyPickupHtml([order('a'), order('b'), order('c'), order('d')]);
  expect(result).toContain('Pickup request sent to Bosta');
  expect(result).toContain('Pickup awaiting confirmation');
  expect(result).toContain('No pickup request recorded');
  expect(result).toContain('Pickup request rejected');
  expect(result.match(/1\/4/g)).toHaveLength(4);
  expect(result).toContain('2026-10-22');
});

it('never reports no pickup requested while request history is unavailable', () => {
  const c = fixture(); c._bostaPickupRequestsKnown = false;
  expect(c._puDailyPickupHtml([order('a')])).toContain('Checking pickup request');
  c._bostaPickupRequestsState = 'error';
  const result = c._puDailyPickupHtml([order('a')]);
  expect(result).toContain('Pickup request status unavailable');
  expect(result).not.toContain('No pickup request recorded');
});

it('shows actual courier statuses including returns instead of labelling every card shipped', () => {
  const c = fixture();
  for (const [code, label] of [['CREATED', 'Awaiting courier pickup'], ['PICKED_UP', 'Collected by courier'],
    ['IN_TRANSIT', 'In transit'], ['OUT_FOR_DELIVERY', 'Out for delivery'], ['DELIVERED', 'Delivered'], ['RETURNED', 'Returned']]) {
    expect(c._puDailyOrderStatus(order('a', { bostaStatus: code })).label).toBe(label);
  }
});

it('escapes customer and product names in the order cards', () => {
  const c = fixture();
  const rendered = c._puDailyOrdersHtml({ orders: [order('a', { client: '<script>alert(1)</script>', items: [{ name: '<img src=x>', qty: 2 }] })] });
  expect(rendered).toContain('&lt;script&gt;'); expect(rendered).not.toContain('<script>');
  expect(rendered).toContain('&lt;img'); expect(rendered).toContain('Awaiting courier pickup');
});

it('separates the weekday from the numeric table date and labels the order count', () => {
  const c = fixture();
  const result = c._puDailyTableDateHtml('2026-10-21');
  expect(result).toContain('<strong>Wednesday</strong>');
  expect(result).toContain('datetime="2026-10-21"');
  expect(result).toContain('21/10/2026');
  expect(c._puDailyCountHtml(21)).toContain('<bdi>21</bdi>');
  expect(c._puDailyCountHtml(21)).toContain('orders');
});

it('keeps pickup schedule and coverage in the group while compact cards omit repetition', () => {
  const c = fixture();
  c._bostaPickupRequests = [{ status: 'created', orderIds: ['a'], scheduledDate: '2026-10-22' }];
  const group = c._puDailyPickupHtml([order('a')]);
  const card = c._puDailyPickupHtml([order('a')], true);
  expect(group).toContain('Scheduled pickup'); expect(group).toContain('1/1');
  expect(card).toContain('Pickup request sent to Bosta');
  expect(card).not.toContain('Scheduled pickup'); expect(card).not.toContain('1/1');
});

it('keeps registered shipments and confirmed pickup requests Ready until the courier collects them', () => {
  const c = fixture();
  const waiting = order('a');
  c._bostaPickupRequests = [{ status: 'created', orderIds: ['a'], scheduledDate: '2026-10-24' }];
  const rows = [waiting, order('b', { bostaStatus: 'IN_TRANSIT', pickupStatus: 'Shipped' }),
    order('c', { bostaStatus: 'DELIVERED', pickupStatus: 'Delivered' })];
  expect(c._puDailyShippingGroups(rows, 'ready')[0].orders.map(o => o._id)).toEqual(['a']);
  expect(c._puDailyShippingGroups(rows, 'shipped')[0].orders.map(o => o._id)).toEqual(['b', 'c']);
  waiting.bostaStatus = 'PICKED_UP';
  expect(c._puDailyShippingGroups(rows, 'ready')).toHaveLength(0);
  expect(c._puDailyShippingGroups(rows, 'shipped')[0].orders).toHaveLength(3);
  expect(c._puDailyShippingGroups(rows)[0].orders).toHaveLength(3);
});

it('loads and transfers between real Ready ticket references even when both share a dispatch day', async () => {
  const c = fixture();
  const rows = [order('a', { pickupRef: 'REAL-A' }), order('b', { pickupRef: 'REAL-B' }),
    order('c', { pickupRef: 'OLD-C', bostaStatus: 'IN_TRANSIT' })];
  const input = { value: 'REAL-A' }, label = { textContent: '' };
  c.qs = selector => selector === '#pu-edit-ref-input' ? input : label;
  c._renderPuEditEmpty = jest.fn(); c._renderPuEditBody = jest.fn(); c.toast = jest.fn();
  c.closePuEditModal = jest.fn(); c.loadPickupOrders = jest.fn(async () => {});
  c.t = key => key; c.fmtN = String; c._puEditSelectedIds = new Set();
  c.api = jest.fn(async (url, options) => {
    if (!options) return rows.map(o => ({ ...o }));
    const body = JSON.parse(options.body);
    rows.find(o => o._id === body.ids[0])!.pickupRef = body.pickupRef;
    return { updated: body.ids.length };
  });
  runInNewContext([grab('_puBuildGroups'), grab('loadPuEditRun'), grab('puEditMoveSelectedToRun')].join('\n'), c);
  await c.loadPuEditRun();
  expect(c._puEditCurrentRun.pickupRef).toBe('REAL-A');
  expect(c._puEditAvailableRuns.map(g => g.pickupRef)).toEqual(['REAL-B']);
  c._puEditSelectedIds.add('a');
  await c.puEditMoveSelectedToRun('REAL-B');
  expect(c.api).toHaveBeenLastCalledWith('/transactions/pickup-orders/add-to-run', expect.objectContaining({
    body: expect.stringContaining('"pickupRef":"REAL-B"'),
  }));
  const readyGroups = c._puBuildGroups(rows.filter(o => c._puDailyAwaitingPickup(o)));
  expect(readyGroups).toHaveLength(1);
  expect(readyGroups[0].orders.map(o => o._id)).toEqual(['a', 'b']);
});

it('Return group moves only that Ready ticket and persists its return to Preparing', async () => {
  const c = fixture();
  c._pickupOrders = [order('a', { pickupRef: 'REAL-A' }), order('b', { pickupRef: 'REAL-A' }),
    order('c', { pickupRef: 'OTHER' }), order('collected', { pickupRef: 'REAL-A', bostaStatus: 'PICKED_UP' })];
  c._puConfirm = jest.fn(async () => true); c.t = key => key; c.fmtN = String; c.toast = jest.fn();
  c.currentUser = { name: 'Employee' }; c._genPrepRef = () => 'PREP-NEW'; c._puPendingSelected = new Set();
  c.loadPickupOrders = jest.fn(async () => {});
  c.api = jest.fn(async (url, options) => {
    const body = JSON.parse(options.body);
    c._pickupOrders.filter(o => body.ids.includes(o._id)).forEach(o => {
      expect(url).toBe('/transactions/pickup-orders/return-to-preparing');
      o.pickupStatus = 'Preparing';
      o.pickupRef = body.prepRef;
    });
    return { updated: body.ids.length };
  });
  runInNewContext(grab('puCreatePrepGroup') + '\n' + grab('puGroupUndoReadyToPrep'), c);
  await c.puGroupUndoReadyToPrep('REAL-A');
  expect(c.api.mock.calls.map(([url]) => url)).toEqual(['/transactions/pickup-orders/return-to-preparing']);
  expect(c.loadPickupOrders).toHaveBeenCalledTimes(1);
  for (const [, options] of c.api.mock.calls) expect(JSON.parse(options.body).ids).toEqual(['a', 'b']);
  expect(c._pickupOrders[0]).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'PREP-NEW' });
  expect(c._pickupOrders[2].pickupRef).toBe('OTHER');
  expect(c._pickupOrders[3].bostaStatus).toBe('PICKED_UP');
  expect(c._puDailyShippingGroups(c._pickupOrders, 'ready')[0].orders.map(o => o._id)).toEqual(['c']);
});

function returnFixture() {
  const c = fixture();
  c._pickupOrders = [order('a', {pickupRef:'REAL-A',prepChecked:true})];
  c.t = (key, params) => key + JSON.stringify(params || {});
  c.fmtN = String; c.toast = jest.fn(); c._genPrepRef = () => 'PREP-RETURN';
  c.loadPickupOrders = jest.fn(async () => {});
  c.api = jest.fn(async () => ({updated:1}));
  const button = {disabled:false,setAttribute:jest.fn()};
  c.qsa = () => [button];
  runInNewContext(grab('puGroupUndoReadyToPrep'), c);
  return {c,button};
}

it('cancelling Return group makes no request and releases the button', async () => {
  const {c,button}=returnFixture(); c._puConfirm=jest.fn(async () => false);
  await c.puGroupUndoReadyToPrep('REAL-A');
  expect(c._puConfirm.mock.calls[0][0]).toContain('REAL-A');
  expect(c._puConfirm.mock.calls[0][0]).toContain('"n":1');
  expect(c.api).not.toHaveBeenCalled(); expect(c.loadPickupOrders).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false); expect(c._puReturnGroupBusy).toBe(false);
  expect(c._pickupOrders[0]).toMatchObject({pickupStatus:'Ready',prepChecked:true});
});

it('blocks repeat clicks during both confirmation and the request', async () => {
  const {c,button}=returnFixture(); let confirm:any,finish:any;
  c._puConfirm=jest.fn(() => new Promise(resolve => {confirm=resolve;}));
  c.api.mockImplementation(() => new Promise(resolve => {finish=resolve;}));
  const first=c.puGroupUndoReadyToPrep('REAL-A');
  await c.puGroupUndoReadyToPrep('REAL-A');
  expect(button.disabled).toBe(true); expect(c._puConfirm).toHaveBeenCalledTimes(1);
  confirm(true); await Promise.resolve(); await Promise.resolve();
  await c.puGroupUndoReadyToPrep('REAL-A');
  expect(c.api).toHaveBeenCalledTimes(1);
  expect(JSON.parse(c.api.mock.calls[0][1].body).sourceRef).toBe('REAL-A');
  finish({updated:1}); await first;
  expect(button.disabled).toBe(false); expect(c._puReturnGroupBusy).toBe(false);
});

it('refreshes after a concurrent staff conflict and allows a subsequent attempt', async () => {
  const {c,button}=returnFixture(); c._puConfirm=jest.fn(async () => true);
  c.api.mockRejectedValueOnce(new Error('Group already returned by another employee'));
  await c.puGroupUndoReadyToPrep('REAL-A');
  expect(c.loadPickupOrders).toHaveBeenCalledTimes(1);
  expect(c.toast).toHaveBeenCalledWith(expect.stringContaining('another employee'),true);
  expect(button.disabled).toBe(false); expect(c._puReturnGroupBusy).toBe(false);
  await c.puGroupUndoReadyToPrep('REAL-A');
  expect(c.api).toHaveBeenCalledTimes(2);
});
