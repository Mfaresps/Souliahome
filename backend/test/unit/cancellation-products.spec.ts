import { buildCancelledProducts } from '../../src/transactions/cancellation-products';

describe('Cancelled product analysis', () => {
  const row = (items: any[], fields = {}) => ({ stage: 'shopify', code: 'customer-request', type: 'شوبيفاي', items, ...fields });

  it('counts each product once per order and sums repeated lines across both stages', () => {
    const result = buildCancelledProducts([
      row([{ productId: 'p1', code: 'SKU-1', name: 'Bowl', qty: 2 }, { productId: 'p1', code: 'SKU-1', name: 'Bowl', qty: 3 }]),
      row([{ code: 'SKU-1', name: 'Old bowl name', qty: 4 }, { productId: 'p2', name: 'Tray', qty: 10 }], { stage: 'transaction', type: 'مبيعات', code: 'duplicate' }),
    ]);
    expect(result.products.map(p => [p.key, p.orderCount, p.quantity])).toEqual([['id:p1', 2, 9], ['id:p2', 1, 10]]);
    expect(result.products[0].breakdown).toEqual([
      { code: 'customer-request', stage: 'shopify', orderCount: 1, quantity: 5 },
      { code: 'duplicate', stage: 'transaction', orderCount: 1, quantity: 4 },
    ]);
  });

  it('does not merge different product identifiers or ambiguous SKUs and normalizes name-only lines', () => {
    const result = buildCancelledProducts([
      row([{ productId: 'one', code: 'SAME', name: 'Name', qty: 1 }, { productId: 'two', code: 'SAME', name: 'Name', qty: 2 }, { code: 'SAME', name: 'Name', qty: 3 }]),
      row([{ name: '  Wooden   Tray ', qty: 2 }, { name: 'wooden tray', qty: 1 }]),
    ]);
    expect(result.products).toHaveLength(4);
    expect(result.products.find(p => p.key === 'name:wooden tray')).toMatchObject({ orderCount: 1, quantity: 3 });
  });

  it('reports missing and partial data, excludes non-sales, and never invents quantities', () => {
    const result = buildCancelledProducts([
      row([]),
      row([{ name: 'Bad', qty: -2 }, { qty: 2 }, { name: 'Missing qty' }, null]),
      row([{ name: 'Good', qty: 2 }, { name: 'Bad', qty: 'NaN' }]),
      row([{ name: 'Purchase', qty: 30 }], { type: 'مشتريات' }),
    ]);
    expect(result.products).toEqual([expect.objectContaining({ name: 'Good', quantity: 2, orderCount: 1 })]);
    expect(result.productCoverage).toEqual([expect.objectContaining({ orders: 3, missingOrders: 2, partialOrders: 1, excludedOrders: 1 })]);
    expect(buildCancelledProducts([])).toEqual({ products: [], productCoverage: [] });
  });
});
