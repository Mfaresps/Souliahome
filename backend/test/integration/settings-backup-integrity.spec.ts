import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SettingsService } from '../../src/settings/settings.service';
import { computeDepositFieldsFromReceipts } from '../../src/shopify/deposit-receipts.util';

describe('complete backups and receipt data independent of image storage', () => {
  let directory: string;
  let service: SettingsService;
  let source: Record<string, any[]>;
  let inserted: Record<string, any[]>;
  let deleted: string[];
  let failedCollection: string;
  let config: Record<string, any>;
  const receipt = {
    id: 'r1', status: 'معتمد', amount: 750, method: 'Instapay',
    imageKey: 'deposit-receipts/deleted.jpg', imageDeleted: true,
    imageSha256: 'hash', imageBytes: 180 * 1024,
    ocr: { amount: 750, method: 'Instapay', reference: 'TRANSFER-1', pattern: 'instapay', confident: true, ran: true, ms: 20, dateText: '2026-10-10' },
    warnings: [{ code: 'not-transfer', orderRef: '' }], needsReview: true,
    warningAcknowledgedAt: '2026-10-10T01:00:00Z', warningAcknowledgedById: 'employee',
    submittedBy: 'Employee', submittedById: 'employee', submittedAt: '2026-10-10T01:00:00Z', uploadedAt: '2026-10-10T00:00:00Z',
    reviewedBy: 'Manager', reviewedById: 'manager', reviewedAt: '2026-10-10T02:00:00Z',
    lastEditedBy: 'Employee', lastEditedAt: '2026-10-10T01:30:00Z', vaultEntryId: 'v1', vaultTxNo: 'SAL-1',
    refundReason: '', refundVaultTxNo: '',
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soulia-backup-integrity-'));
    source = Object.fromEntries(SettingsService.BACKUP_COLLECTIONS.map(name => [name, []]));
    source.shopifyorders = [{ _id: '507f1f77bcf86cd799439011', ref: '123', total: 1000, depositAmount: 750, depositMethod: 'Instapay', depositPercentage: 75, depositStatus: 'partial', depositReceipts: [receipt] }];
    source.transactions = [{ deposit: 750, depMethod: 'Instapay', remaining: 250, depositReceipts: [receipt], deposits: [{ id: 'r1', amount: 750, method: 'Instapay', receiptId: 'r1', vaultTxNo: 'SAL-1' }], depositRefunds: [{ receiptId: 'old', amount: 100 }] }];
    source.vaultentries = [{ amount: 750, method: 'Instapay' }];
    source.newfeaturedata = [{ futureField: { enabled: true, amount: 123 } }];
    source.carrierimports = [{ importNo: 'IMP-1' }];
    source.carrierpayouts = [{ amount: 200 }];
    source.orderaudits = [{ fromOrder: 123 }];
    inserted = {}; deleted = []; failedCollection = '';
    config = { r2ReceiptsMax: 500, r2Keep: 3, performanceConfig: { depositFullPoints: 8 },
      vaultCash: 0, vaultVodafone: 0, vaultInstapay: 750, vaultBank: 0,
      discountCodes: [], discountBundles: [], vaultPass: 'test-password',
      bostaApiKey: 'test-api-key', bostaWebhookSecret: 'test-webhook-secret',
      r2SecretAccessKey: 'test-storage-secret', r2AccountId: 'current-account', r2AccessKeyId: 'current-key', r2Bucket: 'current-bucket' };
    const settingsDoc: Record<string, any> = {
      ...config,
      toObject: () => ({ ...config }),
      set: (next: any) => { Object.assign(config, next); Object.assign(settingsDoc, next); },
      markModified: jest.fn(), save: jest.fn(async (): Promise<Record<string, any>> => settingsDoc),
    };
    const connection: any = {
      models: { FutureFeature: { collection: { collectionName: 'newfeaturedata' } }, Settings: { collection: { collectionName: 'settings' } } },
      collection: (name: string) => ({
        find: () => ({ toArray: async () => {
          if (name === failedCollection) throw new Error('database read failed');
          return JSON.parse(JSON.stringify(source[name] || []));
        } }),
        deleteMany: async () => { deleted.push(name); },
        insertMany: async (docs: any[]) => { inserted[name] = docs; },
        countDocuments: async () => (source[name] || []).length,
        findOne: async () => null,
      }),
    };
    service = new SettingsService({ findOne: () => ({ exec: async () => settingsDoc }) } as any, connection);
    (service as any).getBackupDir = () => directory;
    (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('soulia-backup-integrity-')) throw new Error('Unexpected test directory');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('captures all receipt fields, new registered collections and operational settings', async () => {
    const result = await service.createBackup();
    expect(result.success).toBe(true);
    const backup = JSON.parse(fs.readFileSync(path.join(directory, result.filename), 'utf8'));
    expect(backup.data.shopifyorders[0].depositReceipts[0]).toEqual(receipt);
    expect(backup.data.transactions[0].deposit).toBe(750);
    expect(backup.data.transactions[0].deposits).toEqual(source.transactions[0].deposits);
    expect(backup.data.newfeaturedata).toEqual(source.newfeaturedata);
    for (const name of ['carrierimports', 'carrierpayouts', 'orderaudits']) expect(backup.data[name]).toEqual(source[name]);
    expect(backup.configuration).toMatchObject({ r2ReceiptsMax: 500, r2Keep: 3, performanceConfig: { depositFullPoints: 8 } });
    for (const secret of ['vaultPass', 'bostaApiKey', 'bostaWebhookSecret', 'r2SecretAccessKey']) expect(backup.configuration[secret]).toBeUndefined();
    expect(backup.data.settings).toBeUndefined();
    expect(backup.vault_balances.vaultInstapay).toBe(750);
    for (const [name, docs] of Object.entries(backup.data)) expect(backup.collectionCounts[name]).toBe((docs as any[]).length);
  });

  it.each(['shopifyorders', 'carrierimports', 'newfeaturedata'])('fails the backup rather than silently losing %s', async name => {
    failedCollection = name;
    const result = await service.createBackup();
    expect(result.success).toBe(false);
    expect(result.message).toContain(name);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('keeps existing backups and never uploads or prunes after a failed daily backup', async () => {
    fs.writeFileSync(path.join(directory, 'existing.json'), 'existing backup');
    failedCollection = 'shopifyorders';
    const prune = jest.spyOn(service as any, 'pruneAutoBackups');
    const upload = jest.spyOn(service, 'uploadBackupToR2');
    await service.runScheduledBackup();
    expect(prune).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual(['existing.json']);
  });

  it('does not publish partial backup files after a filesystem failure', async () => {
    // Spy on the original CommonJS module rather than the TS namespace getters.
    const rename = jest.spyOn(require('fs'), 'renameSync').mockImplementation(() => { throw new Error('disk failure'); });
    const result = await service.createBackup(); rename.mockRestore();
    expect(result.success).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each(['full', 'selective'])('restores %s financial data with deleted images and preserves current credentials', async mode => {
    const result = await service.createBackup();
    config.r2ReceiptsMax = 50;
    const file = path.join(directory, result.filename);
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    backup.configuration.r2Bucket = 'old-bucket';
    backup.configuration.r2SecretAccessKey = 'old-secret';
    fs.writeFileSync(file, JSON.stringify(backup));
    const restored = mode === 'full' ? await service.restoreBackup(result.filename)
      : await service.selectiveRestoreBackup(result.filename, ['transactions', 'other', 'vault']);
    expect(restored.success).toBe(true);
    expect(inserted.shopifyorders[0].depositReceipts[0]).toEqual(receipt);
    expect(inserted.transactions[0].deposits).toEqual(source.transactions[0].deposits);
    expect(inserted.transactions[0].depositRefunds).toEqual(source.transactions[0].depositRefunds);
    expect(inserted.transactions[0].remaining).toBe(250);
    expect(inserted.newfeaturedata).toEqual(source.newfeaturedata);
    expect(config.r2ReceiptsMax).toBe(500);
    expect(config.r2Bucket).toBe('current-bucket');
    expect(config.r2SecretAccessKey).toBe('test-storage-secret');
    expect(computeDepositFieldsFromReceipts(inserted.shopifyorders[0]).depositAmount).toBe(750);
  });

  it.each(['full', 'selective'])('rejects incomplete new backups before %s restore changes live data', async mode => {
    const result = await service.createBackup();
    const file = path.join(directory, result.filename);
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete backup.data.shopifyorders;
    fs.writeFileSync(file, JSON.stringify(backup));
    const restored = mode === 'full' ? await service.restoreBackup(result.filename)
      : await service.selectiveRestoreBackup(result.filename, ['other']);
    expect(restored.success).toBe(false);
    expect(deleted).toEqual([]); expect(inserted).toEqual({});
  });

  it('refuses to register an uploaded new backup that is missing declared data', async () => {
    const result = await service.createBackup();
    const backup = JSON.parse(fs.readFileSync(path.join(directory, result.filename), 'utf8'));
    backup.data.shopifyorders = [];
    const uploaded = await service.uploadBackup({ originalname: 'incomplete.json', buffer: Buffer.from(JSON.stringify(backup)) });
    expect(uploaded.success).toBe(false);
    expect(fs.existsSync(path.join(directory, 'backup_incomplete.json'))).toBe(false);
    expect(await service.getBackupList()).toHaveLength(1);
  });
});
