import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';

function fixture(registeredQuantity: number) {
  const svc: any = Object.create(InventoryUnitsService.prototype);
  const purchaseId = '6ad6bf985124d5601b2b3d35';
  const unit: any = { _id: '6ad6bf985124d5601b2b3ed5', __v: 0, productId: '69ebc17ac7524ff8f691c8d3', status: 'available',
    barcode: 'SU-6AD6BF985124D5601B2B3ED5', warehouseCode: 'MAIN', assignment: null, origin: { purchaseTransactionId: purchaseId, purchaseLineId: 'purchase-line' }, save: jest.fn(), markModified: jest.fn() };
  unit.toObject = () => ({ status: unit.status });
  const purchase: any = { ref: '900016', items: [{ lineId: 'purchase-line', code: 'Code 38', qty: 10 }] };
  const activePurchase = () => purchase.cancelled || purchase.archived ? null : purchase;
  svc.identifierFilter = jest.fn().mockResolvedValue({ barcode: 'SU-' + unit._id.toUpperCase() });
  svc.units = { findOne: () => ({ session: async () => unit }), countDocuments: jest.fn()
    .mockReturnValueOnce({ session: async () => 0 }).mockReturnValue({ session: async () => registeredQuantity }) };
  svc.lockProduct = jest.fn().mockResolvedValue({ code: 'Code 38' });
  svc.connection = { collection: () => ({
    findOneAndUpdate: async (filter: any) => filter.type === 'مشتريات' ? activePurchase()
      : ({ _id: 'a'.repeat(24), warehouseCode: 'MAIN', items: [{ lineId: 'sale-line', code: 'Code 38', qty: 1 }] }),
    findOne: async () => activePurchase(),
  }) };
  svc.event = jest.fn(); svc.manualCodes = { codeFor: async () => 'U-0000-0083-6' };
  const scan = () => svc.pickUnitInSession('a'.repeat(24), {
    identifier: 'SU-' + unit._id.toUpperCase(), physicalPossessionConfirmed: true, reason: 'Physical piece scanned', lineId: 'sale-line'
  }, {}, {}, 'Operator');
  const prepare = () => svc.actionInSession(unit.barcode, { action: 'prepare', expectedVersion: 0, physicalPossessionConfirmed: true }, {}, {}, 'Operator');
  return { svc, scan, prepare, unit, purchaseId, purchase };
}

it('reports source invoice overcoverage without committing a rejected scan', async () => {
  const { scan, unit, purchaseId } = fixture(12);
  await expect(scan()).rejects.toMatchObject({ response: {
    code: 'PURCHASE_RECEIPT_RECONCILIATION_REQUIRED', purchaseTransactionId: purchaseId,
    purchaseRef: '900016', invoiceQuantity: 10, registeredQuantity: 12,
  } });
  expect(unit.save).not.toHaveBeenCalled();
});

it.each([8, 10])('allows an existing verified piece when %s of 10 purchase pieces have codes', async quantity => {
  const { scan, prepare, unit } = fixture(quantity);
  await expect(scan()).resolves.toMatchObject({ outcome: 'accepted', unit: { status: 'picking', barcode: unit.barcode }, stockChanged: false });
  expect(unit.save).toHaveBeenCalledTimes(1);
  await expect(prepare()).resolves.toMatchObject({ unit: { status: 'prepared' }, stockChanged: false });
  expect(unit.save).toHaveBeenCalledTimes(2);
});

it.each(['cancelled', 'archived', 'excess', 'missing-line'])('blocks approval when the receipt becomes invalid after scanning (%s)', async change => {
  const { scan, prepare, unit, purchase } = fixture(8);
  await scan();
  if (change === 'excess') purchase.items[0].qty = 7;
  else if (change === 'missing-line') purchase.items = [];
  else purchase[change] = true;
  await expect(prepare()).rejects.toMatchObject({ response: { code: 'PURCHASE_RECEIPT_RECONCILIATION_REQUIRED' } });
  expect(unit.save).toHaveBeenCalledTimes(1);
  expect(unit.status).toBe('picking');
});
