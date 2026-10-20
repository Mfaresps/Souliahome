import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { BSON } from 'mongodb';
import { execFileSync } from 'child_process';
import { trackingMongo } from '../helpers/tracking-mongo';
const { copyDatabase, restoreDatabase, verifyDatabase, readManifest, localUri } = require('../../../scripts/local-replica-copy.cjs');

describe('Local development replica copy and recovery (owned disposable databases)', () => {
  let source: Awaited<ReturnType<typeof trackingMongo>>, target: Awaited<ReturnType<typeof trackingMongo>>;
  let directory: string;
  beforeAll(async () => {
    source = await trackingMongo(false); target = await trackingMongo(true);
    await target.connection.db!.admin().command({ setParameter: 1, ttlMonitorEnabled: false });
    directory = mkdtempSync(join(tmpdir(), 'soulia-replica-copy-'));
    const db = source.connection.db!;
    await db.createCollection('empty');
    await db.collection('products').insertOne({ _id: new BSON.ObjectId(), code: 'SKU', openingBalance: 3,
      variants: ['أحمر', 'كبير'], date: new Date('2026-01-01'), long: BSON.Long.fromString('9007199254740993'),
      decimal: BSON.Decimal128.fromString('12.3400'), binary: new BSON.Binary(Buffer.from([0, 255])),
      int: new BSON.Int32(42), double: new BSON.Double(42), regex: new BSON.BSONRegExp('foo', 'i'),
      timestamp: new BSON.Timestamp({ t: 10, i: 2 }), min: new BSON.MinKey(), max: new BSON.MaxKey() });
    await db.collection('products').createIndex({ code: 1 }, { unique: true, name: 'sku_unique' });
    await db.collection('transactions').insertOne({ type: 'مشتريات', total: 130, deposit: 30, remaining: 100 });
    await db.collection('vaultentries').insertOne({ amount: -30, movementId: 'original' });
    await db.collection('expiring').insertOne({ when: new Date(), reference: 'retained' });
    await db.collection('expiring').createIndex({ when: 1 }, { expireAfterSeconds: 3600 });
  }, 60000);
  afterAll(async () => {
    if (source) await source.close(); if (target) await target.close();
    if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('soulia-replica-copy-')) rmSync(directory, { recursive: true, force: true });
  });
  it('copies exact BSON bytes, indexes and empty collections; preserves source and unlocks it', async () => {
    const backup = join(directory, 'backup');
    const result = await copyDatabase(source.connection.db!, target.connection.db!, backup);
    expect(result).toEqual({ collections: 5, documents: 4, verified: true });
    expect(await source.connection.db!.admin().command({ currentOp: 1 })).not.toHaveProperty('fsyncLock', true);
    expect(await target.connection.db!.collection('inventoryunits').countDocuments()).toBe(0);
    expect(await verifyDatabase(source.connection.db!, readManifest(backup))).toEqual(result);
    await expect(restoreDatabase(target.connection.db!, backup)).rejects.toThrow('empty');
  }, 30000);
  it('recovers from a verified backup into a fresh database and refuses corrupted backups before writing', async () => {
    const backup = join(directory, 'backup');
    const client = target.connection.getClient();
    const recovered = client.db('recovery_scratch');
    expect((await restoreDatabase(recovered, backup)).verified).toBe(true);
    const manifest = readManifest(backup), file = join(backup, manifest.collections.find((r: any) => r.count > 0).filename);
    const bytes = readFileSync(file); writeFileSync(file, Buffer.from('corrupted'));
    const rejected = client.db('corruption_scratch');
    await expect(restoreDatabase(rejected, backup)).rejects.toThrow('checksum');
    expect(await rejected.listCollections().toArray()).toEqual([]);
    writeFileSync(file, bytes);
    await recovered.collection('products').updateOne({}, { $set: { openingBalance: 999 } });
    await expect(verifyDatabase(recovered, manifest)).rejects.toThrow('fingerprint');
  }, 30000);
  it('unlocks source after an interrupted copy without deleting existing target records', async () => {
    const db = target.connection.getClient().db('interruption_scratch');
    await expect(copyDatabase(source.connection.db!, db, join(directory, 'backup'))).rejects.toThrow();
    expect(await source.connection.db!.admin().command({ currentOp: 1 })).not.toHaveProperty('fsyncLock', true);
    expect(await db.listCollections().toArray()).toEqual([]);
    await db.collection('legitimate').insertOne({ retained: true });
    await expect(copyDatabase(source.connection.db!, db, join(directory, 'another'))).rejects.toThrow('empty');
    expect(await db.collection('legitimate').countDocuments()).toBe(1);
  });
  it('rejects external, authenticated and ambiguous database addresses', () => {
    for (const uri of ['mongodb://example.com/soulia', 'mongodb://user:pass@localhost/soulia', 'mongodb://localhost/', 'mongodb+srv://localhost/soulia']) {
      expect(() => localUri(uri)).toThrow();
    }
    expect(localUri('mongodb://127.0.0.1:27018/soulia').port).toBe('27018');
  });
  it('runs the real built-schema index CLI twice without creating units or changing copied data', async () => {
    const script = resolve(__dirname, '../../../scripts/inventory-unit-indexes.cjs');
    const uri = `mongodb://${target.connection.host}:${target.connection.port}/${target.connection.name}?directConnection=true`;
    const options = { env: { ...process.env, SOULIA_INDEX_TEST_URI: uri }, encoding: 'utf8' as const };
    const args = [script, '--uri-env', 'SOULIA_INDEX_TEST_URI', '--db', target.connection.name];
    const applied = JSON.parse(execFileSync(process.execPath, [...args, '--apply'], options));
    expect(applied.applied).toBe(true);
    const ready = JSON.parse(execFileSync(process.execPath, args, options));
    expect(ready.collections.every((row: any) => row.exists && !row.missing.length)).toBe(true);
    expect(JSON.parse(execFileSync(process.execPath, [...args, '--apply'], options)).collections.every((row: any) => !row.missing.length)).toBe(true);
    expect(await target.connection.db!.collection('inventoryunits').countDocuments()).toBe(0);
    expect((await verifyDatabase(target.connection.db!, readManifest(join(directory, 'backup')), true)).verified).toBe(true);
  }, 30000);
});
