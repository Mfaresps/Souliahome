import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { Model, Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { SettingsService } from '../../src/settings/settings.service';
import { SettingsSchema } from '../../src/settings/schemas/settings.schema';

describe('Coordinated backup restore with existing inventory tracking', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>;
  let settings: Model<any>, service: SettingsService, directory: string;
  let filename: string;
  const productId = new Types.ObjectId(), unitId = new Types.ObjectId(), actorId = new Types.ObjectId();
  const raw = (name: string) => mongo.connection.collection(name);
  const editBackup = (edit: (backup: any) => void) => {
    const file = join(directory, filename), backup = JSON.parse(readFileSync(file, 'utf8'));
    edit(backup);
    backup.collectionCounts = Object.fromEntries(Object.entries(backup.data).map(([name, docs]: [string, any[]]) => [name, docs.length]));
    writeFileSync(file, JSON.stringify(backup));
  };

  beforeAll(async () => {
    mongo = await trackingMongo();
    settings = mongo.connection.model('Settings', SettingsSchema);
    await settings.createCollection();
    for (const name of SettingsService.BACKUP_COLLECTIONS) await mongo.connection.createCollection(name);
    await raw('inventoryunits').createIndex({ barcode: 1 }, { unique: true });
    directory = mkdtempSync(join(tmpdir(), 'soulia-tracked-restore-'));
    service = new SettingsService(settings, mongo.connection);
    (service as any).getBackupDir = () => directory;
    (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  }, 40000);

  beforeEach(async () => {
    for (const name of [...SettingsService.BACKUP_COLLECTIONS, 'settings']) await raw(name).deleteMany({});
    await settings.create({ vaultCash: 100, vaultBalance: 100, r2ReceiptsMax: 500 });
    await raw('users').insertOne({ _id: actorId, username: 'admin', name: 'Admin', password: 'current-secret' });
    await raw('products').insertOne({ _id: productId, name: 'Original product', openingBalance: 2 });
    await raw('transactions').insertOne({ items: [{ productId: String(productId), lineId: 'stable-line', unitIds: [String(unitId)], purchaseOrderLineIndex: 0, qty: 1 }] });
    await raw('inventoryunits').insertOne({ _id: unitId, productId: String(productId), barcode: 'SU-TEST', status: 'available', registeredByUserId: String(actorId) });
    await raw('inventoryunitevents').insertOne({ unitId: String(unitId), sequence: 1, byUserId: String(actorId) });
    await raw('inventoryunitoperations').insertOne({ _id: 'stable-operation-key' as any, kind: 'register' });
    await raw('inventoryunitcodecounters').insertOne({ _id: 'manual-unit-code' as any, sequence: 42 });
    const result = await service.createBackup();
    expect(result.success).toBe(true); filename = result.filename;
    await raw('products').updateOne({ _id: productId }, { $set: { name: 'Current product' } });
    await settings.updateOne({}, { $set: { vaultCash: 900, vaultBalance: 900, r2ReceiptsMax: 50 } });
  });

  afterAll(async () => {
    await mongo?.close();
    if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('soulia-tracked-restore-')) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates and restores a complete backup on the populated database', async () => {
    const result = await service.restoreBackup(filename);
    expect(result.success).toBe(true);
    expect(result.safetyBackup).toBeTruthy(); expect(result.safetyBackup).not.toBe(filename);
    expect((await raw('products').findOne({ _id: productId }))!.name).toBe('Original product');
    expect((await settings.findOne())!.vaultCash).toBe(100);
    expect((await settings.findOne())!.r2ReceiptsMax).toBe(500);
    expect((await raw('transactions').findOne({}))!.items[0]).toMatchObject({ lineId: 'stable-line', unitIds: [String(unitId)], purchaseOrderLineIndex: 0 });
    expect(await raw('inventoryunitcodecounters').findOne({ _id: 'manual-unit-code' as any })).toMatchObject({ sequence: 42 });
    expect(await raw('inventoryunitoperations').findOne({ _id: 'stable-operation-key' as any })).toBeTruthy();
    expect(await raw('inventoryunits').findOne({ _id: unitId })).toBeTruthy();
    expect((await raw('users').findOne({ _id: actorId }))!.password).toBe('current-secret');
    const safety = JSON.parse(readFileSync(join(directory, result.safetyBackup), 'utf8'));
    expect(safety.data.products[0].name).toBe('Current product');
  });

  it('rolls back deletions, inserts and configuration when an inventory insert fails', async () => {
    editBackup(backup => backup.data.inventoryunits.push({ ...backup.data.inventoryunits[0], _id: new Types.ObjectId().toHexString() }));
    const result = await service.restoreBackup(filename);
    expect(result.success).toBe(false);
    expect((await raw('products').findOne({ _id: productId }))!.name).toBe('Current product');
    expect(await raw('inventoryunits').countDocuments()).toBe(1);
    expect(await raw('inventoryunitevents').countDocuments()).toBe(1);
    expect((await settings.findOne())!.vaultCash).toBe(900);
    expect((await settings.findOne())!.r2ReceiptsMax).toBe(50);
  });

  it('merges admin with a different live ID and remaps inventory actors and nested history', async () => {
    const liveAdminId = new Types.ObjectId();
    await raw('users').deleteMany({});
    await raw('users').insertOne({ _id: liveAdminId, username: 'admin', name: 'Current admin', password: 'new-password', totpSecret: 'current-totp', trustedDevices: ['current-device'] });
    editBackup(backup => {
      backup.data.inventorypacks = [{ createdByUserId: String(actorId), history: [{ byUserId: String(actorId) }], unitIds: [String(unitId)] }];
      backup.data.inventoryunitoperations[0].actorId = String(actorId);
      backup.data.inventoryunitoperations[0].fingerprint = 'unchanged-fingerprint';
      backup.data.inventoryunitoperations[0].result = { unit: { _id: String(unitId), registeredByUserId: String(actorId) }, exception: { undoneByUserId: String(actorId) } };
      backup.data.shopifyorders = [{ assignedTo: String(actorId), assignmentHistory: [{ previousUserId: String(actorId), newUserId: String(actorId) }], depositReceipts: [{ submittedById: String(actorId), reviewedById: String(actorId), warningAcknowledgedById: String(actorId) }] }];
      backup.data.employeeperformancelogs = [{ employeeId: String(actorId) }];
      backup.data.followups = [{ responsibleId: String(actorId), comments: [{ authorId: String(actorId) }] }];
    });
    const originalFile = readFileSync(join(directory, filename), 'utf8');
    const result = await service.restoreBackup(filename);
    expect(result.success).toBe(true);
    expect(await raw('users').countDocuments()).toBe(1);
    expect(await raw('users').findOne({ _id: liveAdminId })).toMatchObject({ password: 'new-password', totpSecret: 'current-totp', trustedDevices: ['current-device'] });
    expect(await raw('inventoryunits').findOne({ _id: unitId })).toMatchObject({ registeredByUserId: String(liveAdminId), productId: String(productId) });
    expect(await raw('inventoryunitevents').findOne({})).toMatchObject({ byUserId: String(liveAdminId), unitId: String(unitId) });
    expect(await raw('inventorypacks').findOne({})).toMatchObject({ createdByUserId: String(liveAdminId), history: [{ byUserId: String(liveAdminId) }], unitIds: [String(unitId)] });
    expect(await raw('inventoryunitoperations').findOne({})).toMatchObject({ _id: 'stable-operation-key', actorId: String(liveAdminId), fingerprint: 'unchanged-fingerprint', result: { unit: { _id: String(unitId), registeredByUserId: String(liveAdminId) }, exception: { undoneByUserId: String(liveAdminId) } } });
    expect(await raw('shopifyorders').findOne({})).toMatchObject({ assignedTo: String(liveAdminId), assignmentHistory: [{ previousUserId: String(liveAdminId), newUserId: String(liveAdminId) }], depositReceipts: [{ submittedById: String(liveAdminId), reviewedById: String(liveAdminId), warningAcknowledgedById: String(liveAdminId) }] });
    expect(await raw('employeeperformancelogs').findOne({})).toMatchObject({ employeeId: String(liveAdminId) });
    expect(await raw('followups').findOne({})).toMatchObject({ responsibleId: String(liveAdminId), comments: [{ authorId: String(liveAdminId) }] });
    expect(readFileSync(join(directory, filename), 'utf8')).toBe(originalFile);
  });

  it.each(['inventoryunits', 'inventoryunitcodecounters', 'warehouses', 'users'])('rejects a backup missing %s before changing data', async name => {
    editBackup(backup => { delete backup.data[name]; });
    const result = await service.restoreBackup(filename);
    expect(result.success).toBe(false);
    expect((await raw('products').findOne({ _id: productId }))!.name).toBe('Current product');
    expect(await raw('inventoryunits').countDocuments()).toBe(1);
  });

  it('rolls back all tracking changes if restoring an actor fails at the end', async () => {
    editBackup(backup => backup.data.users.push({ _id: String(actorId), username: 'conflicting-user', name: 'Conflict' }));
    const result = await service.restoreBackup(filename);
    expect(result.success).toBe(false);
    expect((await raw('products').findOne({ _id: productId }))!.name).toBe('Current product');
    expect(await raw('inventoryunits').countDocuments()).toBe(1);
    expect(await raw('users').countDocuments()).toBe(1);
    expect((await settings.findOne())!.r2ReceiptsMax).toBe(50);
  });

  it('preserves both backup files when created in the same second', async () => {
    jest.spyOn(service as any, 'formatDateTime').mockReturnValue('2026-10-21T10-00-00');
    try {
      const first = await service.createBackup(), second = await service.createBackup();
      expect(first.success && second.success).toBe(true);
      expect(first.filename).not.toBe(second.filename);
      expect(readFileSync(join(directory, first.filename), 'utf8')).toBeTruthy();
      expect(readFileSync(join(directory, second.filename), 'utf8')).toBeTruthy();
    } finally { jest.restoreAllMocks(); }
  });
});
