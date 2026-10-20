import mongoose from 'mongoose';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { INVENTORY_UNIT_STATUSES, inventoryUnitBarcode } from '../../src/inventory-units/inventory-unit.constants';
import { InventoryUnitsModule } from '../../src/inventory-units/inventory-units.module';
import { ProductSchema } from '../../src/products/schemas/product.schema';
import { assertInventoryUnitMaintenance } from '../../src/inventory-units/inventory-unit-maintenance';

const Unit = mongoose.model('InventoryUnitSchemaSpec', InventoryUnitSchema);
const Event = mongoose.model('InventoryUnitEventSchemaSpec', InventoryUnitEventSchema);
const oid = () => new mongoose.Types.ObjectId().toHexString();
const unit = (extra: any = {}) => new Unit({ productId: oid(), registeredByUserId: oid(), registeredBy: 'Counter',
  origin: { kind: 'legacy-unknown', reconciliationRef: 'COUNT-REVIEWED-1' }, ...extra });

describe('Inventory unit data model without database writes', () => {
  it('derives a stable individual barcode from native immutable identity, independent of SKU', async () => {
    const p = oid(), first = unit({ productId: p }), second = unit({ productId: p });
    await expect(first.validate()).resolves.toBeUndefined();
    expect(first.barcode).toBe(inventoryUnitBarcode(first._id));
    expect(first.barcode).not.toBe(second.barcode);
    expect(first.toObject()).not.toHaveProperty('code');
    expect(first.status).toBe('inspection-required'); expect(first.warehouseCode).toBeNull();
  });
  it('rejects shared SKU or another unit ID as barcode', async () => {
    await expect(unit({ barcode: 'SHARED-SKU' }).validate()).rejects.toThrow();
    await expect(unit({ barcode: inventoryUnitBarcode(oid()) }).validate()).rejects.toThrow();
  });
  it.each(INVENTORY_UNIT_STATUSES)('supports workflow status %s', async status => {
    const assignment = ['reserved', 'picking', 'prepared', 'shipped', 'delivered'].includes(status)
      ? { transactionId: oid(), lineId: 'stable-line-1' } : null;
    await expect(unit({ status, assignment }).validate()).resolves.toBeUndefined();
  });
  it('requires complete assignments and excludes available-but-assigned units', async () => {
    await expect(unit({ status: 'reserved' }).validate()).rejects.toThrow();
    await expect(unit({ status: 'prepared', assignment: { transactionId: oid() } }).validate()).rejects.toThrow();
    await expect(unit({ status: 'available', assignment: { transactionId: oid(), lineId: 'line' } }).validate()).rejects.toThrow();
  });
  it('does not fabricate purchase or opening provenance for unknown legacy pieces', async () => {
    await expect(unit({ origin: { kind: 'legacy-unknown' } }).validate()).rejects.toThrow();
    await expect(unit({ origin: { kind: 'legacy-unknown', reconciliationRef: 'COUNT', purchaseTransactionId: oid() } }).validate()).rejects.toThrow();
    await expect(unit({ origin: { kind: 'purchase' } }).validate()).rejects.toThrow();
    await expect(unit({ origin: { kind: 'opening-stock', openingStockProductId: oid(), reconciliationRef: 'COUNT' } }).validate()).rejects.toThrow();
    const productId = oid();
    await expect(unit({ productId, origin: { kind: 'opening-stock', openingStockProductId: productId, reconciliationRef: 'COUNT' } }).validate()).resolves.toBeUndefined();
  });
  it('has no competing balances and limits startup work to identity alias metadata', () => {
    for (const schema of [InventoryUnitSchema, InventoryUnitEventSchema]) {
      expect(schema.get('autoIndex')).toBe(false); expect(schema.get('autoCreate')).toBe(false);
      for (const field of ['qty', 'qtyDelta', 'current', 'balance', 'price', 'buyPrice']) expect(schema.paths[field]).toBeUndefined();
      expect(schema.indexes().some(([, options]) => options.expireAfterSeconds != null)).toBe(false);
    }
    // Alias providers may initialize indexes/counters; workflow providers must stay explicit.
    for (const provider of Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InventoryUnitsModule) || []) {
      if (!['UnitManualCodesService', 'InventoryPacksService'].includes(provider.name)) expect(provider.prototype.onModuleInit).toBeUndefined();
      expect(provider.prototype.onApplicationBootstrap).toBeUndefined();
    }
  });
  it('keeps existing Products valid without tracking fields', async () => {
    const Product = mongoose.model('LegacyProductUnitSpec', ProductSchema);
    await expect(new Product({ code: 'EXISTING', name: 'Existing' }).validate()).resolves.toBeUndefined();
  });
  it('validates event operation identity, sequence, actor and allowed states', async () => {
    const payload = { unitId: oid(), sequence: 1, operationKey: 'count:1', action: 'registered', toStatus: 'inspection-required', byUserId: oid(), by: 'Counter' };
    await expect(new Event(payload).validate()).resolves.toBeUndefined();
    for (const patch of [{ sequence: 0 }, { sequence: 1.5 }, { operationKey: ' ' }, { toStatus: 'made-up' }, { byUserId: 'name' }]) {
      await expect(new Event({ ...payload, ...patch }).validate()).rejects.toThrow();
    }
  });
});

describe('Inventory tracking maintenance safety', () => {
  const connection = (units = 0, events = 0): any => ({ collection: (name: string) => ({ countDocuments: async () => name === 'inventoryunits' ? units : events }) });
  it('retains legacy maintenance behavior when no tracking exists', async () => {
    await expect(assertInventoryUnitMaintenance(connection(), ['products'], { products: [] })).resolves.toBeUndefined();
  });
  it.each(['products', 'transactions', 'inventorymovements', 'inventoryunits', 'inventoryunitevents'])('blocks destructive maintenance of %s with retained tracking', async name => {
    await expect(assertInventoryUnitMaintenance(connection(1), [name])).rejects.toThrow('coordinated offline');
    await expect(assertInventoryUnitMaintenance(connection(0, 1), [name])).rejects.toThrow();
  });
  it('does not block unrelated maintenance', async () => {
    await expect(assertInventoryUnitMaintenance(connection(1), ['announcements'])).resolves.toBeUndefined();
  });
  it('requires a complete tracking dataset and full restore into a target without tracking', async () => {
    const data = { products: [], transactions: [], inventorymovements: [], inventoryunits: [{}], inventoryunitevents: [], inventoryunitoperations: [] };
    await expect(assertInventoryUnitMaintenance(connection(), Object.keys(data), data, true)).resolves.toBeUndefined();
    await expect(assertInventoryUnitMaintenance(connection(), ['inventoryunits'], data)).rejects.toThrow();
    await expect(assertInventoryUnitMaintenance(connection(), ['products'], { products: [], inventoryunits: [{}] }, true)).rejects.toThrow();
  });
  it.each(['purchaseOrderId', 'purchaseLineId'])('requires receipt finance and actors when restoring %s-linked pieces', async field => {
    const data: any = { products: [], transactions: [], inventorymovements: [], inventoryunits: [{ origin: { [field]: oid() } }], inventoryunitevents: [], inventoryunitoperations: [] };
    await expect(assertInventoryUnitMaintenance(connection(), Object.keys(data), data, true)).rejects.toThrow('Purchase receipt tracking');
    for (const name of ['purchaseorders', 'suppliers', 'supplierledgerentries', 'vaultentries', 'users']) data[name] = [];
    await expect(assertInventoryUnitMaintenance(connection(), Object.keys(data), data, true)).resolves.toBeUndefined();
  });
});
