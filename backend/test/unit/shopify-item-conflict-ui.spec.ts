import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function fn(name: string) {
  const start = html.indexOf('function ' + name + '(');
  return html.slice(html.lastIndexOf('\n', start) + 1, html.indexOf('\n}', start) + 2);
}
function view() {
  const esc = (value: any) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const context: any = { currentLang: 'en', esc, fmtN: String, fmtJ: String,
    _spReceiptJs: (value: any) => esc(JSON.stringify(value)), confirm: jest.fn(() => true),
    api: jest.fn(async () => ({ success: true })), toast: jest.fn(),
    _spOrderById: jest.fn(() => ({ _id: 'o1', status: 'pending' })),
    _spConfirmEditSubmission: jest.fn(async () => true),
    loadShopifyOrders: jest.fn(async () => {}), _spRefreshReceiptViews: jest.fn(),
    editShopifyOrder: jest.fn(), document: { getElementById: jest.fn(() => null) }, _spEditDirty: jest.fn(() => false) };
  runInNewContext(fn('_spItemSyncConflictHtml') + '\n' + fn('_spResolveItemSyncConflict'), context);
  return context;
}
describe('Item conflict review', () => {
  it('shows both product quantities/prices and both choices without losing HTML escaping', () => {
    const context = view();
    const result = context._spItemSyncConflictHtml({ _id: 'o1', status: 'pending',
      items: [{ productId: 'p1', name: '<product>', qty: 2, price: 100 }],
      itemSyncConflict: { revision: 'r1', conflictingKeys: ['product:p1'], shopifyItems: [{ productId: 'p1', name: '<product>', qty: 3, price: 100 }] } });
    expect(result).toContain('&lt;product&gt; · 2 × 100');
    expect(result).toContain('&lt;product&gt; · 3 × 100');
    expect(result).toContain('Keep local changes');
    expect(result).toContain('Use Shopify for these products');
  });
  it('submits a revision-bound choice and reloads the order after saving', async () => {
    const context = view();
    await context._spResolveItemSyncConflict('o1', 'local', 'r1');
    expect(context.api).toHaveBeenCalledWith('/shopify/orders/o1/item-sync-conflict', { method: 'PATCH', body: JSON.stringify({ source: 'local', revision: 'r1' }) });
    expect(context.loadShopifyOrders).toHaveBeenCalledTimes(1);
    expect(context.confirm).not.toHaveBeenCalled();
  });
  it('allows cancelling the choice to use remote rows', async () => {
    const context = view(); context.confirm.mockReturnValue(false);
    await context._spResolveItemSyncConflict('o1', 'shopify', 'r1');
    expect(context.api).not.toHaveBeenCalled();
  });
  it('protects unsaved editor changes before switching item versions', async () => {
    const context = view(); context.document.getElementById.mockReturnValue({}); context._spEditDirty.mockReturnValue(true);
    await context._spResolveItemSyncConflict('o1', 'shopify', 'r1');
    expect(context.api).not.toHaveBeenCalled();
    expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('unsaved'), true);
  });
  it('does not show a pending review on already confirmed orders', () => {
    expect(view()._spItemSyncConflictHtml({ status: 'approved', itemSyncConflict: {} })).toBe('');
  });
});
