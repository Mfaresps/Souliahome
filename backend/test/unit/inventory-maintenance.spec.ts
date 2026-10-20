import { assertInventoryUnitMaintenance } from '../../src/inventory-units/inventory-unit-maintenance';

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

  it('allows a coordinated full dataset into a database without tracking data', async () => {
    const backup = complete();
    backup.warehousetransfers.push({});
    backup.inventorypacks.push({});
    await expect(assertInventoryUnitMaintenance(connection(), Object.keys(backup), backup, true)).resolves.toBeUndefined();
  });
});
