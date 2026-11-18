import { buildInventoryBreakdown, saleAwaitingDispatch } from '../../src/transactions/inventory-breakdown';

export {};

const products = [{ _id: 'p1', code: 'A' }, { _id: 'p2', code: 'B' }, { _id: 'p3', code: 'A' }];
const sale = (extra: any) => ({ _id: 's' + Math.random(), type: 'مبيعات', ref: '100', client: 'X', items: [{ code: 'A', qty: 2 }], ...extra });
const base = { products, sales: [] as any[], units: [] as any[], writtenOff: new Set<string>(), customerDamaged: new Set<string>(), purchaseOrders: [] as any[] };

describe('inventory breakdown', () => {
  it('counts only confirmed sales still in the warehouse as reserved, per warehouse', () => {
    const out = buildInventoryBreakdown({ ...base, sales: [
      sale({ pickupStatus: 'Preparing' }),
      sale({ pickupStatus: 'Pending', warehouseCode: 'W2', items: [{ code: 'A', qty: 1 }, { code: 'A', qty: 3 }] }),
      sale({ pickupStatus: 'Shipped' }), sale({ pickupStatus: 'Ready', shippedAt: '2026-11-01' }),
      sale({ pickupStatus: 'Ready', bostaStatus: 'PICKED_UP' }), sale({ pickupStatus: 'Pending', cancelled: true }),
    ] });
    expect(out.p1.byWarehouse.MAIN.reserved).toBe(2);
    expect(out.p1.byWarehouse.W2.reserved).toBe(4);
    expect(out.p1.byWarehouse.W2.reservedOrders).toHaveLength(1);
    expect(out.p3).toBeUndefined(); // first product wins a duplicated code, like the reports
  });

  it('counts issue pieces still inside the balance, never written-off or customer-damaged ones', () => {
    const out = buildInventoryBreakdown({ ...base,
      units: [
        { _id: 'u1', productId: 'p2', status: 'damaged' }, { _id: 'u2', productId: 'p2', status: 'lost' },
        { _id: 'u3', productId: 'p2', status: 'inspection-required' }, { _id: 'u4', productId: 'p2', status: 'returned' },
        { _id: 'u5', productId: 'p2', status: 'lost' }, { _id: 'u6', productId: 'p2', status: 'damaged' },
        { _id: 'u7', productId: 'p2', status: 'available' },
      ],
      writtenOff: new Set(['u5']), customerDamaged: new Set(['u6']) });
    expect(out.p2.byWarehouse.MAIN).toMatchObject({ damaged: 1, lost: 1, inspection: 2 });
  });

  it('counts open purchase orders as incoming, not received or linked ones', () => {
    const out = buildInventoryBreakdown({ ...base, purchaseOrders: [
      { _id: 'o1', poNumber: 'PO-1', status: 'معلق', items: [{ productCode: 'B', qty: 5 }, { productCode: 'B', qty: 1 }] },
      { _id: 'o2', poNumber: 'PO-2', status: 'جاهز للاستلام', items: [{ productCode: 'B', qty: 4 }] },
      { _id: 'o3', poNumber: 'PO-3', status: 'مستلم', items: [{ productCode: 'B', qty: 9 }] },
      { _id: 'o4', poNumber: 'PO-4', status: 'معلق', linkedTransactionId: 'tx', items: [{ productCode: 'B', qty: 9 }] },
    ] });
    expect(out.p2.incoming).toBe(10);
    expect(out.p2.incomingOrders.map(o => o.poNumber)).toEqual(['PO-1', 'PO-2']);
  });

  it('treats an after-sales shipment as dispatched', () => {
    expect(saleAwaitingDispatch(sale({ afterSalesBundle: { shipment: { at: 'x' } } }))).toBe(false);
    expect(saleAwaitingDispatch(sale({ pickupStatus: 'Ready' }))).toBe(true);
  });
});
