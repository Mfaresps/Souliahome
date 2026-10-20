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

it('releases preparation on Send before the carrier response and preserves the original order identity', async () => {
  const {c, orders, state} = fixture();
  let sent: any;
  c.api.mockReturnValue(new Promise(resolve => {sent = resolve;}));
  let released = false;
  c._bsfMaybeOffer(orders[0]).then(() => {released = true;});
  const task = c._bsfSend();
  await turn();
  expect(released).toBe(true);
  expect(state().docked).toBe(true);
  expect(c._pwScanFocus).toHaveBeenCalledWith('2');
  expect(c.api.mock.calls[0][0]).toBe('/shipping/create-order/1');
  sent({bostaOrderId: 'shipment', trackingNumber: 'TR-1'});
  await task;
  expect(state().stage).toBe('sent');
  expect(orders[0]).toMatchObject({bostaOrderId: 'shipment', bostaTrackingNumber: 'TR-1'});
  expect((orders[1] as any).bostaOrderId).toBeUndefined();
});

it('keeps preparation available while printing and permits retry after a cancelled or failed print', async () => {
  const {c, orders, state} = fixture();
  Object.assign(orders[0], {bostaOrderId:'shipment'});
  let complete: any;
  c.printBostaAwb.mockReturnValue(new Promise(resolve => {complete = resolve;}));
  let released = false;
  c._bsfMaybeOffer(orders[0]).then(() => {released = true;});
  const printing = c._bsfPrint(); await turn();
  expect(released).toBe(true);
  expect(state().stage).toBe('printing');
  expect(state().docked).toBe(true);
  complete(false); await printing;
  expect(state().stage).toBe('sent');
  expect(c.setTimeout).not.toHaveBeenCalled();
});

it('shows a retryable shipping error without rolling back successful preparation', async () => {
  const {c, orders, state} = fixture();
  c.api.mockRejectedValue(new Error('Carrier unavailable'));
  c._bsfMaybeOffer(orders[0]); await c._bsfSend();
  expect(state()).toMatchObject({stage:'error', docked:true, error:'Carrier unavailable'});
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
