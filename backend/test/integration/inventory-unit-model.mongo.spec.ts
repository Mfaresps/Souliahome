import mongoose, { Connection, Model, Types } from 'mongoose';
import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { ProductSchema } from '../../src/products/schemas/product.schema';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { InventoryMovementSchema } from '../../src/inventory-movements/schemas/inventory-movement.schema';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';

const binary = process.env.SOULIA_TEST_MONGOD || 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe';
const isolated = existsSync(binary) ? describe : describe.skip;
isolated('Inventory unit schema/index migration in disposable MongoDB', () => {
  let child: ChildProcess, connection: Connection, directory: string;
  let Unit: Model<any>, Event: Model<any>, Product: Model<any>, Transaction: Model<any>, Movement: Model<any>;
  let productId: string, actorId: string, purchaseId: string, saleId: string;
  const raw = (name: string) => connection.collection(name);
  const piece = (extra: any = {}) => ({ productId, registeredByUserId: actorId, registeredBy: 'Counter',
    origin: { kind: 'legacy-unknown', reconciliationRef: 'PHYSICAL-COUNT-1' }, ...extra });
  const event = (unitId: any, extra: any = {}) => ({ unitId: String(unitId), sequence: 1, operationKey: 'register:1',
    action: 'registered', toStatus: 'inspection-required', byUserId: actorId, by: 'Counter', ...extra });

  beforeAll(async () => {
    const port = await new Promise<number>((done, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address() as any; server.close(() => done(address.port)); });
    });
    directory = mkdtempSync(join(tmpdir(), 'soulia-unit-model-mongo-'));
    child = spawn(binary, ['--dbpath', directory, '--bind_ip', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: 'ignore' });
    let spawnError: Error | undefined; child.on('error', error => { spawnError = error; });
    connection = mongoose.createConnection(`mongodb://127.0.0.1:${port}/inventory_model_scratch`, { serverSelectionTimeoutMS: 15000, autoCreate: false, autoIndex: false });
    await connection.asPromise(); if (spawnError) throw spawnError;
    Unit = connection.model('InventoryUnit', InventoryUnitSchema); Event = connection.model('InventoryUnitEvent', InventoryUnitEventSchema);
    Product = connection.model('Product', ProductSchema); Transaction = connection.model('Transaction', TransactionSchema); Movement = connection.model('InventoryMovement', InventoryMovementSchema);
    productId = new Types.ObjectId().toHexString(); actorId = new Types.ObjectId().toHexString();
    purchaseId = new Types.ObjectId().toHexString(); saleId = new Types.ObjectId().toHexString();
    // Raw inserts here create ONLY test fixtures in this new local process, never application data.
    await raw('products').insertOne({ _id: new Types.ObjectId(productId), code: 'EXISTING', name: 'Existing', openingBalance: 0 });
    await raw('users').insertOne({ _id: new Types.ObjectId(actorId), name: 'Counter' });
    await raw('transactions').insertMany([
      { _id: new Types.ObjectId(purchaseId), type: 'مشتريات', ref: '100', total: 100, deposit: 20, remaining: 80, items: [{ code: 'EXISTING', qty: 2 }] },
      { _id: new Types.ObjectId(saleId), type: 'مبيعات', ref: '200', total: 80, items: [{ code: 'EXISTING', qty: 1, lineId: 'line-1' }] },
    ]);
    await raw('vaultentries').insertOne({ amount: -20, seg: 'cash', status: 'completed' });
  }, 30000);
  afterAll(async () => {
    await connection?.close();
    if (child?.pid && child.exitCode === null) await new Promise<void>(done => { child.once('exit', () => done()); child.kill(); });
    if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep + 'soulia-unit-model-mongo-')) rmSync(directory, { recursive: true, force: true });
  });

  it('registers models and previews indexes without creating collections or physical units', async () => {
    await Unit.init(); await Event.init();
    const before = await connection.db!.listCollections().toArray();
    const preview = await migrateInventoryUnitIndexes(connection.db!);
    expect(preview.applied).toBe(false); expect(preview.collections.every(row => !row.exists)).toBe(true);
    expect(await connection.db!.listCollections().toArray()).toEqual(before);
    expect(await Unit.countDocuments()).toBe(0);
  });
  it('adds only new indexes and can be applied twice without changing any legacy document or quantity', async () => {
    const before = await Promise.all(['products', 'transactions', 'vaultentries'].map(name => raw(name).find({}).toArray()));
    await migrateInventoryUnitIndexes(connection.db!, true);
    const repeated = await migrateInventoryUnitIndexes(connection.db!, true);
    expect(repeated.collections.every(row => row.missing.length === 0)).toBe(true);
    expect(await Promise.all(['products', 'transactions', 'vaultentries'].map(name => raw(name).find({}).toArray()))).toEqual(before);
    expect(await Unit.countDocuments()).toBe(0); expect(await Event.countDocuments()).toBe(0);
  });
  it('generates distinct pieces for the same SKU only when explicitly saved, without changing stock fields', async () => {
    const before = await raw('products').findOne({ _id: new Types.ObjectId(productId) });
    const units = await Promise.all(Array.from({ length: 12 }, () => Unit.create(piece())));
    expect(new Set(units.map(row => row.barcode)).size).toBe(12);
    expect(await raw('products').findOne({ _id: new Types.ObjectId(productId) })).toEqual(before);
  });
  it('enforces barcode uniqueness in the database, including raw-driver writes', async () => {
    const unit = await Unit.create(piece());
    await expect(raw('inventoryunits').insertOne({ ...unit.toObject(), _id: new Types.ObjectId() })).rejects.toMatchObject({ code: 11000 });
  });
  it('enforces unique event sequences and per-unit operation keys under concurrency', async () => {
    const unit = await Unit.create(piece());
    const attempts = await Promise.allSettled([Event.create(event(unit._id)), Event.create(event(unit._id))]);
    expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    await expect(Event.create(event(unit._id, { sequence: 2 }))).rejects.toMatchObject({ code: 11000 });
    await expect(Event.create(event(unit._id, { operationKey: 'other-operation' }))).rejects.toMatchObject({ code: 11000 });
  });
  it('requires existing product and actor references', async () => {
    await expect(Unit.create(piece({ productId: new Types.ObjectId().toHexString() }))).rejects.toThrow('Product does not exist');
    await expect(Unit.create(piece({ registeredByUserId: new Types.ObjectId().toHexString() }))).rejects.toThrow('User does not exist');
  });
  it('canonicalizes reference IDs so case cannot bypass parent retention or event uniqueness', async () => {
    const unit = await Unit.create(piece({ productId: productId.toUpperCase(), registeredByUserId: actorId.toUpperCase() }));
    expect(unit.productId).toBe(productId);
    const saved = await Event.create(event(String(unit._id).toUpperCase()));
    expect(saved.unitId).toBe(String(unit._id));
    await expect(Event.create(event(unit._id))).rejects.toMatchObject({ code: 11000 });
  });
  it('accepts verified purchase provenance, rejects absent/wrong-type/wrong-product origins', async () => {
    await expect(Unit.create(piece({ origin: { kind: 'purchase', purchaseTransactionId: purchaseId } }))).resolves.toHaveProperty('barcode');
    for (const transactionId of [new Types.ObjectId().toHexString(), saleId]) {
      await expect(Unit.create(piece({ origin: { kind: 'purchase', purchaseTransactionId: transactionId } }))).rejects.toThrow('supplier purchase');
    }
    const wrong = await raw('transactions').insertOne({ type: 'مشتريات', items: [{ code: 'OTHER', qty: 1 }] });
    await expect(Unit.create(piece({ origin: { kind: 'purchase', purchaseTransactionId: String(wrong.insertedId) } }))).rejects.toMatchObject({ response: { code: 'PURCHASE_ORIGIN_MISMATCH' } });
  });
  it('requires assignment to a real stable sale line for the same product', async () => {
    const valid = piece({ status: 'reserved', assignment: { transactionId: saleId, lineId: 'line-1' } });
    await expect(Unit.create(valid)).resolves.toHaveProperty('assignment.lineId', 'line-1');
    await expect(Unit.create(piece({ ...valid, assignment: { transactionId: saleId, lineId: 'missing' } }))).rejects.toThrow('sale line');
  });
  it('retains known provenance after source cancellation without preventing retirement', async () => {
    const purchase = await raw('transactions').insertOne({ type: 'مشتريات', items: [{ code: 'EXISTING', qty: 1 }] });
    const unit = await Unit.create(piece({ origin: { kind: 'purchase', purchaseTransactionId: String(purchase.insertedId) } }));
    await raw('transactions').updateOne({ _id: purchase.insertedId }, { $set: { cancelled: true } });
    unit.status = 'retired'; await unit.save();
    expect(unit.origin.purchaseTransactionId).toBe(String(purchase.insertedId));
    await expect(Unit.create(piece({ origin: { kind: 'purchase', purchaseTransactionId: String(purchase.insertedId) } }))).rejects.toThrow('supplier purchase');
  });
  it('retains identities and rejects nested provenance changes after saving', async () => {
    const unit = await Unit.create(piece()); const barcode = unit.barcode;
    unit.barcode = 'OTHER'; unit.productId = new Types.ObjectId().toHexString();
    await unit.save(); expect(unit.barcode).toBe(barcode); expect(unit.productId).toBe(productId);
    unit.origin.reconciliationRef = 'INVENTED';
    await expect(unit.save()).rejects.toThrow('immutable');
  });
  it('uses optimistic concurrency for conflicting document saves', async () => {
    const original = await Unit.create(piece());
    const first = await Unit.findById(original._id), second = await Unit.findById(original._id);
    first!.warehouseCode = 'COUNTED-A'; second!.warehouseCode = 'COUNTED-B';
    await first!.save(); await expect(second!.save()).rejects.toThrow('version');
  });
  it('rejects orphaned event references and leaves events append-only', async () => {
    await expect(Event.create(event(new Types.ObjectId()))).rejects.toThrow('InventoryUnit does not exist');
    const unit = await Unit.create(piece());
    await expect(Event.create(event(unit._id, { inventoryMovementId: new Types.ObjectId().toHexString() }))).rejects.toThrow('InventoryMovement does not exist');
    const saved = await Event.create(event(unit._id)); saved.reason = 'rewrite';
    await expect(saved.save()).rejects.toThrow('append-only');
    await expect(Event.updateOne({ _id: saved._id }, { $set: { notes: 'rewrite' } })).rejects.toThrow('append-only');
    await expect(Event.deleteMany({ unitId: String(unit._id) })).rejects.toThrow('append-only');
    await expect(Event.bulkWrite([{ deleteOne: { filter: { _id: saved._id } } }])).rejects.toThrow();
  });
  it('retains referenced parents through model/document/bulk deletion paths', async () => {
    await expect(Product.deleteMany({ _id: productId })).rejects.toThrow('retained inventory');
    await expect(Product.findByIdAndDelete(productId)).rejects.toThrow('retained inventory');
    const product = await Product.findById(productId);
    await expect(product!.deleteOne()).rejects.toThrow('retained inventory');
    await expect(Product.bulkWrite([{ deleteOne: { filter: { _id: productId } } }])).rejects.toThrow('retained inventory');
    await expect(Transaction.findByIdAndDelete(purchaseId)).rejects.toThrow('retained inventory');
    await expect(Transaction.deleteOne({ _id: saleId })).rejects.toThrow('retained inventory');
    await expect(Unit.deleteMany({})).rejects.toThrow('retained');
    await expect(Unit.insertMany([piece()])).rejects.toThrow('reference validation');
  });
  it('retains transactions/movements referenced by immutable audit even without a current assignment', async () => {
    const unit = await Unit.create(piece());
    const movement = await raw('inventorymovements').insertOne({ productId, productCode: 'EXISTING', qtyDelta: 1 });
    const transaction = await raw('transactions').insertOne({ type: 'مرتجع', items: [] });
    await Event.create(event(unit._id, { inventoryMovementId: String(movement.insertedId), transactionId: String(transaction.insertedId) }));
    await expect(Movement.deleteOne({ _id: movement.insertedId })).rejects.toThrow('retained inventory');
    await expect(Transaction.deleteMany({ _id: transaction.insertedId })).rejects.toThrow('retained inventory');
  });
  it('does not attach another product movement to a unit audit', async () => {
    const unit = await Unit.create(piece());
    const movement = await raw('inventorymovements').insertOne({ productId: new Types.ObjectId().toHexString() });
    await expect(Event.create(event(unit._id, { inventoryMovementId: String(movement.insertedId) }))).rejects.toThrow('same product');
  });
  it('leaves unrelated legacy parent deletion available', async () => {
    const unused = await raw('products').insertOne({ code: 'UNUSED', name: 'Unused' });
    expect((await Product.deleteOne({ _id: unused.insertedId })).deletedCount).toBe(1);
  });
  it('fails a conflicting index plan without dropping indexes or rewriting documents', async () => {
    // Reproduce an operator-created conflict only inside this disposable database.
    await raw('inventoryunitevents').dropIndex('inventory_unit_event_movement_lookup');
    await raw('inventoryunitevents').createIndex({ notes: 1 }, { name: 'inventory_unit_event_movement_lookup' });
    const count = await Unit.countDocuments();
    await expect(migrateInventoryUnitIndexes(connection.db!, true)).rejects.toThrow('Conflicting inventory index');
    expect(await Unit.countDocuments()).toBe(count);
    expect((await raw('inventoryunitevents').indexes()).some(index => index.name === 'inventory_unit_event_movement_lookup' && index.key.notes === 1)).toBe(true);
  });
});
