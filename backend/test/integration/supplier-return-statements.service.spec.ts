import mongoose, { Connection, Types } from 'mongoose';
import sharp from 'sharp';
import {
  SupplierReturnStatementsService, cleanRsText, formatRsNumber, rsCompletenessError,
} from '../../src/supplier-return-statements/supplier-return-statements.service';

/**
 * «بيانات المرتجعات» is documentation only. The load-bearing check here is that NO collection
 * other than its own two changes — stock, ledger, vault, costs, POs and invoices stay byte-identical.
 */
export {};
const dbName = `soulia_test_rs_${process.pid}_${Date.now()}`;
let connection: Connection;
let service: SupplierReturnStatementsService;

const oid = () => new Types.ObjectId();
const supplierId = oid(), otherSupplierId = oid();
const productA = oid(), productB = oid();
const poId = oid(), purchaseId = oid(), foreignPoId = oid();
const admin = { userId: oid().toString(), name: 'المدير', role: 'admin' };
const clerk = { userId: oid().toString(), name: 'Mona', role: 'staff', perms: ['suppliers-rs-create'] };
const editor = { userId: oid().toString(), name: 'Omar', role: 'staff', perms: ['suppliers-rs-edit', 'suppliers-rs-status'] };
const viewerOnly = { userId: oid().toString(), name: 'Sara', role: 'staff', perms: ['suppliers-rs-view'] };
const nobody = { userId: oid().toString(), name: 'X', role: 'staff', perms: ['suppliers'] };

// Everything a statement must never touch.
const GUARDED = ['products', 'transactions', 'inventorymovements', 'supplierledgerentries', 'vaultentries',
  'purchaseorders', 'supplierreturnorders', 'productcostevents', 'productsuppliers', 'suppliers', 'settings'];

async function snapshot() {
  const out: Record<string, string> = {};
  for (const c of GUARDED) out[c] = JSON.stringify(await connection.collection(c).find({}).sort({ _id: 1 }).toArray());
  return out;
}
const line = (productId: any, extra: any = {}) => ({ productId: String(productId), qty: 2, reason: 'manufacturing-defect', ...extra });

beforeAll(async () => {
  connection = await mongoose.createConnection(`${(process.env.TEST_MONGODB_BASE || "mongodb://127.0.0.1:27018")}/${dbName}?directConnection=true`, { serverSelectionTimeoutMS: 3000 }).asPromise();
  service = new SupplierReturnStatementsService(connection as any, { getR2Config: async () => null } as any);
  await service.onModuleInit();
  await connection.collection('suppliers').insertMany([{ _id: supplierId, name: 'مصنع النور' }, { _id: otherSupplierId, name: 'Other' }]);
  await connection.collection('products').insertMany([
    { _id: productA, code: 'CUS-1', name: 'Cushion Blue', buyPrice: 100, avgCost: 90, openingBalance: 10 },
    { _id: productB, code: 'BAG-2', name: 'Bag', buyPrice: 50, avgCost: null, openingBalance: 4 },
  ]);
  await connection.collection('purchaseorders').insertMany([
    { _id: poId, supplierId: String(supplierId), poNumber: 'PO-0007', createdDate: '2026-11-10', status: 'مستلم', items: [] },
    { _id: foreignPoId, supplierId: String(otherSupplierId), poNumber: 'PO-0008', createdDate: '2026-11-10', items: [] },
  ]);
  await connection.collection('transactions').insertOne({ _id: purchaseId, type: 'مشتريات', client: 'مصنع النور', ref: '900020', date: '2026-11-11', total: 1000, deposit: 0, remaining: 1000, items: [{ code: 'CUS-1', qty: 10, price: 100 }] });
  await connection.collection('inventorymovements').insertOne({ productId: String(productA), qtyDelta: 10 });
  await connection.collection('supplierledgerentries').insertOne({ supplierId: String(supplierId), amount: 1000 });
  await connection.collection('vaultentries').insertOne({ amount: -500, ref: 'x' });
}, 15000);
afterAll(async () => {
  if (connection) {
    if (!/^soulia_test_rs_\d+_\d+$/.test(connection.name)) throw new Error('Unsafe scratch database');
    await connection.dropDatabase(); await connection.close();
  }
});

describe('Supplier return statements — documentation only', () => {
  it('create, edit, status changes, photos and delete change no other collection', async () => {
    const before = await snapshot();
    const doc: any = await service.create(admin, {
      supplierId: String(supplierId), date: '2026-11-13', notes: 'فحص عند الاستلام',
      linkedDoc: { kind: 'po', id: String(poId) },
      lines: [line(productA, { qty: 3 }), line(productB, { reason: 'other', reasonNote: 'لون باهت' })],
    });
    expect(doc.number).toMatch(/^SR-\d{5}$/);
    expect(doc.status).toBe('draft');
    expect(doc.linkedDoc).toMatchObject({ kind: 'po', ref: 'PO-0007' });
    expect(doc.lines.map((l: any) => [l.code, l.name, l.qty])).toEqual([['CUS-1', 'Cushion Blue', 3], ['BAG-2', 'Bag', 2]]);

    const edited: any = await service.update(admin, doc._id, { revision: doc.revision, lines: [{ ...doc.lines[0], qty: 5 }], linkedDoc: { kind: 'purchase', id: String(purchaseId) } });
    expect(edited.lines).toHaveLength(1);
    expect(edited.linkedDoc.ref).toBe('900020');

    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer();
    const withPhoto: any = await service.uploadImage(admin, doc._id, edited.lines[0].lineId, { buffer: png, originalname: 'defect.png' });
    const att = withPhoto.lines[0].attachments[0];
    expect(att.id).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.getImage(viewerOnly, doc._id, att.id)).data).toMatch(/^data:image\/jpeg;base64,/);

    for (const st of ['sent', 'received', 'resolved', 'closed']) await service.setStatus(admin, doc._id, { status: st });
    await service.setStatus(admin, doc._id, { status: 'sent', note: 'إعادة فتح' });
    await service.removeImage(admin, doc._id, att.id);
    await service.remove(admin, doc._id);

    expect(await snapshot()).toEqual(before);
    // The record and its history survive a delete; it just leaves the list.
    const stored: any = await connection.collection('supplierreturnstatements').findOne({ _id: new Types.ObjectId(doc._id) });
    expect(stored.deletedAt).toBeTruthy();
    expect(stored.history.map((h: any) => h.action)).toEqual(['created', 'edited', 'photo-added', 'status', 'status', 'status', 'status', 'status', 'photo-removed', 'deleted']);
    expect(await service.list(admin, String(supplierId))).toHaveLength(0);
    expect(await connection.collection('supplierreturnstatementimages').countDocuments()).toBe(0);
  });

  it('«Other» requires a description, and a draft may be incomplete but cannot leave draft that way', async () => {
    await expect(service.create(admin, { supplierId: String(supplierId), lines: [line(productA, { reason: 'other', reasonNote: '  ' })] }))
      .rejects.toThrow('سبب آخر');
    const draft: any = await service.create(admin, { supplierId: String(supplierId), lines: [{ productId: String(productA), qty: null, reason: '' }] });
    expect(draft.lines[0].qty).toBeNull();
    await expect(service.setStatus(admin, draft._id, { status: 'sent' })).rejects.toThrow('الكمية');
    const empty: any = await service.create(admin, { supplierId: String(supplierId), lines: [] });
    await expect(service.setStatus(admin, empty._id, { status: 'sent' })).rejects.toThrow('منتجاً واحداً');
  });

  it('numbers are unique under concurrent creation, and a repeated request key returns the same statement', async () => {
    const made = await Promise.all(Array.from({ length: 6 }, () => service.create(admin, { supplierId: String(supplierId), lines: [] })));
    const numbers = made.map((d: any) => d.number);
    expect(new Set(numbers).size).toBe(6);
    const a: any = await service.create(admin, { supplierId: String(supplierId), requestKey: 'retry-key-12345', lines: [] });
    const b: any = await service.create(admin, { supplierId: String(supplierId), requestKey: 'retry-key-12345', lines: [] });
    expect(b._id).toBe(a._id);
  });

  it('refuses a linked document that belongs to another supplier, and keeps product names as they were', async () => {
    await expect(service.create(admin, { supplierId: String(supplierId), linkedDoc: { kind: 'po', id: String(foreignPoId) }, lines: [] }))
      .rejects.toThrow('أمر الشراء');
    const doc: any = await service.create(admin, { supplierId: String(supplierId), lines: [line(productA)] });
    await connection.collection('products').updateOne({ _id: productA }, { $set: { name: 'Cushion Renamed' } });
    const again: any = await service.update(admin, doc._id, { revision: doc.revision, lines: [{ ...doc.lines[0], qty: 4 }] });
    expect(again.lines[0].name).toBe('Cushion Blue');
    await connection.collection('products').updateOne({ _id: productA }, { $set: { name: 'Cushion Blue' } });
  });

  it('enforces the six permissions', async () => {
    await expect(service.list(nobody, String(supplierId))).rejects.toThrow('صلاحية');
    await expect(service.create(viewerOnly, { supplierId: String(supplierId), lines: [] })).rejects.toThrow('صلاحية');
    const own: any = await service.create(clerk, { supplierId: String(supplierId), lines: [line(productA)] });
    // The creator may finish their own draft with only the create perm…
    const ownEdit: any = await service.update(clerk, own._id, { revision: own.revision, notes: 'تم' });
    // …but not change its status, and not edit someone else's.
    await expect(service.setStatus(clerk, own._id, { status: 'sent' })).rejects.toThrow('صلاحية');
    const others: any = await service.create(admin, { supplierId: String(supplierId), lines: [line(productA)] });
    await expect(service.update(clerk, others._id, { revision: others.revision, notes: 'x' })).rejects.toThrow('صلاحية');
    await service.setStatus(editor, own._id, { status: 'sent' });
    await expect(service.update(clerk, own._id, { revision: ownEdit.revision + 1, notes: 'y' })).rejects.toThrow('صلاحية');
    await expect(service.remove(editor, own._id)).rejects.toThrow('صلاحية');
    await expect(service.recordPrint(viewerOnly, own._id, 'print')).rejects.toThrow('صلاحية');
    expect((await service.list(viewerOnly, String(supplierId))).length).toBeGreaterThan(0);
  });

  it('a stale revision is refused and a closed statement cannot be edited', async () => {
    const doc: any = await service.create(admin, { supplierId: String(supplierId), lines: [line(productA)] });
    await service.update(admin, doc._id, { revision: doc.revision, notes: 'one' });
    await expect(service.update(admin, doc._id, { revision: doc.revision, notes: 'two' })).rejects.toThrow('من مكان آخر');
    await service.setStatus(admin, doc._id, { status: 'closed' });
    const fresh: any = await service.get(admin, doc._id);
    await expect(service.update(admin, doc._id, { revision: fresh.revision, notes: 'three' })).rejects.toThrow('مغلق');
  });
});

describe('Supplier return statements — supplier prices and photos', () => {
  it('prices each line from the linked invoice, else the supplier price table, else the card; hidden from staff without purchase perms', async () => {
    const productC = oid();
    await connection.collection('products').insertOne({ _id: productC, code: 'NO-PRICE', name: 'No price', buyPrice: 0, imageUrl: 'https://cdn.test/c.jpg' });
    await connection.collection('productsuppliers').insertMany([
      { productId: String(productA), supplierId: String(supplierId), price: 120, active: true },
      { productId: String(productB), supplierId: String(supplierId), price: 45, active: true },
    ]);
    const before = await snapshot();
    const doc: any = await service.create(admin, {
      supplierId: String(supplierId), linkedDoc: { kind: 'purchase', id: String(purchaseId) },
      lines: [line(productA, { qty: 3 }), line(productB, { qty: 2 }), line(productC, { qty: 1 })],
    });
    // Invoice 900020 bills CUS-1 at 100 → wins over the table's 120. BAG-2 is not on it → table 45.
    expect(doc.lines.map((l: any) => [l.unitPrice, l.priceSource])).toEqual([[100, 'invoice'], [45, 'supplier'], [null, '']]);
    expect(doc.lines[2].imageUrl).toBe('https://cdn.test/c.jpg');
    // Unlinking the invoice re-prices: CUS-1 falls back to the supplier table.
    const relinked: any = await service.update(admin, doc._id, { revision: doc.revision, linkedDoc: null });
    expect(relinked.lines.map((l: any) => l.unitPrice)).toEqual([120, 45, null]);
    // A later supplier-price change does not rewrite a statement already priced.
    await connection.collection('productsuppliers').updateOne({ productId: String(productB) }, { $set: { price: 99 } });
    const edited: any = await service.update(admin, doc._id, { revision: relinked.revision, notes: 'x' });
    expect(edited.lines[1].unitPrice).toBe(45);
    // Staff without purchase perms see no prices; a buyer does.
    const seen: any = await service.get(viewerOnly, doc._id);
    expect(seen.pricesHidden).toBe(true);
    expect(seen.lines.some((l: any) => 'unitPrice' in l)).toBe(false);
    const buyer = { ...viewerOnly, perms: ['suppliers-rs-view', 'purchase-create'] };
    expect((await service.get(buyer, doc._id)).lines[0].unitPrice).toBe(120);
    // …and an edit by someone who cannot see prices keeps them.
    const clerkEdit: any = await service.update({ ...clerk, role: 'staff', perms: ['suppliers-rs-edit'] }, doc._id, { revision: edited.revision, lines: seen.lines.map((l: any) => ({ ...l, qty: 4 })) });
    expect((await service.get(admin, clerkEdit._id)).lines.map((l: any) => l.unitPrice)).toEqual([120, 45, null]);
    // Nothing outside the statement changed except our own test fixture edit above.
    const after = await snapshot();
    for (const c of GUARDED.filter((x) => x !== 'productsuppliers')) expect(after[c]).toEqual(before[c]);
  });
});

describe('Supplier return statement helpers', () => {
  it('formats numbers, cleans text and reports the first incomplete line', () => {
    expect(formatRsNumber(1)).toBe('SR-00001');
    expect(cleanRsText('  a‮b  \n\n\n c ')).toBe('ab\n\nc');
    expect(rsCompletenessError([{ productId: 'x', qty: 1, reason: 'other', reasonNote: '' }])).toContain('وصف');
    expect(rsCompletenessError([{ productId: 'x', qty: 1, reason: 'wrong-color' }])).toBe('');
  });
});
