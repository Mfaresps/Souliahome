import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

function preview(admin = false, delegated = false) {
  const listeners: Record<string, any> = {};
  let overlay: any;
  const document: any = { activeElement: { focus: jest.fn() },
    querySelector: () => null, addEventListener: (event, handler) => { listeners[event] = handler; },
    removeEventListener: event => { delete listeners[event]; },
    body: { append: el => { overlay = el; } } };
  const element = () => {
    const events: Record<string, any> = {};
    return { innerHTML: '', style: {}, removed: false,
      addEventListener: (event, handler) => { events[event] = handler; },
      click() { events.click?.({ target: this }); },
      focus() { document.activeElement = this; }, remove() { this.removed = true; } };
  };
  document.createElement = () => {
    const el: any = element(), send = element(), back = element();
    el.querySelector = selector => selector === '[data-send]' ? send : back;
    return el;
  };
  const source = readFileSync(resolve(__dirname, '../../../frontend/public/shopify-edit-approvals.js'), 'utf8');
  const env: any = { document, currentLang: 'en', isAdmin: () => admin, hasPerm: () => delegated,
    fmtJ: value => 'EGP ' + value, toast: jest.fn(),
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
  runInNewContext(source, env);
  return { env, document, overlay: () => overlay, escape: () => listeners.keydown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }) };
}

const order = { ref: '2820', items: [{ productId: 'p1', name: 'Chair', qty: 1, price: 1000 }],
  itemsTotal: 1000, total: 1000, manualDiscount: 0, codesDiscount: 0, shipCost: 0 };

it('shows quantities, prices, discounts and total before the employee can send', async () => {
  const ui = preview();
  const pending = ui.env._spConfirmEditSubmission(order, { items: [{ productId: 'p1', name: 'Chair', qty: 2, price: 900 }], discount: { manualDiscount: 100 } });
  const overlay = ui.overlay();
  expect(overlay.innerHTML).toContain('Quantity Chair: 1 → 2');
  expect(overlay.innerHTML).toContain('Price Chair: EGP 1000 → EGP 900');
  expect(overlay.innerHTML).toContain('Manual discount: EGP 0 → EGP 100');
  expect(overlay.innerHTML).toContain('Total: EGP 1000 → EGP 1700');
  expect(overlay.innerHTML).toContain('Send to admin for approval');
  overlay.querySelector('[data-send]').click();
  expect(await pending).toBe(true); expect(overlay.removed).toBe(true);
  expect(order.items[0].qty).toBe(1); expect(order.total).toBe(1000);
});

it('returning to editing or pressing Escape cancels the proposal without changing the order', async () => {
  const ui = preview();
  let pending = ui.env._spConfirmEditSubmission(order, { discount: { manualDiscount: 100 } });
  ui.overlay().querySelector('[data-back]').click();
  expect(await pending).toBe(false);
  pending = ui.env._spConfirmEditSubmission(order, { discount: { manualDiscount: 200 } });
  ui.escape();
  expect(await pending).toBe(false); expect(order.manualDiscount).toBe(0);
});

it('summarizes invoice changes and safely escapes customer-entered text', async () => {
  const ui = preview();
  const pending = ui.env._spConfirmEditSubmission({ ...order, phone: '01000', notes: 'Old note' },
    { invoice: { phone: '01111', notes: '<img src=x onerror=alert(1)>', total: 900 } });
  expect(ui.overlay().innerHTML).toContain('Phone: 01000 → 01111');
  expect(ui.overlay().innerHTML).toContain('&lt;img');
  expect(ui.overlay().innerHTML).not.toContain('<img');
  ui.overlay().querySelector('[data-back]').click(); await pending;
});

it('skips admin-review confirmation for administrators or delegated direct editors', async () => {
  for (const [admin, delegated] of [[true, false], [false, true]]) {
    const ui = preview(admin, delegated);
    expect(await ui.env._spConfirmEditSubmission(order, { discount: { manualDiscount: 100 } })).toBe(true);
    expect(ui.overlay()).toBeUndefined();
  }
});

it('does not create a dialog or submit a request when nothing changed', async () => {
  const ui = preview();
  expect(await ui.env._spConfirmEditSubmission(order, { items: order.items, discount: { manualDiscount: 0 } })).toBe(false);
  expect(ui.overlay()).toBeUndefined(); expect(ui.env.toast).toHaveBeenCalled();
});

function decisionPreview() {
  const ui = preview(true);
  const classList = { add: jest.fn(), remove: jest.fn(), contains: () => true };
  ui.env.qs = selector => selector === '#sp-edit-rejection-reason'
    ? { dataset: { orderId: 'o1' }, value: 'Wrong quantity' } : { classList };
  ui.env._shopifyOrders = [{ ...order, _id: 'o1', editRequest: { id: 'r1', status: 'معلق', changes: ['Quantity Chair: 1 → 2'] } }];
  ui.env.currentPage = 'shopify-orders';
  ui.env.closeModal = jest.fn(); ui.env.loadShopifyOrders = jest.fn(async () => {});
  ui.env.api = jest.fn(async () => ({ success: true }));
  ui.env.showConfirm = jest.fn(async () => false);
  ui.env.confirm = jest.fn(() => { throw new Error('Native dialogs must not be used'); });
  ui.env.prompt = jest.fn(() => { throw new Error('Native dialogs must not be used'); });
  return ui;
}

it('shows an in-app approval dialog with the changes and allows returning without applying', async () => {
  const ui = decisionPreview();
  await ui.env.decideShopifyEdit('o1', true);
  expect(ui.env.showConfirm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    title: 'Approve order edit #2820', confirmLabel: 'Approve edit', cancelLabel: 'Back to review',
    rows: [['Quantity Chair: 1 → 2', '']],
  }));
  expect(ui.env.api).not.toHaveBeenCalled(); expect(ui.env.closeModal).not.toHaveBeenCalled();
  expect(ui.env.confirm).not.toHaveBeenCalled(); expect(ui.env.prompt).not.toHaveBeenCalled();
});

it('submits approval only after the custom confirmation and rejection with its inline reason', async () => {
  const ui = decisionPreview(); ui.env.showConfirm.mockResolvedValue(true);
  await ui.env.decideShopifyEdit('o1', true);
  expect(ui.env.api).toHaveBeenLastCalledWith('/shopify/orders/o1/edit-request/r1/approve', expect.objectContaining({ method: 'PATCH' }));
  await ui.env.decideShopifyEdit('o1', false);
  expect(ui.env.api).toHaveBeenLastCalledWith('/shopify/orders/o1/edit-request/r1/reject', { method: 'PATCH', body: JSON.stringify({ reason: 'Wrong quantity' }) });
  expect(ui.env.prompt).not.toHaveBeenCalled();
});

it('blocks repeated clicks while an admin is deciding', async () => {
  const ui = decisionPreview(); let resolveDecision: any;
  ui.env.showConfirm.mockImplementation(() => new Promise(resolve => { resolveDecision = resolve; }));
  const first = ui.env.decideShopifyEdit('o1', true);
  await ui.env.decideShopifyEdit('o1', true);
  expect(ui.env.showConfirm).toHaveBeenCalledTimes(1);
  resolveDecision(true); await first;
  expect(ui.env.api).toHaveBeenCalledTimes(1);
});
