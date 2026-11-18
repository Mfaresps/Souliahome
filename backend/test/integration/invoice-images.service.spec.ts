import mongoose, { Connection } from 'mongoose';
import sharp from 'sharp';
import { InvoiceImagesService, INVOICE_IMAGES_COLLECTION } from '../../src/invoice-images/invoice-images.service';
import * as r2 from '../../src/shared/r2-uploader.util';

/** Supplier invoice photos: compressed like deposit receipts, R2 when configured, Mongo otherwise. */
export {};
const dbName = `soulia_test_invimg_${process.pid}_${Date.now()}`;
let connection: Connection;
const admin = { userId: 'a1', name: 'المدير', role: 'admin' };
const buyer = { userId: 'b1', name: 'Mona', role: 'staff', perms: ['purchase-create'] };
const nobody = { userId: 'n1', name: 'X', role: 'staff', perms: ['shopify-orders'] };
const r2Cfg = { accountId: 'acc', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' };

async function bigPhoto() {
  // A 3000×2200 patterned image (hundreds of KB as PNG), larger than the 1600 px limit.
  const w = 3000, h = 2200, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

beforeAll(async () => {
  connection = await mongoose.createConnection(`${(process.env.TEST_MONGODB_BASE || 'mongodb://127.0.0.1:27018')}/${dbName}?directConnection=true`, { serverSelectionTimeoutMS: 3000 }).asPromise();
}, 15000);
afterAll(async () => {
  jest.restoreAllMocks();
  if (connection) {
    if (!/^soulia_test_invimg_\d+_\d+$/.test(connection.name)) throw new Error('Unsafe scratch database');
    await connection.dropDatabase(); await connection.close();
  }
});

it('compresses a large photo to ≤180 KB and serves it back from Mongo when R2 is not set', async () => {
  const service = new InvoiceImagesService(connection as any, { getR2Config: async () => null } as any);
  const input = await bigPhoto();
  expect(input.length).toBeGreaterThan(300 * 1024);
  const res = await service.upload(buyer, { buffer: input, originalname: 'inv.png' });
  expect(res.url).toMatch(/^\/api\/invoice-images\/[a-f0-9]{64}\.jpg$/);
  expect(res.bytes).toBeLessThanOrEqual(180 * 1024);
  expect(res.storage).toBe('db');
  const back = await service.read(res.id + '.jpg');
  const meta = await sharp(back).metadata();
  expect(meta.format).toBe('jpeg');
  expect(Math.max(meta.width || 0, meta.height || 0)).toBeLessThanOrEqual(1600);
  const doc: any = await connection.collection(INVOICE_IMAGES_COLLECTION).findOne({ _id: res.id as any });
  expect(doc.uploadedBy).toBe('Mona');
}, 60000);

it('stores on R2 under purchase-invoices/ and reads it back from R2', async () => {
  const stored = new Map<string, Buffer>();
  jest.spyOn(r2, 'r2PutObject').mockImplementation(async (_c, key, body) => { stored.set(key, body); return { ok: true, message: '' }; });
  jest.spyOn(r2, 'r2GetObjectBuffer').mockImplementation(async (_c, key) => ({ ok: stored.has(key), message: '', body: stored.get(key) || Buffer.alloc(0), status: 200 }));
  const service = new InvoiceImagesService(connection as any, { getR2Config: async () => r2Cfg } as any);
  const res = await service.upload(admin, { buffer: await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#eee' } }).jpeg().toBuffer() });
  expect(res.storage).toBe('r2');
  const doc: any = await connection.collection(INVOICE_IMAGES_COLLECTION).findOne({ _id: res.id as any });
  expect(doc.imageKey).toMatch(/^purchase-invoices\/\d{4}-\d{2}\/[a-f0-9]{64}\.jpg$/);
  expect(doc.data).toBeUndefined();
  const fresh = new InvoiceImagesService(connection as any, { getR2Config: async () => r2Cfg } as any);
  expect((await fresh.read(res.id)).equals(stored.get(doc.imageKey)!)).toBe(true);
  jest.restoreAllMocks();
}, 30000);

it('refuses an R2 failure, a non-image, an unknown id and a user without purchase rights', async () => {
  jest.spyOn(r2, 'r2PutObject').mockResolvedValue({ ok: false, message: 'AccessDenied' });
  const withR2 = new InvoiceImagesService(connection as any, { getR2Config: async () => r2Cfg } as any);
  const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).png().toBuffer();
  const before = await connection.collection(INVOICE_IMAGES_COLLECTION).countDocuments();
  await expect(withR2.upload(buyer, { buffer: img })).rejects.toThrow(/التخزين السحابي/);
  expect(await connection.collection(INVOICE_IMAGES_COLLECTION).countDocuments()).toBe(before);
  jest.restoreAllMocks();
  const service = new InvoiceImagesService(connection as any, { getR2Config: async () => null } as any);
  await expect(service.upload(buyer, { buffer: Buffer.from('%PDF-1.4 not an image') })).rejects.toThrow(/JPEG/);
  await expect(service.upload(nobody, { buffer: img })).rejects.toThrow(/صلاحية/);
  await expect(service.read('../../etc/passwd')).rejects.toThrow(/غير موجودة/);
  await expect(service.read('f'.repeat(64))).rejects.toThrow(/غير موجودة/);
});

it('expense photos: allowed with the expenses perm, stored under expenses/, refused for a purchase-only user', async () => {
  const stored = new Map<string, Buffer>();
  jest.spyOn(r2, 'r2PutObject').mockImplementation(async (_c, key, body) => { stored.set(key, body); return { ok: true, message: '' }; });
  jest.spyOn(r2, 'r2GetObjectBuffer').mockImplementation(async (_c, key) => ({ ok: stored.has(key), message: '', body: stored.get(key) || Buffer.alloc(0), status: 200 }));
  const service = new InvoiceImagesService(connection as any, { getR2Config: async () => r2Cfg } as any);
  const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ddd' } }).jpeg().toBuffer();
  const cashier = { userId: 'c1', name: 'Cashier', role: 'staff', perms: ['expenses'] };
  const res = await service.upload(cashier, { buffer: img }, 'expense');
  const doc: any = await connection.collection(INVOICE_IMAGES_COLLECTION).findOne({ _id: res.id as any });
  expect(doc.purpose).toBe('expense');
  expect(doc.imageKey).toMatch(/^expenses\/\d{4}-\d{2}\/[a-f0-9]{64}\.jpg$/);
  expect((await service.read(res.id)).length).toBeGreaterThan(0);
  await expect(service.upload(buyer, { buffer: img }, 'expense')).rejects.toThrow(/المصاريف/);
  await expect(service.upload(cashier, { buffer: img })).rejects.toThrow(/المشتريات/);
  jest.restoreAllMocks();
});
