import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SettingsService } from '../../src/settings/settings.service';

/**
 * Guards the destructive half of selective restore.
 *
 * The bug this exists to prevent: restoring an OLD backup (taken before a collection existed)
 * would `deleteMany({})` that collection and then insert nothing — silently destroying live data
 * while reporting success. "Absent from the backup" must never be treated as "empty in the backup".
 */
describe('SettingsService.selectiveRestoreBackup — destructive safety', () => {
  let tmpCwd: string;
  let originalCwd: string;
  let deleted: string[];
  let inserted: Record<string, any[]>;
  let service: SettingsService;

  const BACKUP_FILE = 'backup_test-restore.json';

  /** Minimal stand-in for the mongoose Connection surface the service actually uses. */
  const makeConnection = () => ({
    collection: (name: string) => ({
      deleteMany: async () => {
        deleted.push(name);
        return { deletedCount: 0 };
      },
      insertMany: async (docs: any[]) => {
        inserted[name] = docs;
        return { insertedCount: docs.length };
      },
      find: () => ({ toArray: async () => [] }),
      countDocuments: async () => 0,
      findOne: async () => null,
    }),
  });

  const writeBackup = (data: Record<string, any[]>) => {
    fs.writeFileSync(
      path.join(tmpCwd, 'backups', BACKUP_FILE),
      JSON.stringify({ timestamp: new Date().toISOString(), data }),
    );
  };

  beforeEach(() => {
    deleted = [];
    inserted = {};
    originalCwd = process.cwd();
    // getBackupDir() resolves against process.cwd(), so isolate it to a temp dir.
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soulia-restore-'));
    fs.mkdirSync(path.join(tmpCwd, 'backups'), { recursive: true });
    process.chdir(tmpCwd);

    const settingsModel: any = { findOne: () => ({ exec: async () => null }) };
    service = new SettingsService(settingsModel, makeConnection() as any);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('does NOT delete a collection that is absent from the backup', async () => {
    // An old backup: has products, but predates categories/collections entirely.
    writeBackup({ products: [{ _id: 'p1', code: 'A', name: 'item' }] });

    const res = await service.selectiveRestoreBackup(BACKUP_FILE, ['products']);

    expect(res.success).toBe(true);
    expect(deleted).toContain('products');
    // The whole point: these must be left alone, not wiped.
    expect(deleted).not.toContain('categories');
    expect(deleted).not.toContain('collections');
    expect(deleted).not.toContain('collectionproducts');
    expect(inserted['products']).toHaveLength(1);
  });

  it('still clears a collection the backup explicitly records as empty', async () => {
    // An empty array is a real recorded state — "there were genuinely no categories".
    writeBackup({ products: [], categories: [] });

    await service.selectiveRestoreBackup(BACKUP_FILE, ['products']);

    expect(deleted).toContain('products');
    expect(deleted).toContain('categories');
  });

  it('reports skipped collections distinctly from restored-but-empty ones', async () => {
    writeBackup({ products: [], categories: [] });

    const res = await service.selectiveRestoreBackup(BACKUP_FILE, ['products']);

    expect(res.restored['categories']).toBe(0); // present & empty → cleared
    expect(res.restored['collections']).toBe(-2); // absent → skipped, untouched
  });

  it('restores documents into collections the backup does contain', async () => {
    writeBackup({
      products: [{ _id: '507f1f77bcf86cd799439011', code: 'A' }],
      categories: [{ _id: '507f1f77bcf86cd799439012', name: 'cat' }],
    });

    await service.selectiveRestoreBackup(BACKUP_FILE, ['products']);

    expect(inserted['categories']).toHaveLength(1);
    // migrateDoc() backfills fields added after older backups were written.
    expect(inserted['categories'][0].isActive).toBe(true);
    expect(inserted['products'][0].sellPrice).toBe(0);
  });
});
