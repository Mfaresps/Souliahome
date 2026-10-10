import * as fs from 'fs';
import * as path from 'path';

export {};

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function shippedFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

// Run the shipped filtering, sorting and pagination pipeline, stopping before DOM rendering.
const renderStart = source.indexOf('function renderShopifyOrders()');
const pageEnd = source.indexOf('data = data.slice((shopifyPage - 1) * shopifyPerPage, shopifyPage * shopifyPerPage);', renderStart);
if (renderStart < 0 || pageEnd < 0) throw new Error('Missing orders pagination pipeline');
const pipeline = source.slice(renderStart, pageEnd + 'data = data.slice((shopifyPage - 1) * shopifyPerPage, shopifyPage * shopifyPerPage);'.length)
  + '\nreturn { data, page: shopifyPage, total: shopifyTotal };\n}';

const run = new Function('orders', 'page', 'perPage', 'tab', 'filter', `
  const _shopifyOrders = orders, _shopifyTab = tab;
  let shopifyPage = page, shopifyPerPage = perPage, _shopifyStatusFilter = filter;
  let _spResultTotal;
  const _shopifyDateFilter = {}, _spStarOnly = false, _shopifySelectedIds = new Set();
  const qs = selector => selector === '#shopify-orders-table-body' ? {} : null;
  const _spBuildInvIndex = () => ({}), _spBuildCustomerOrderIndex = () => ({}), _unshippedSiblingIndex = () => ({});
  const _spRenderFilterDropdown = () => {}, _spRenderToolbarState = () => {}, _spUpdateTriggerLabel = () => {};
  const _spFilterDef = key => ({ test: o => o.pendingStatus === key });
  const _spApplyPanel = data => data, _renderShopifyDepositSummary = () => {};
  const _spHideCommentPreview = () => {};
  ${shippedFunction('_spOrderCreatedMs')}
  ${shippedFunction('_spCompareOrdersNewestFirst')}
  ${pipeline}
  return renderShopifyOrders();
`) as (orders: any[], page: number, perPage: number, tab: string, filter: string) => { data: any[]; page: number; total: number };

const order = (ref: string, date: string, extra: any = {}) => ({ _id: ref, ref, status: 'pending', shopifyCreatedAt: date, ...extra });
const refs = (result: { data: any[] }) => result.data.map(o => o.ref);

describe('Shopify orders chronological pagination', () => {
  const mixed = [
    order('100', '2026-10-09T21:00:00Z', { tags: ['confirmed'] }),
    order('102', '2026-10-10T15:00:00Z', { pendingStatus: 'no_reply', tags: ['followup'] }),
    order('104', '2026-10-11T10:00:00Z'),
    order('101', '2026-10-10T09:00:00Z', { tags: ['confirmed'] }),
    order('103', '2026-10-10T18:00:00Z', { cancelled: true, tags: ['cancelled'] }),
  ];

  it.each(['pending', 'all'])('keeps yesterday contiguous across pages in the %s tab regardless of status or cancellation', tab => {
    const pages = [1, 2, 3].map(page => run(mixed, page, 2, tab, ''));
    expect(pages.map(refs)).toEqual([['104', '103'], ['102', '101'], ['100']]);
    expect(new Set(pages.flatMap(refs)).size).toBe(mixed.length);
    expect(pages[0].total).toBe(5);
    expect(mixed.map(o => o.ref)).toEqual(['100', '102', '104', '101', '103']);
  });

  it('uses the Shopify date rather than the import date', () => {
    const orders = [order('old-import', '2025-01-01T00:00:00Z', { createdAt: '2026-10-11T20:00:00Z' }), mixed[2]];
    expect(refs(run(orders, 1, 10, 'pending', ''))).toEqual(['104', 'old-import']);
  });

  it('compares actual instants across timezone offsets', () => {
    const orders = [order('earlier', '2026-10-11T11:00:00+03:00'), order('later', '2026-10-11T09:00:00Z')];
    expect(refs(run(orders, 1, 10, 'pending', ''))).toEqual(['later', 'earlier']);
  });

  it('falls back to local creation time for missing or malformed dates and puts undated orders last', () => {
    const orders = [order('unknown', 'bad'), order('missing', '', { createdAt: '2026-10-10T00:00:00Z' }), order('invalid', 'bad', { createdAt: '2026-10-11T00:00:00Z' })];
    expect(refs(run(orders, 1, 10, 'pending', ''))).toEqual(['invalid', 'missing', 'unknown']);
  });

  it('keeps equal timestamps on stable pages when API order changes, using numeric order references', () => {
    const orders = ['9', '100', '10'].map(ref => order(ref, '2026-10-10T00:00:00Z'));
    for (const input of [orders, [...orders].reverse()]) {
      expect(refs(run(input, 1, 2, 'pending', ''))).toEqual(['100', '10']);
      expect(refs(run(input, 2, 2, 'pending', ''))).toEqual(['9']);
    }
  });

  it('keeps duplicate references deterministic using IDs', () => {
    const orders = ['a', 'c', 'b'].map(_id => order('100', '2026-10-10T00:00:00Z', { _id }));
    expect(run(orders, 1, 2, 'pending', '').data.map(o => o._id)).toEqual(['c', 'b']);
  });

  it('filters before pagination and clamps a page after results shrink', () => {
    const orders = [order('1', '2026-10-09T00:00:00Z', { pendingStatus: 'no_reply' }), order('2', '2026-10-10T00:00:00Z', { pendingStatus: 'no_reply' }), mixed[2]];
    const result = run(orders, 4, 1, 'pending', 'no_reply');
    expect(result.page).toBe(2);
    expect(result.total).toBe(2);
    expect(refs(result)).toEqual(['1']);
  });
});
