import { bundledShipmentCod, bundledSaleCod, bundledSaleShipCharged, caseBundleBlock, phoneKey, saleBundleBlock, sameCustomer, pendingDepositRequests } from '../../src/shared/after-sales-bundle.util';

describe('after-sales bundle rules', () => {
  const row = { _id: 'case1', requestKind: 'exchange', originalTransactionId: 'orig', client: 'Mona Ali', phone: '01007133065',
    workflow: { stage: 'approved', fulfillmentChannel: 'bosta', replacementTxId: 'repl', warehouseCode: 'MAIN', bundledSales: [] } };
  const sale = (extra: any = {}) => ({ _id: 'b1', type: 'مبيعات', client: 'Mona Ali', phone: '1007133065', warehouseCode: 'MAIN', remaining: 650, ...extra });

  it('matches a customer by phone (with or without the leading 0, Arabic digits), else by exact name', () => {
    expect(phoneKey('٠١٠٠٧١٣٣٠٦٥')).toBe('1007133065');
    expect(sameCustomer({ phone: '01007133065' }, { phone: '+20 100 713 3065' })).toBe(true);
    expect(sameCustomer({ phone: '01007133065', client: 'Mona Ali' }, { phone: '01111111111', client: 'Mona Ali' })).toBe(false);
    expect(sameCustomer({ client: ' mona  ali ' }, { client: 'Mona Ali' })).toBe(true);
  });
  it('accepts an unshipped sale of the same customer only', () => {
    expect(saleBundleBlock(sale(), row)).toBe('');
    expect(saleBundleBlock(sale({ phone: '01222222222' }), row)).toContain('عميل آخر');
    expect(saleBundleBlock(sale({ bostaTrackingNumber: '777' }), row)).toContain('بوسطة');
    expect(saleBundleBlock(sale({ pickupStatus: 'Shipped' }), row)).toContain('للشحن');
    expect(saleBundleBlock(sale({ _id: 'orig' }), row)).toContain('الأصلية');
    expect(saleBundleBlock(sale({ _id: 'repl' }), row)).toContain('البديل');
    expect(saleBundleBlock(sale({ afterSales: { caseId: 'x' } }), row)).toContain('ما بعد البيع');
    expect(saleBundleBlock(sale({ afterSalesBundle: { caseId: 'other', caseRef: 'AS-2' } }), row)).toContain('AS-2');
    expect(saleBundleBlock(sale({ warehouseCode: 'ALEX' }), row)).toContain('مخزن');
    expect(saleBundleBlock(sale({ cancelled: true }), row)).toContain('ملغي');
  });
  it('allows bundling only on an exchange shipped by Bosta, before its waybill', () => {
    expect(caseBundleBlock(row)).toBe('');
    expect(caseBundleBlock({ ...row, requestKind: 'return' })).toContain('الاستبدال');
    expect(caseBundleBlock({ ...row, workflow: { ...row.workflow, fulfillmentChannel: 'direct' } })).toContain('المباشر');
    expect(caseBundleBlock({ ...row, workflow: { ...row.workflow, shipment: { status: 'created' } } })).toContain('أُنشئت شحنة');
  });
  it('builds the waybill COD from the exchange difference and each remaining, never negative', () => {
    expect(bundledSaleCod({ remaining: 650 })).toBe(650);
    expect(bundledSaleCod({ remaining: -10 })).toBe(0);
    expect(bundledShipmentCod(150, [{ cod: 650 }, { cod: 0.1 }, { cod: 0.2 }])).toBe(800.3);
    expect(bundledSaleShipCharged({ shipCost: 50, shippingDiscount: 50 })).toBe(0);
    expect(pendingDepositRequests({ depositRequests: [{ status: 'معلق' }, { status: 'قيد التسجيل' }, { status: 'معتمد' }] })).toBe(2);
  });
});
