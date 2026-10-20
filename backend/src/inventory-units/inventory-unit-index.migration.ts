import { Connection } from 'mongoose';
import { InventoryUnitSchema } from './schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from './schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from './schemas/inventory-unit-operation.schema';

export const INVENTORY_UNIT_INDEX_PLAN = [
  { collection: 'inventoryunits', indexes: InventoryUnitSchema.indexes() },
  { collection: 'inventoryunitevents', indexes: InventoryUnitEventSchema.indexes() },
  { collection: 'inventoryunitoperations', indexes: InventoryUnitOperationSchema.indexes() },
];

/** Explicit additive migration, not a startup hook. No documents, existing indexes or balances are changed. */
export async function migrateInventoryUnitIndexes(db: NonNullable<Connection['db']>, apply = false) {
  const collections = [];
  for (const plan of INVENTORY_UNIT_INDEX_PLAN) {
    const exists = await db.listCollections({ name: plan.collection }, { nameOnly: true }).hasNext();
    const current = exists ? await db.collection(plan.collection).listIndexes().toArray() : [];
    const missing: string[] = [];
    for (const [key, options] of plan.indexes) {
      const sameName = current.find(index => index.name === options.name);
      const sameKey = current.find(index => JSON.stringify(index.key) === JSON.stringify(key));
      const existing = sameName || sameKey;
      if (!existing) { missing.push(String(options.name)); continue; }
      if (JSON.stringify(existing.key) !== JSON.stringify(key) || !!existing.unique !== !!options.unique ||
        existing.sparse || existing.partialFilterExpression || existing.collation || existing.expireAfterSeconds != null) {
        throw new Error(`Conflicting inventory index ${plan.collection}/${options.name}; manual review required`);
      }
    }
    if (current.some(index => index.expireAfterSeconds != null)) throw new Error('Inventory tracking records must not have TTL indexes');
    collections.push({ name: plan.collection, exists, missing });
  }
  if (apply) {
    for (const plan of INVENTORY_UNIT_INDEX_PLAN) {
      const missing = collections.find(row => row.name === plan.collection)!.missing;
      for (const [key, options] of plan.indexes) {
        if (missing.includes(String(options.name))) await db.collection(plan.collection).createIndex(
          key as Record<string, 1 | -1>, { name: String(options.name), ...(options.unique ? { unique: true } : {}) },
        );
      }
    }
  }
  return { applied: apply, collections };
}
