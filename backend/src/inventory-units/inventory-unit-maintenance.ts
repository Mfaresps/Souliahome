import { Connection } from 'mongoose';

const CORE_TRACKING = ['inventoryunits', 'inventoryunitevents', 'inventoryunitoperations'];
const PRELABELS = ['inventoryunitprelabelbatches', 'inventoryunitprelabels', 'inventoryunitprelabelpacks'];
const TRACKING = [...CORE_TRACKING, ...PRELABELS, 'inventoryunitcodes', 'inventorypacks', 'warehousetransfers'];
const RELATED = ['products', 'transactions', 'inventorymovements', 'returnrequests', 'supplierreturnorders', 'purchaseorders', 'suppliers', 'supplierledgerentries', 'vaultentries', 'warehouses', ...TRACKING, 'inventoryunitcodecounters'];

/**
 * Collections introduced after full backups were already being taken. A FULL backup written
 * before a collection existed cannot contain it, and the truth at that moment is "empty":
 * the feature did not exist yet. Filling them with [] makes the restore WIPE the live copy
 * (it only clears collections named in the backup), so the restored database is exactly the
 * state at backup time — never live labels/packs pointing at products from the newer data.
 * ⚠ Only datasets whose absence implies "no rows then" belong here. Core datasets
 * (products, transactions, units, events, counters…) stay mandatory.
 */
export const LATER_INVENTORY_DATASETS = [...PRELABELS, 'inventorypacks', 'warehousetransfers'];

/** For a full restore of an older backup: add the later datasets as empty. Returns what was added. */
export function fillLaterInventoryDatasets(data: Record<string, any>): string[] {
  if (!data || typeof data !== 'object') return [];
  const added = LATER_INVENTORY_DATASETS.filter(name => !Array.isArray(data[name]));
  for (const name of added) data[name] = [];
  return added;
}

/** Reject unsafe partial maintenance. A true result requires an atomic full restore. */
export async function assertInventoryUnitMaintenance(
  connection: Connection, collections: string[], backup?: Record<string, any[]>, fullRestore = false,
): Promise<boolean | void> {
  if (!collections.some(name => RELATED.includes(name))) return;
  const liveTracking = await Promise.all(TRACKING.map(name => connection.collection(name).countDocuments({}, { limit: 1 })));
  const backupHasTracking = TRACKING.some(name => (backup?.[name]?.length || 0) > 0);
  if (backup?.warehousetransfers?.length && !['warehouses','products','transactions','inventorymovements'].every(name => Array.isArray(backup[name]))) {
    throw new Error('Warehouse transfers require coordinated warehouse, product, transaction and movement datasets');
  }
  if (backup?.inventorypacks?.length && !['inventoryunits','inventoryunitcodecounters','users'].every(name => Array.isArray(backup[name]))) {
    throw new Error('Pack identities require their physical units, code counters and actor datasets');
  }
  if (PRELABELS.some(name => backup?.[name]?.length) && !['products', 'users', ...PRELABELS].every(name => Array.isArray(backup?.[name]))) {
    throw new Error('Preprinted identity batches and labels require the product and actor datasets together');
  }
  if (backup?.inventoryunits?.some(unit => unit.origin?.purchaseLineId || unit.origin?.purchaseOrderId) &&
    !['purchaseorders', 'suppliers', 'supplierledgerentries', 'vaultentries', 'users'].every(name => Array.isArray(backup[name]))) {
    throw new Error('Purchase receipt tracking requires the related orders, supplier, financial and actor backup datasets');
  }
  if (liveTracking.some(count => count > 0)) {
    // The caller must use one MongoDB transaction when this returns true. Never
    // permit a partial restore, or interpret missing datasets as empty datasets.
    const missing = [...RELATED, 'users'].filter(name => !collections.includes(name) || !Array.isArray(backup?.[name]));
    if (!fullRestore || missing.length) {
      throw new Error(fullRestore
        ? `النسخة الاحتياطية ناقصة ولا يمكن استعادتها بأمان مع وجود تتبع القطع — الجداول الناقصة: ${missing.join(', ')} (coordinated offline restore required)`
        : 'يوجد تتبع للقطع (QR) في قاعدة البيانات: الاستعادة الجزئية أو المسح الجزئي يكسران الربط بين القطع والمخزون والفواتير. استخدم «استعادة كاملة» لنسخة احتياطية (coordinated offline restore)');
    }
    return true;
  }
  const aliasDatasets = backup?.inventoryunitcodes?.length ? ['inventoryunitcodes', 'inventoryunitcodecounters'] : [];
  const prelabelDatasets = PRELABELS.some(name => backup?.[name]?.length) ? PRELABELS : [];
  if (backupHasTracking && (!fullRestore || !['products', 'transactions', 'inventorymovements', ...CORE_TRACKING, ...aliasDatasets, ...prelabelDatasets].every(name => Array.isArray(backup?.[name])))) {
    throw new Error('Inventory tracking requires a complete coordinated backup and full restore into a database without tracking data');
  }
  if (backupHasTracking) return true;
}
