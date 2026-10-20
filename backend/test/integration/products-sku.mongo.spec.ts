import mongoose, { Connection, Model } from 'mongoose';
import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { ProductSchema } from '../../src/products/schemas/product.schema';
import { ProductsService } from '../../src/products/products.service';

// Starts its OWN disposable MongoDB. Never reads MONGODB_URI or connects to a running app DB.
const binary = process.env.SOULIA_TEST_MONGOD || 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe';
const isolated = existsSync(binary) ? describe : describe.skip;
isolated('SKU guarantees against isolated real MongoDB', () => {
  let processHandle: ChildProcess, connection: Connection, model: Model<any>, service: ProductsService, directory: string;
  beforeAll(async () => {
    const port = await new Promise<number>((done, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address() as any; server.close(() => done(address.port)); });
    });
    directory = mkdtempSync(join(tmpdir(), 'soulia-phase2-mongo-'));
    processHandle = spawn(binary, ['--dbpath', directory, '--bind_ip', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: 'ignore' });
    let spawnError: Error | undefined;
    processHandle.on('error', error => { spawnError = error; });
    connection = mongoose.createConnection(`mongodb://127.0.0.1:${port}/phase2_scratch`, { serverSelectionTimeoutMS: 15000 });
    await connection.asPromise();
    if (spawnError) throw spawnError;
    model = connection.model('Product', ProductSchema);
    await model.init(); // Creates indexes ONLY in this disposable database.
    service = new ProductsService(model as any, {} as any, {} as any, { emitEvent() {} } as any, {} as any);
  }, 30000);
  afterAll(async () => {
    await connection?.close();
    if (processHandle?.pid && processHandle.exitCode === null) {
      await new Promise<void>(done => { processHandle.once('exit', () => done()); processHandle.kill(); });
    }
    // Delete only the exact temp directory created by this suite, after Mongo exits.
    if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep + 'soulia-phase2-mongo-')) rmSync(directory, { recursive: true, force: true });
  });
  it('lets independent service instances create 20 same-prefix products without duplicates', async () => {
    const second = new ProductsService(model as any, {} as any, {} as any, { emitEvent() {} } as any, {} as any);
    const rows = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? service : second).create({ name: `Shared Prefix ${i}` })));
    expect(new Set(rows.map(row => row.code)).size).toBe(20);
    expect(await model.countDocuments()).toBe(20);
  });
  it('rejects concurrent manual SKU collisions with exactly one persisted winner', async () => {
    const rows = await Promise.allSettled([service.create({ code: 'FIXED', name: 'Fixed One' }), service.create({ code: 'FIXED', name: 'Fixed Two' })]);
    expect(rows.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await model.countDocuments({ code: 'FIXED' })).toBe(1);
  });
  it('defends direct document, updateOne, updateMany and bulkWrite SKU writes at schema level', async () => {
    const row = await model.create({ code: 'IMMUTABLE', name: 'Before' });
    row.code = 'DOC'; row.colors = ['Red']; await row.save();
    await model.updateOne({ _id: row._id }, { $set: { code: 'ONE', size: 'Large' } });
    await model.updateMany({ _id: row._id }, { $set: { code: 'MANY', sellPrice: 50 } });
    await model.bulkWrite([{ updateOne: { filter: { _id: row._id }, update: { $set: { code: 'BULK', buyPrice: 10 } } } }]);
    expect((await model.findById(row._id).lean()) as any).toMatchObject({ code: 'IMMUTABLE', colors: ['Red'], size: 'Large', sellPrice: 50, buyPrice: 10 });
  });
});
