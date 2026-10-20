import { Connection } from 'mongoose';

const CORE_TRACKING = ['inventoryunits', 'inventoryunitevents', 'inventoryunitoperations'];
const TRACKING = [...CORE_TRACKING, 'inventoryunitcodes', 'inventorypacks', 'warehousetransfers'];
const RELATED = ['products', 'transactions', 'inventorymovements', 'returnrequests', 'supplierreturnorders', 'purchaseorders', 'suppliers', 'supplierledgerentries', 'vaultentries', 'warehouses', ...TRACKING, 'inventoryunitcodecounters'];

/** Raw-driver restore/reset bypasses model deletion hooks. Reject unsafe partial maintenance. */
export async function assertInventoryUnitMaintenance(
  connection: Connection, collections: string[], backup?: Record<string, any[]>, fullRestore = false,
): Promise<void> {
  if (!collections.some(name => RELATED.includes(name))) return;
  const liveTracking = await Promise.all(TRACKING.map(name => connection.collection(name).countDocuments({}, { limit: 1 })));
  const backupHasTracking = TRACKING.some(name => (backup?.[name]?.length || 0) > 0);
  if (backup?.warehousetransfers?.length && !['warehouses','products','transactions','inventorymovements'].every(name => Array.isArray(backup[name]))) {
    throw new Error('Warehouse transfers require coordinated warehouse, product, transaction and movement datasets');
  }
  if (backup?.inventorypacks?.length && !['inventoryunits','inventoryunitcodecounters','users'].every(name => Array.isArray(backup[name]))) {
    throw new Error('Pack identities require their physical units, code counters and actor datasets');
  }
  if (backup?.inventoryunits?.some(unit => unit.origin?.purchaseLineId || unit.origin?.purchaseOrderId) &&
    !['purchaseorders', 'suppliers', 'supplierledgerentries', 'vaultentries', 'users'].every(name => Array.isArray(backup[name]))) {
    throw new Error('Purchase receipt tracking requires the related orders, supplier, financial and actor backup datasets');
  }
  if (liveTracking.some(count => count > 0)) {
    throw new Error('Inventory units/events exist: use a coordinated offline restore into a separate database; partial restore/reset is blocked');
  }
  const aliasDatasets = backup?.inventoryunitcodes?.length ? ['inventoryunitcodes', 'inventoryunitcodecounters'] : [];
  if (backupHasTracking && (!fullRestore || !['products', 'transactions', 'inventorymovements', ...CORE_TRACKING, ...aliasDatasets].every(name => Array.isArray(backup?.[name])))) {
    throw new Error('Inventory tracking requires a complete coordinated backup and full restore into a database without tracking data');
  }
}
