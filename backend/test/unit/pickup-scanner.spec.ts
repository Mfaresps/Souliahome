import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from '../pickup-authorized-context';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const scanner = html.slice(html.indexOf('function _pwScanFocus('), html.indexOf('async function pwUndoLastPick('));
const undo = html.slice(html.indexOf('async function pwUndoLastPick('), html.indexOf('/** RIGHT PANEL', html.indexOf('async function pwUndoLastPick(')));
const barcode = readFileSync(resolve(__dirname, '../../../frontend/public/barcode-input.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const state: any = { summary: { lines: [{ lineId: 'line', productId: 'product', qty: 3, units: [], availableCount: 3 }] } };
  const order: any = { _id: 'order', items: [{ lineId: 'line', qty: 3 }] };
  const root = { tabIndex: 0, focus: jest.fn() };
  let at = 0;
  let operation = 0;
  const c: any = {
    _pwSelId: 'order', _pucoColType: 'prep', currentLang: 'en', _pwPickState: () => state,
    _pucoGetGroup: () => ({ orders: [order] }), _pwEnsurePickLines: jest.fn().mockResolvedValue(undefined),
    _pwLoadPickSummary: jest.fn().mockImplementation(async () => state.summary), _pwAutoPrepareScannedOrder: jest.fn().mockResolvedValue(undefined),
    _pwRenderWork: jest.fn(), hasPerm: () => true, esc: String, fmtN: String, toast: jest.fn(),
    crypto: { randomUUID: () => 'operation-' + ++operation }, setTimeout, clearTimeout, requestAnimationFrame: (fn: any) => fn(), showConfirm: jest.fn().mockResolvedValue(true),
    performance: { now: () => at += 10 }, window: {}, HTMLInputElement: class {}, Event: class {},
    document: { activeElement: null, addEventListener: jest.fn(), querySelector: () => null,
      getElementById: (id: string) => id === 'pu-card-orders-modal' ? { getClientRects: () => [{}] } : id === 'pw-work' ? root : null },
    api: jest.fn(async (url: string, options: any) => {
      if (!options?.method) return { unit: { status: 'available', productId: 'product' } };
      const body = JSON.parse(options.body);
      return { unit: { _id: body.identifier, barcode: body.identifier, status: 'picking', __v: 1 } };
    }),
  };
  runInNewContext(barcode, c); runInNewContext(scanner, c); runInNewContext(undo, c);
  return { c, state, order, root };
}

it('has no visible barcode fields until Manual entry is opened', () => {
  const { c, state, order } = fixture();
  expect(c._pwScanIntroHtml(order, state)).not.toContain('<input');
  expect(c._pwUnitScanHtml(order, order.items[0], state)).not.toContain('<input');
  state.manualOpen = true;
  expect(c._pwScanIntroHtml(order, state)).toContain('id="pw-order-scan"');
});

it('expires a rejection after eight seconds without extending it on re-render or altering saved scans', () => {
  jest.useFakeTimers();
  try {
    const { c, state, order } = fixture();
    state.summary.lines[0].units = [{ barcode: 'saved-piece', status: 'picking' }];
    state.feedback = { error: true, lineId: 'line', text: 'Rejected' };
    c._pwScanIntroHtml(order, state);
    jest.advanceTimersByTime(5000);
    c._pwScanIntroHtml(order, state);
    jest.advanceTimersByTime(2999);
    expect(state.feedback.error).toBe(true);
    jest.advanceTimersByTime(1);
    expect(state.feedback).toBeNull();
    expect(state.summary.lines[0].units).toHaveLength(1);
    expect(c._pwUnitScanHtml(order, order.items[0], state)).not.toContain('Scan not accepted');
    expect(c._pwRenderWork).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it.each([false, true])('an expired rejection cannot clear a newer result (new rejection=%s)', rejected => {
  jest.useFakeTimers();
  try {
    const { c, state, order } = fixture();
    state.feedback = { error: true, text: 'First rejection' };
    c._pwScanIntroHtml(order, state);
    jest.advanceTimersByTime(5000);
    const next = state.feedback = { error: rejected, text: 'New result' };
    c._pwScanIntroHtml(order, state);
    jest.advanceTimersByTime(3000);
    expect(state.feedback).toBe(next);
    jest.advanceTimersByTime(5000);
    expect(state.feedback).toBe(rejected ? null : next);
  } finally { jest.useRealTimers(); }
});

it.each(['en', 'ar'])('accepts a physical scan without focusing an input (%s keyboard)', async language => {
  const { c, state } = fixture(); c.currentLang = language;
  const text = 'SU-ABCDEF123456789012345678';
  for (const char of text) {
    const letter = /[A-Z]/.test(char);
    c._pwCaptureReaderKey({ key: language === 'ar' && letter ? 'ش' : char,
      code: letter ? 'Key' + char : /\d/.test(char) ? 'Digit' + char : 'Minus', shiftKey: letter,
      target: { closest: () => null }, preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() });
  }
  c._pwCaptureReaderKey({ key: 'Enter', target: { closest: () => null }, preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() });
  await tick();
  const body = JSON.parse(c.api.mock.calls.find((row: any[]) => row[1]?.method)?.[1].body);
  expect(body.identifier).toBe(text);
  expect(state.summary.lines[0].units).toHaveLength(1);
});

it('serializes fast scans received during an in-flight lookup and avoids duplicate submissions', async () => {
  const { c, state } = fixture();
  let release: any;
  c.api.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = c._pwSubmitScan('order', '123456789'); await tick();
  const second = c._pwSubmitScan('order', '234567891');
  c._pwSubmitScan('order', '234567891');
  expect(state.summary.lines[0].units).toHaveLength(0);
  release({ unit: { status: 'available', productId: 'product' } }); await Promise.all([first, second]);
  expect(c.api.mock.calls.filter((row: any[]) => row[1]?.method === 'POST')).toHaveLength(2);
  expect(state.summary.lines[0].units).toHaveLength(2);
  expect(c._pwLoadPickSummary).not.toHaveBeenCalled();
});

it.each(['Shift', 'CapsLock'])('keeps the full hardware barcode across %s events without focusing the manual field', async modifier => {
  const { c, state } = fixture();
  state.manualOpen = true;
  const send = (key: string, extra = {}) => c._pwCaptureReaderKey({ key, target: { closest: () => null },
    preventDefault: jest.fn(), stopImmediatePropagation: jest.fn(), ...extra });
  const code = 'SU-6AD6BF985124D5601B2B3ED5';
  for (const char of code) {
    if (/[A-Z]/.test(char)) send(modifier);
    send(char, { code: /[A-Z]/.test(char) ? 'Key' + char : /\d/.test(char) ? 'Digit' + char : 'Minus', shiftKey: /[A-Z]/.test(char) });
  }
  send('Enter'); await tick();
  const write = c.api.mock.calls.find((row: any[]) => row[1]?.method === 'POST');
  expect(write).toBeDefined();
  expect(JSON.parse(write[1].body).identifier).toBe(code);
});

it.each(['en', 'ar'])('explains purchase coverage rejection with the invoice and quantities (%s)', language => {
  const { c } = fixture(); c.currentLang = language;
  const result = c._pwScanError({ message: 'The data or operation state changed. Refresh it before continuing.',
    originalMessage: 'Purchase receipt needs reconciliation before picking', code: 'PURCHASE_RECEIPT_RECONCILIATION_REQUIRED',
    details: { purchaseTransactionId: '6ad6bf985124d5601b2b3d35', purchaseRef: '900016', invoiceQuantity: 10, registeredQuantity: 8 } });
  expect(result.text).toContain('900016');
  expect(result.hint).toContain('10'); expect(result.hint).toContain('8');
  expect(result.purchaseTransactionId).toBe('6ad6bf985124d5601b2b3d35');
});

it('reads a device without an Enter suffix, including repeated digit events', async () => {
  jest.useFakeTimers();
  try {
    const { c, state } = fixture();
    for (const char of '111111111') c._pwCaptureReaderKey({ key: char, code: 'Digit1', repeat: true,
      target: { closest: () => null }, preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() });
    await jest.advanceTimersByTimeAsync(501);
    expect(state.summary.lines[0].units).toHaveLength(1);
    expect(JSON.parse(c.api.mock.calls.find((row: any[]) => row[1]?.method)?.[1].body).identifier).toBe('111111111');
  } finally { jest.useRealTimers(); }
});

it('discards an unterminated device scan when the selected order changes', async () => {
  jest.useFakeTimers();
  try {
    const { c } = fixture();
    for (const key of '123456789') c._pwCaptureReaderKey({ key, target: { closest: () => null },
      preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() });
    c._pwSelId = 'other';
    await jest.advanceTimersByTimeAsync(501);
    expect(c.api).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('shows the committed code and check immediately, before subsequent preparation finishes', async () => {
  const { c, state } = fixture();
  let finish: any;
  c._pwAutoPrepareScannedOrder.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const task = c._pwSubmitScan('order', '123456789'); await tick();
  expect(state.feedback.error).toBe(false);
  expect(state.feedback.identifier).toBeTruthy();
  expect(state.summary.lines[0].units).toHaveLength(1);
  finish(); await task;
});

it('never sends a captured scan to a newly selected order', async () => {
  const { c } = fixture(); let release: any;
  c.api.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const task = c._pwSubmitScan('order', '123456789'); await tick();
  c._pwSubmitScan('order', '234567891'); c._pwSelId = 'other';
  release({ unit: { status: 'available', productId: 'product' } }); await task;
  expect(c.api.mock.calls.filter((row: any[]) => row[1]?.method === 'POST')).toHaveLength(0);
});

it('keeps success false on a failed save and reuses its operation key when retrying', async () => {
  const { c, state } = fixture();
  c.api.mockImplementationOnce(async () => ({ unit: { status: 'available', productId: 'product' } }));
  c.api.mockRejectedValueOnce(Error('Network error'));
  await c._pwSubmitScan('order', '123456789');
  expect(state.feedback.error).toBe(true); expect(state.summary.lines[0].units).toHaveLength(0);
  await c._pwSubmitScan('order', '123456789');
  const writes = c.api.mock.calls.filter((row: any[]) => row[1]?.method === 'POST').map((row: any[]) => JSON.parse(row[1].body));
  expect(writes[0].operationKey).toBe(writes[1].operationKey);
});

it('has a localized explanation and a practical next step for errors', () => {
  const { c } = fixture(); c.currentLang = 'ar';
  for (const message of ['DUPLICATE_SCAN', 'Barcode is not registered', 'Wrong product', 'another order', 'Network error']) {
    const result = c._pwScanError(Error(message));
    expect(result.error).toBe(true); expect(result.text).toMatch(/[\u0600-\u06ff]/); expect(result.hint).toMatch(/[\u0600-\u06ff]/);
  }
});

it('does not intercept ordinary comment entry or Space used to view the invoice', () => {
  const { c } = fixture(); const prevent = jest.fn();
  c._pwCaptureReaderKey({ key: 'a', code: 'KeyA', target: { closest: () => ({}) }, preventDefault: prevent });
  c._pwCaptureReaderKey({ key: ' ', target: { closest: () => null }, preventDefault: prevent });
  expect(prevent).not.toHaveBeenCalled();
});

function replayFixture(pack = false) {
  const env = fixture(), { c, state, order } = env;
  const identifier = pack ? 'PK-ABCDEF123456789012345678' : '123456789';
  const quantity = pack ? 2 : 1;
  const server = { lines: [{ lineId: 'line', productId: 'product', qty: quantity, availableCount: quantity, units: [] as any[] }] };
  order.items[0].qty = quantity;
  state.summary = JSON.parse(JSON.stringify(server));
  let revision = 0;
  const receipts = new Map<string, any>(), scanKeys: string[] = [];
  c._pwLoadPickSummary.mockImplementation(async () => state.summary = JSON.parse(JSON.stringify(server)));
  c.api.mockImplementation(async (url: string, options: any) => {
    if (!options?.method) return url.endsWith('/picking') ? JSON.parse(JSON.stringify(server))
      : { unit: { status: 'available', productId: 'product', __v: revision, isPack: pack, quantity } };
    if (url.endsWith('/actions') || url.endsWith('/undo-scan')) {
      server.lines[0].units = []; revision++; return { ok: true };
    }
    const body = JSON.parse(options.body); scanKeys.push(body.operationKey);
    if (receipts.has(body.operationKey)) return receipts.get(body.operationKey);
    const units = Array.from({ length: quantity }, (_, i) => ({ unitId: 'unit-' + i, barcode: 'SU-' + i, status: 'picking', version: revision,
      ...(pack ? { packId: 'abcdef123456789012345678' } : { manualCode: identifier }) }));
    server.lines[0].units = units;
    const result = { unit: { ...units[0], manualCode: identifier }, ...(pack ? { units, isPack: true, quantity, packId: 'abcdef123456789012345678' } : {}) };
    receipts.set(body.operationKey, result); return result;
  });
  return { ...env, identifier, server, scanKeys, quantity };
}

it.each([false, true])('records a new physical scan after confirmed undo, rather than replaying a stale receipt (pack=%s)', async pack => {
  const { c, state, order, identifier, server, scanKeys, quantity } = replayFixture(pack);
  await c._pwSubmitScan(order._id, identifier);
  expect(server.lines[0].units).toHaveLength(quantity);
  expect(state.feedback.error).toBe(false);
  await c.pwUndoLastPick(order._id);
  expect(server.lines[0].units).toHaveLength(0);
  expect(state.feedback).toBeNull();
  expect(state.pendingScanAnimation).toBeNull();
  expect(state.scanAttempts.size).toBe(0);
  expect(c._pwScanIntroHtml(order, state)).not.toContain('pw-scan-feedback');
  await c._pwSubmitScan(order._id, identifier);
  expect(scanKeys[1]).not.toBe(scanKeys[0]);
  expect(server.lines[0].units).toHaveLength(quantity);
  expect(state.summary.lines[0].units).toHaveLength(quantity);
});

it('keeps the prior result and retry identity when undo is cancelled or fails', async () => {
  const { c, state, identifier } = replayFixture();
  await c._pwSubmitScan('order', identifier);
  const feedback = state.feedback, attempt = state.scanAttempts.get(identifier);
  c.showConfirm.mockResolvedValueOnce(false);
  await c.pwUndoLastPick('order');
  expect(state.feedback).toBe(feedback);
  expect(state.scanAttempts.get(identifier)).toBe(attempt);
  const impl = c.api.getMockImplementation();
  c.api.mockImplementation(async (url: string, options: any) => { if (url.endsWith('/actions')) throw Error('Network error'); return impl(url, options); });
  await c.pwUndoLastPick('order');
  expect(state.feedback).toBe(feedback);
  expect(state.scanAttempts.get(identifier)).toBe(attempt);
});

it('starts a new scan operation when a remote undo changed the physical piece version', async () => {
  const { c, state } = fixture();
  await c.pwScanOrderUnit('order', 'line', null, '123456789', 1);
  state.summary.lines[0].units = [];
  await c.pwScanOrderUnit('order', 'line', null, '123456789', 3);
  const keys = c.api.mock.calls.filter((row: any[]) => row[1]?.method === 'POST').map((row: any[]) => JSON.parse(row[1].body).operationKey);
  expect(keys[0]).not.toBe(keys[1]);
});
