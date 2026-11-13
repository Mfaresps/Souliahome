import { assertInventoryUnitMaintenance, fillLaterInventoryDatasets, LATER_INVENTORY_DATASETS } from '../../src/inventory-units/inventory-unit-maintenance';

describe('warehouse and pack backup maintenance guards', () => {
  const connection = (counts: Record<string, number> = {}) => ({
    collection: (name: string) => ({ countDocuments: async () => counts[name] || 0 }),
  } as any);
  const complete = () => Object.fromEntries([
    'warehouses', 'warehousetransfers', 'products', 'transactions', 'inventorymovements',
    'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations',
    'inventorypacks', 'inventoryunitcodecounters', 'users',
  ].map(name => [name, [] as any[]]));

  it('blocks partial maintenance when warehouse transfer history exists', async () => {
    await expect(assertInventoryUnitMaintenance(connection({ warehousetransfers: 1 }), ['products']))
      .rejects.toThrow('coordinated offline restore');
  });

  it('blocks a transfer restore without its warehouse and movement datasets', async () => {
    await expect(assertInventoryUnitMaintenance(connection(), ['warehousetransfers'], { warehousetransfers: [{}] }, true))
      .rejects.toThrow('coordinated warehouse');
  });

  it('blocks pack restoration without physical units, counters and actors', async () => {
    await expect(assertInventoryUnitMaintenance(connection(), ['inventorypacks'], { inventorypacks: [{}] }, true))
      .rejects.toThrow('physical units');
  });

  it('restores a full backup taken before the label/pack collections existed', async () => {
    const related = ['products', 'transactions', 'inventorymovements', 'returnrequests', 'supplierreturnorders',
      'purchaseorders', 'suppliers', 'supplierledgerentries', 'vaultentries', 'warehouses', 'inventoryunits',
      'inventoryunitevents', 'inventoryunitoperations', 'inventoryunitcodes', 'inventoryunitcodecounters', 'users'];
    const old: Record<string, any[]> = Object.fromEntries(related.map(name => [name, [] as any[]]));
    const live = connection({ inventoryunits: 5, inventoryunitprelabels: 3 });
    // Without the fill it is refused, naming the missing collections.
    await expect(assertInventoryUnitMaintenance(live, Object.keys(old), { ...old }, true))
      .rejects.toThrow('inventoryunitprelabelpacks');
    expect(fillLaterInventoryDatasets(old)).toEqual(LATER_INVENTORY_DATASETS);
    await expect(assertInventoryUnitMaintenance(live, Object.keys(old), old, true)).resolves.toBe(true);
    // A core dataset stays mandatory.
    delete old.inventoryunits;
    await expect(assertInventoryUnitMaintenance(live, Object.keys(old), old, true)).rejects.toThrow('inventoryunits');
    // Present datasets are never overwritten.
    const kept = { inventorypacks: [{ _id: 'x' }] };
    fillLaterInventoryDatasets(kept);
    expect(kept.inventorypacks).toHaveLength(1);
  });

  it('allows a coordinated full dataset into a database without tracking data', async () => {
    const backup = complete();
    backup.warehousetransfers.push({});
    backup.inventorypacks.push({});
    await expect(assertInventoryUnitMaintenance(connection(), Object.keys(backup), backup, true)).resolves.toBe(true);
  });
});
