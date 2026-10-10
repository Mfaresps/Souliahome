/**
 * Deposit receipts — upload → submit → approve (vault) → confirm (no vault) → cancel (refund).
 *
 * ⚠ Runs against a REAL MongoDB (a scratch database), not a model stub. The guarantee that matters
 *   most here — a receipt's money is booked into the vault exactly once — rests on Mongo's atomic
 *   findOneAndUpdate with `$elemMatch` + the positional operator. A hand-written fake would test
 *   the fake. R2, OCR and the vault are replaced; the order and transaction collections are real.
 *
 *   Database: TEST_MONGODB_URI or a uniquely named scratch database per run.
 *   Only databases with the soulia_test_deposit_receipts prefix are accepted.
 *   The scratch database is dropped after the run.
 *
 * Run with: npm test -- shopify-deposit-receipts
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import mongoose, { Connection, Model } from 'mongoose';

export {};

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({
  EmployeeScoringService: class {},
}));

const mockR2 = new Map<string, Buffer>();
jest.mock('../../src/shared/r2-uploader.util', () => ({
  r2PutObject: jest.fn(async (_c: unknown, key: string, body: Buffer) => { mockR2.set(key, body); return { ok: true, message: '' }; }),
  r2DeleteObject: jest.fn(async (_c: unknown, key: string) => { mockR2.delete(key); return { ok: true, message: '' }; }),
  r2GetObjectBuffer: jest.fn(async (_c: unknown, key: string) =>
    mockR2.has(key)
      ? { ok: true, message: '', body: mockR2.get(key), status: 200 }
      : { ok: false, message: 'NoSuchKey', body: Buffer.alloc(0), status: 404 }),
  r2ListObjects: jest.fn(async (_c: unknown, prefix: string) => ({
    ok: true,
    message: '',
    objects: [...mockR2.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: 1, lastModified: '2020-01-01T00:00:00.000Z' })),
  })),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { ShopifyOrderSchema } = require('../../src/shopify/schemas/shopify-order.schema');
const { TransactionSchema } = require('../../src/transactions/schemas/transaction.schema');
const { DepositReceiptsService } = require('../../src/shopify/deposit-receipts.service');
const { ManualDepositReceiptSchema } = require('../../src/shopify/schemas/manual-deposit-receipt.schema');
const ShopifyService = () => require('../../src/shopify/shopify.service').ShopifyService;
/* eslint-enable @typescript-eslint/no-var-requires */

const URI = process.env.TEST_MONGODB_URI || `mongodb://localhost:27017/soulia_test_deposit_receipts_${process.pid}_${Date.now()}`;
const scratchDb = URI.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '';
if (!/^soulia_test_deposit_receipts(?:_[a-zA-Z0-9_-]+)?$/.test(scratchDb)) {
  throw new Error('Refusing to drop any database outside the soulia_test_deposit_receipts prefix');
}

const W = 'فودافون كاش';
const STAFF = { id: 'u-staff', username: 'staff', name: 'أحمد علي', isAdmin: false };
const OTHER = { id: 'u-other', username: 'other', name: 'رنا فؤاد', isAdmin: false };
const ADMIN = { id: 'u-admin', username: 'admin', name: 'محمد أشرف', isAdmin: true };

let conn: Connection;
let orderModel: Model<any>;
let txModel: Model<any>;
let manualModel: Model<any>;

/** A vault with real per-segment balances, so an overdraw on refund fails like the real one. */
function makeVault() {
  const balance: Record<string, number> = {};
  const entries: Array<{ amount: number; method: string; source: string; employee: string; desc: string }> = [];
  let failNext = false;
  return {
    balance,
    entries,
    failNextWrite() { failNext = true; },
    addSystemEntry: jest.fn(async (amount: number, method: string, desc: string, _date: string, source: string, _ref: string, _ctx: unknown, employee: string) => {
      if (failNext) { failNext = false; throw new Error('vault write failed'); }
      const cur = balance[method] || 0;
      if (amount < 0 && cur + amount < 0) throw new BadRequestException(`رصيد ${method} غير كافٍ`);
      balance[method] = cur + amount;
      entries.push({ amount, method, source, employee, desc });
      return { _id: new mongoose.Types.ObjectId(), txNo: `SAL-${String(entries.length).padStart(3, '0')}` };
    }),
  };
}

function makeOcr(result: Partial<{ amount: number | null; method: string; reference: string; confident: boolean; pattern: string; ran: boolean }> = {}) {
  let n = 0;
  return {
    // Unique bytes per upload, so no accidental «same image» warning between tests.
    prepareForStorage: jest.fn(async (b: Buffer) => Buffer.concat([b, Buffer.from(`#${++n}-${Math.random()}`)])),
    read: jest.fn(async () => ({
      amount: 500, method: 'Instapay', pattern: 'instapay', reference: '', dateText: '', confident: true, ran: true, ms: 5,
      ...result,
    })),
  };
}

function setup(ocrResult?: Parameters<typeof makeOcr>[0], opts: { max?: number } = {}) {
  const vault = makeVault();
  const ocr = makeOcr(ocrResult);
  const settings = {
    getR2Config: jest.fn(async () => ({ accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' })),
    getSettings: jest.fn(async () => ({ r2Enabled: false, r2ReceiptsMax: opts.max ?? 2000, defaultCarrierCode: 'bosta' })),
  };
  const scoring = { scoreDepositDetection: jest.fn(async () => undefined) };
  const presence = { emitEvent: jest.fn() };
  const receipts = new DepositReceiptsService(orderModel, txModel, vault, settings, ocr, scoring, presence, manualModel);
  receipts.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const shop = Object.create(ShopifyService().prototype);
  shop.shopifyOrderModel = orderModel;
  shop.txModel = txModel;
  shop.vaultService = vault;
  shop.settingsService = settings;
  shop.presence = presence;
  shop.employeeScoringService = scoring;
  shop.depositReceipts = receipts;
  shop.transactionsService = { getInventory: jest.fn(async () => []) };
  shop.recordInventoryMovementForSale = jest.fn(async () => undefined);
  shop.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { receipts, shop, vault, ocr, scoring };
}

let seq = 0;
async function newOrder(over: Record<string, unknown> = {}) {
  seq += 1;
  return orderModel.create({
    shopifyId: `sid-${seq}-${Date.now()}`,
    ref: String(2700 + seq),
    client: 'سارة أحمد',
    total: 1500,
    itemsTotal: 1450,
    shipCost: 50,
    status: 'pending',
    items: [{ productId: 'p1', code: 'C1', name: 'سجادة', qty: 1, price: 1450, total: 1450 }],
    assignedTo: 'u-staff',
    assignedToName: 'أحمد علي',
    ...over,
  });
}

const img = () => ({ buffer: Buffer.from('jpeg-bytes'), mimetype: 'image/jpeg', size: 10 });

/** upload + submit in one step. */
async function addPending(receipts: any, orderId: string, amount: number, method: string, actor = STAFF) {
  const { receipt } = await receipts.uploadDraft(orderId, img(), actor);
  await receipts.submit(orderId, receipt.id, { amount, method }, actor);
  return receipt.id as string;
}

const fresh = (id: string) => orderModel.findById(id).lean().exec() as Promise<any>;

beforeAll(async () => {
  conn = await mongoose.createConnection(URI, { serverSelectionTimeoutMS: 3000 }).asPromise();
  orderModel = conn.model('ShopifyOrder', ShopifyOrderSchema);
  txModel = conn.model('Transaction', TransactionSchema);
  manualModel = conn.model('ManualDepositReceipt', ManualDepositReceiptSchema);
  await conn.dropDatabase();
});

afterAll(async () => {
  if (conn) {
    await conn.dropDatabase();
    await conn.close();
  }
});

beforeEach(async () => { mockR2.clear(); await manualModel.deleteMany({}); });

async function confirmedManual(receipts: any, ref: string, client = '') {
  const { receipt } = await receipts.scanManualReceipt({ ref, client }, img(), STAFF);
  await receipts.confirmManualReceipt(receipt.id, { amount: 500, method: 'Instapay', total: 1500, confirmed: true }, STAFF);
  return receipts.claimManualReceipt(receipt.id, { type: 'مبيعات', ref, client, deposit: 500, depMethod: 'Instapay', total: 1500 }, STAFF);
}

describe('manual sale receipt storage', () => {
  it('uses the shared path and image API and survives orphan cleanup without a Shopify order', async () => {
    const { receipts, vault } = setup();
    const receipt = await confirmedManual(receipts, '91001', 'سارة أحمد');
    expect(receipt.imageKey).toMatch(/^deposit-receipts\/\d{4}-\d{2}\/order-91001_سارة-أحمد\/order-91001_سارة-أحمد_dr_[a-z0-9]+\.jpg$/);
    const tx = await txModel.create({ type: 'مبيعات', ref: '91001', date: '2026-10-10', employee: STAFF.name, total: 1500, depositReceipts: [receipt] });
    await receipts.consumeManualReceipt(receipt.id, String(tx._id));
    const image = await receipts.getImage(receipt.id, STAFF);
    expect(image).toEqual(mockR2.get(receipt.imageKey));
    await receipts.runCleanup();
    expect(mockR2.has(receipt.imageKey)).toBe(true);
    expect(vault.addSystemEntry).not.toHaveBeenCalled();
    await txModel.deleteOne({ _id: tx._id });
  });

  it('includes manual images in the storage cap and marks their snapshots deleted', async () => {
    const { receipts } = setup(undefined, { max: 1 });
    const a = await confirmedManual(receipts, '91002');
    const b = await confirmedManual(receipts, '91003');
    const tx = await txModel.create({ type: 'مبيعات', ref: '91002', date: '2026-10-10', employee: STAFF.name, total: 1500, depositReceipts: [a, b] });
    await receipts.runCleanup();
    const saved: any = await txModel.findById(tx._id).lean();
    expect(saved!.depositReceipts.filter((r: any) => r.imageDeleted)).toHaveLength(1);
    expect([a, b].filter(r => mockR2.has(r.imageKey))).toHaveLength(1);
    await txModel.deleteOne({ _id: tx._id });
  });

  it('rejects empty and unsupported images before storing anything', async () => {
    const { receipts } = setup();
    await expect(receipts.scanManualReceipt({}, { ...img(), buffer: Buffer.alloc(0) }, STAFF)).rejects.toThrow(BadRequestException);
    await expect(receipts.scanManualReceipt({}, { ...img(), mimetype: 'image/gif' }, STAFF)).rejects.toThrow(BadRequestException);
    expect(mockR2.size).toBe(0);
  });

  it('uploads and reads before amount entry and requires confirmation before sale creation', async () => {
    const { receipts, ocr, vault } = setup();
    const { receipt } = await receipts.scanManualReceipt({}, img(), STAFF);
    expect(receipt).toMatchObject({ status: 'مسودة', amount: 0, method: '', ocr: { amount: 500, method: 'Instapay' } });
    expect(ocr.read).toHaveBeenCalledTimes(1);
    expect(vault.addSystemEntry).not.toHaveBeenCalled();
    expect(await receipts.getImage(receipt.id, STAFF)).toEqual(mockR2.get(receipt.imageKey));
    await expect(receipts.getImage(receipt.id, OTHER)).rejects.toThrow(ForbiddenException);
    const sale = { type: 'مبيعات', ref: '91100', client: 'Manual client', deposit: 500, depMethod: 'Instapay', total: 1500 };
    await expect(receipts.claimManualReceipt(receipt.id, sale, STAFF)).rejects.toThrow(BadRequestException);
    await expect(receipts.confirmManualReceipt(receipt.id, { amount: 500, method: 'Instapay', total: 1500, confirmed: false }, STAFF)).rejects.toThrow(BadRequestException);
    await receipts.confirmManualReceipt(receipt.id, { amount: 500, method: 'Instapay', total: 1500, confirmed: true }, STAFF);
    const claims = await Promise.allSettled([receipts.claimManualReceipt(receipt.id, sale, STAFF), receipts.claimManualReceipt(receipt.id, sale, STAFF)]);
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const snapshot: any = (claims.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    expect(snapshot.imageKey).toContain('order-91100_Manual-client');
    expect(mockR2.has(receipt.imageKey)).toBe(false);
    expect(ocr.read).toHaveBeenCalledTimes(1);
  });

  it('retains image warnings and requires their acknowledgement with the employee confirmation', async () => {
    const { receipts } = setup({ ran: false, amount: null, method: '', confident: false });
    const { receipt } = await receipts.scanManualReceipt({}, img(), STAFF);
    expect(receipt.warnings.some((w: any) => w.code === 'ocr-unavailable')).toBe(true);
    const entry = { amount: 500, method: 'Instapay', total: 1500, confirmed: true };
    await expect(receipts.confirmManualReceipt(receipt.id, entry, STAFF)).rejects.toThrow(BadRequestException);
    const result = await receipts.confirmManualReceipt(receipt.id, { ...entry, acknowledgeImageWarning: true }, STAFF);
    expect(result.receipt.needsReview).toBe(true);
    expect(result.receipt.warningAcknowledgedById).toBe(STAFF.id);
    const edited = await receipts.confirmManualReceipt(receipt.id, { ...entry, amount: 499 }, STAFF);
    expect(edited.receipt.amount).toBe(499);
    expect(edited.receipt.warningAcknowledgedById).toBe(STAFF.id);
  });
});

describe('invoice receipt vault corrections with real MongoDB',()=>{
  it('persists the selected vault and preserves the separate payment records',async()=>{
    const {TransactionsService}=require('../../src/transactions/transactions.service');
    const {vault}=setup();
    vault.balance.Instapay=500;vault.balance[W]=800;
    const tx=await txModel.create({date:'2026-10-10',employee:'Tester',type:'مبيعات',ref:'27999',total:2450,deposit:1300,remaining:1150,
      payStatus:'معلق',depMethod:W,items:[],
      deposits:[{id:'r1',amount:500,method:'Instapay',source:'deposit-receipt'}, {id:'r2',amount:800,method:W,source:'deposit-receipt'}],
      depositReceipts:[{id:'r1',amount:500,method:'Instapay',imageKey:'one'}, {id:'r2',amount:800,method:W,imageKey:'two'}]});
    const service=Object.create(TransactionsService.prototype);
    service.transactionModel=txModel;service.vaultService=vault;service.resolveCarrierForWrite=jest.fn(async()=>({}));
    await service.update(String(tx._id),{depositVaultCorrections:[{id:'r1',method:'كاش'}]},'Tester','','admin');
    const saved=await txModel.findById(tx._id).lean() as any;
    expect(saved.deposit).toBe(1300);expect(saved.remaining).toBe(1150);
    expect(saved.deposits.map((d: any)=>[d.amount,d.method])).toEqual([[500,'كاش'],[800,W]]);
    expect(saved.depositReceipts[0]).toMatchObject({method:'كاش',amount:500,imageKey:'one'});
    expect(vault.balance).toMatchObject({Instapay:0,'كاش':500,[W]:800});
  });
});

describe('receipt races and access', () => {
  it.each([
    { ran: true, pattern: '', code: 'not-transfer' },
    { ran: false, pattern: '', code: 'ocr-unavailable' },
  ])('requires explicit acknowledgement and preserves $code for manager review', async ({ ran, pattern, code }) => {
    const { receipts, vault } = setup({ ran, pattern });
    const o = await newOrder();
    const r = (await receipts.uploadDraft(String(o._id), img(), STAFF)).receipt;
    expect(r.warnings).toContainEqual({ code, orderRef: '' });
    await expect(receipts.submit(String(o._id), r.id, { amount: 500, method: 'Instapay' }, STAFF)).rejects.toThrow(BadRequestException);
    expect((await fresh(String(o._id))).depositReceipts[0].status).toBe('مسودة');
    await receipts.submit(String(o._id), r.id, { amount: 500, method: 'Instapay', acknowledgeImageWarning: true }, STAFF);
    const submitted = (await fresh(String(o._id))).depositReceipts[0];
    expect(submitted).toMatchObject({ status: 'معلق', needsReview: true, warningAcknowledgedById: STAFF.id });
    expect(submitted.warningAcknowledgedAt).toBeTruthy();
    expect(submitted.warnings).toContainEqual({ code, orderRef: '' });
    await receipts.editPending(String(o._id), r.id, { amount: 450, method: 'Instapay' }, STAFF);
    expect((await fresh(String(o._id))).depositReceipts[0].warnings).toContainEqual({ code, orderRef: '' });
    expect(vault.entries).toHaveLength(0);
  });

  it('enforces buffer length and stored size even when reported file size is false', async () => {
    const { receipts, ocr } = setup();
    const o = await newOrder();
    await expect(receipts.uploadDraft(String(o._id), { ...img(), buffer: Buffer.alloc(5 * 1024 * 1024), size: 1 }, STAFF)).rejects.toThrow(BadRequestException);
    expect(ocr.prepareForStorage).not.toHaveBeenCalled();
    ocr.prepareForStorage.mockResolvedValueOnce(Buffer.alloc(181 * 1024));
    await expect(receipts.uploadDraft(String(o._id), img(), STAFF)).rejects.toThrow(BadRequestException);
    expect(mockR2.size).toBe(0);
  });

  it('simultaneous submissions cannot reserve more than the order total', async () => {
    const { receipts } = setup();
    const o = await newOrder({ total: 1000 });
    const a = (await receipts.uploadDraft(String(o._id), img(), STAFF)).receipt;
    const b = (await receipts.uploadDraft(String(o._id), img(), OTHER)).receipt;
    const results = await Promise.allSettled([
      receipts.submit(String(o._id), a.id, {amount:700,method:W}, STAFF),
      receipts.submit(String(o._id), b.id, {amount:700,method:W}, OTHER),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rows = (await fresh(String(o._id))).depositReceipts;
    expect(rows.filter((r: any) => r.status === 'معلق').reduce((s: number,r: any) => s+r.amount,0)).toBe(700);
    expect(rows.filter((r: any) => r.status === 'مسودة')).toHaveLength(1);
  });

  it('simultaneous pending edits cannot exceed the total', async () => {
    const { receipts } = setup();
    const o = await newOrder({total:1000});
    const a = await addPending(receipts,String(o._id),200,W,STAFF);
    const b = await addPending(receipts,String(o._id),200,W,OTHER);
    const results = await Promise.allSettled([
      receipts.editPending(String(o._id),a,{amount:700,method:W},STAFF),
      receipts.editPending(String(o._id),b,{amount:700,method:W},OTHER),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await fresh(String(o._id))).depositReceipts.reduce((s: number,r: any)=>s+r.amount,0)).toBe(900);
  });

  it('draft images are private; a submitted image can be reviewed', async () => {
    const { receipts } = setup();
    const o = await newOrder();
    const r = (await receipts.uploadDraft(String(o._id),img(),STAFF)).receipt;
    await expect(receipts.getImage(r.id,OTHER)).rejects.toThrow(ForbiddenException);
    await expect(receipts.getImage(r.id,ADMIN)).rejects.toThrow(ForbiddenException);
    await expect(receipts.getImage(r.id,STAFF)).resolves.toBeInstanceOf(Buffer);
    await receipts.submit(String(o._id),r.id,{amount:500,method:W},STAFF);
    await expect(receipts.getImage(r.id,ADMIN)).resolves.toBeInstanceOf(Buffer);
    await expect(receipts.getImage('missing',STAFF)).rejects.toThrow();
  });

  it('order lists exclude other uploaders’ drafts', () => {
    const { visibleReceipts } = require('../../src/shopify/deposit-receipts.util');
    const rows = [{id:'a',status:'مسودة',submittedById:STAFF.id},{id:'b',status:'مسودة',submittedById:OTHER.id},{id:'c',status:'معلق'}];
    expect(visibleReceipts({depositReceipts:rows},STAFF.id).depositReceipts.map((r: any)=>r.id)).toEqual(['a','c']);
    expect(visibleReceipts({depositReceipts:rows},ADMIN.id).depositReceipts.map((r: any)=>r.id)).toEqual(['c']);
    expect(rows).toHaveLength(3);
  });

  it('rechecks duplicate images at submission, even when both uploads preceded submission', async () => {
    const { receipts, ocr } = setup();
    ocr.prepareForStorage.mockImplementation(async()=>Buffer.from('same-image'));
    const o1=await newOrder(); const o2=await newOrder();
    const a=(await receipts.uploadDraft(String(o1._id),img(),STAFF)).receipt;
    const b=(await receipts.uploadDraft(String(o2._id),img(),OTHER)).receipt;
    await receipts.submit(String(o1._id),a.id,{amount:500,method:W},STAFF);
    await receipts.submit(String(o2._id),b.id,{amount:500,method:W},OTHER);
    expect((await fresh(String(o2._id))).depositReceipts[0].warnings).toEqual([{code:'same-image',orderRef:o1.ref}]);
  });

  it('submitting the same draft twice creates only one pending claim', async () => {
    const { receipts }=setup(); const o=await newOrder();
    const r=(await receipts.uploadDraft(String(o._id),img(),STAFF)).receipt;
    const results=await Promise.allSettled([1,2].map(()=>receipts.submit(String(o._id),r.id,{amount:500,method:W},STAFF)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await fresh(String(o._id))).depositReceipts).toHaveLength(1);
  });

  it('rejects empty and oversized uploads before storing anything', async () => {
    const {receipts}=setup(); const o=await newOrder();
    await expect(receipts.uploadDraft(String(o._id),undefined,STAFF)).rejects.toThrow(BadRequestException);
    await expect(receipts.uploadDraft(String(o._id),{...img(),size:5*1024*1024},STAFF)).rejects.toThrow(BadRequestException);
    expect(mockR2.size).toBe(0);
  });

  it('staff cannot approve their own receipt through the service', async () => {
    const {receipts,vault}=setup(); const o=await newOrder();
    const id=await addPending(receipts,String(o._id),500,W);
    await expect(receipts.approve(String(o._id),id,STAFF)).rejects.toThrow(ForbiddenException);
    expect(vault.entries).toHaveLength(0);
  });

  it('cancelled orders cannot confirm or accept another upload', async () => {
    const {receipts,shop,vault}=setup(); const o=await newOrder({cancelled:true});
    await expect(shop.approveOrder(String(o._id),'admin','bosta')).resolves.toMatchObject({success:false});
    await expect(receipts.uploadDraft(String(o._id),img(),STAFF)).rejects.toThrow(BadRequestException);
    expect(vault.entries).toHaveLength(0);
  });

  it('concurrent confirmations record only one transaction', async () => {
    const {shop}=setup(); const o=await newOrder();
    const results=await Promise.allSettled([1,2].map(()=>shop.approveOrder(String(o._id),'admin','bosta')));
    expect(results.filter(r=>r.status==='fulfilled' && r.value.success)).toHaveLength(1);
    expect(await txModel.countDocuments({shopifyOrderId:o.shopifyId})).toBe(1);
  });

  it('a failed transaction create restores pending status without losing receipts', async () => {
    const {receipts,shop,vault}=setup(); const o=await newOrder();
    const id=await addPending(receipts,String(o._id),500,W);
    await receipts.approve(String(o._id),id,ADMIN);
    const create=jest.spyOn(txModel,'create').mockRejectedValueOnce(new Error('create failed') as never);
    await expect(shop.approveOrder(String(o._id),'admin','bosta')).rejects.toThrow('create failed');
    create.mockRestore();
    const saved=await fresh(String(o._id));
    expect(saved.status).toBe('pending'); expect(saved.depositReceipts[0].id).toBe(id);
    expect(vault.entries).toHaveLength(1);
    await expect(shop.approveOrder(String(o._id),'admin','bosta')).resolves.toMatchObject({success:true});
  });

  it('confirmation waits until an approval has finished its vault booking', async () => {
    const {receipts,shop,vault}=setup(); const o=await newOrder();
    const id=await addPending(receipts,String(o._id),500,W);
    const write=vault.addSystemEntry.getMockImplementation()!;
    let release!:()=>void; const waiting=new Promise<void>(r=>{release=r;});
    let entered!:()=>void; const started=new Promise<void>(r=>{entered=r;});
    vault.addSystemEntry.mockImplementationOnce(async(...args: any[])=>{entered(); await waiting; return (write as any)(...args);});
    const approval=receipts.approve(String(o._id),id,ADMIN);
    await started;
    await expect(shop.approveOrder(String(o._id),'admin','bosta')).rejects.toThrow(/لم يكتمل/);
    release(); await approval;
    await expect(shop.approveOrder(String(o._id),'admin','bosta')).resolves.toMatchObject({success:true});
    expect(vault.entries).toHaveLength(1);
  });

  it('a cancellation refund in progress blocks confirmation and new receipt writes', async () => {
    const {receipts,shop,vault}=setup(); const o=await newOrder();
    await receipts.approve(String(o._id),await addPending(receipts,String(o._id),500,W),ADMIN);
    const write=vault.addSystemEntry.getMockImplementation()!;
    let release!:()=>void; const waiting=new Promise<void>(r=>{release=r;});
    let entered!:()=>void; const started=new Promise<void>(r=>{entered=r;});
    vault.addSystemEntry.mockImplementationOnce(async(...args:any[])=>{entered();await waiting;return (write as any)(...args);});
    const cancellation=shop.cancelOrder(String(o._id),'admin','','customer-changed-mind','');
    await started;
    await expect(shop.approveOrder(String(o._id),'admin','bosta')).resolves.toMatchObject({success:false});
    await expect(receipts.uploadDraft(String(o._id),img(),OTHER)).rejects.toThrow(BadRequestException);
    release();await cancellation;
    expect((await fresh(String(o._id))).cancelled).toBe(true);
    expect(vault.entries.filter(e=>e.amount<0)).toHaveLength(1);
  });

  it('a partial cancellation refund can retry without refunding the first receipt twice', async () => {
    const {receipts,shop,vault}=setup(); const o=await newOrder();
    await receipts.approve(String(o._id),await addPending(receipts,String(o._id),500,'Instapay'),ADMIN);
    await receipts.approve(String(o._id),await addPending(receipts,String(o._id),300,'كاش'),ADMIN);
    vault.balance['كاش']=0;
    await expect(shop.cancelOrder(String(o._id),'admin','','customer-changed-mind','')).rejects.toThrow(/غير كافٍ/);
    const saved=await fresh(String(o._id));
    expect(saved.cancelled).toBe(false); expect(saved.receiptCancelLock).toBe('');
    expect(saved.depositAmount).toBe(300);
    vault.balance['كاش']=300;
    await shop.cancelOrder(String(o._id),'admin','','customer-changed-mind','');
    expect(vault.entries.filter(e=>e.amount<0).map(e=>e.amount)).toEqual([-500,-300]);
  });
});

describe('employee side — upload and submit', () => {
  it('uses the shared bucket in a sibling folder with automatic backups disabled', async () => {
    const { receipts } = setup();
    const backupKey = 'backups/backup_existing.json.gz';
    const backup = Buffer.from('existing backup');
    mockR2.set(backupKey, backup);
    const o = await newOrder();
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    expect(receipt.imageKey).toMatch(new RegExp(`^deposit-receipts/\\d{4}-\\d{2}/order-${o.ref}_سارة-أحمد/order-${o.ref}_سارة-أحمد_dr_[a-z0-9]+\\.jpg$`));
    const { r2PutObject } = require('../../src/shared/r2-uploader.util');
    expect(r2PutObject).toHaveBeenCalledWith(
      { accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' },
      receipt.imageKey, expect.any(Buffer), 'image/jpeg',
    );
    expect(mockR2.get(backupKey)).toEqual(backup);
  });

  it('upload stores the image and records the server-side OCR suggestion as a draft', async () => {
    const { receipts } = setup({ amount: 500, method: 'Instapay', confident: true });
    const o = await newOrder();
    const { receipt, cap } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    expect(receipt.status).toBe('مسودة');
    expect(receipt.ocr.amount).toBe(500);
    expect(cap).toBe(1500);
    expect(mockR2.has(receipt.imageKey)).toBe(true);
    expect(receipt.imageKey.startsWith('deposit-receipts/')).toBe(true);
  });

  it('submit matching the suggestion is not flagged; a different amount or vault is', async () => {
    const { receipts } = setup({ amount: 500, method: 'Instapay', confident: true });
    const o = await newOrder();
    const a = await addPending(receipts, String(o._id), 500, 'Instapay');
    const b = await addPending(receipts, String(o._id), 300, 'Instapay');
    const c = await addPending(receipts, String(o._id), 500, W);
    const doc = await fresh(String(o._id));
    const by = (id: string) => doc.depositReceipts.find((r: any) => r.id === id);
    expect(by(a).needsReview).toBe(false);
    expect(by(b).needsReview).toBe(true);
    expect(by(c).needsReview).toBe(true);
  });

  it('an unread receipt is always flagged', async () => {
    const { receipts } = setup({ amount: null, method: '', confident: false });
    const o = await newOrder();
    const id = await addPending(receipts, String(o._id), 400, W);
    const doc = await fresh(String(o._id));
    expect(doc.depositReceipts.find((r: any) => r.id === id).needsReview).toBe(true);
  });

  it('refuses zero, negative and over-two-decimals amounts, and unknown vaults', async () => {
    const { receipts } = setup();
    const o = await newOrder();
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    for (const amount of [0, -50, 10.555]) {
      await expect(receipts.submit(String(o._id), receipt.id, { amount, method: W }, STAFF)).rejects.toThrow(BadRequestException);
    }
    await expect(receipts.submit(String(o._id), receipt.id, { amount: 100, method: 'Paypal' }, STAFF)).rejects.toThrow(BadRequestException);
  });

  it('the cap counts approved AND other pending receipts — two pending cannot exceed the total', async () => {
    const { receipts } = setup();
    const o = await newOrder({ total: 1500 });
    await addPending(receipts, String(o._id), 1000, W);
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    await expect(receipts.submit(String(o._id), receipt.id, { amount: 600, method: W }, STAFF)).rejects.toThrow(/المتبقي/);
    await expect(receipts.submit(String(o._id), receipt.id, { amount: 500, method: W }, STAFF)).resolves.toMatchObject({ success: true });
  });

  it('another employee cannot submit, edit or withdraw someone else’s receipt', async () => {
    const { receipts } = setup();
    const o = await newOrder();
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    await expect(receipts.submit(String(o._id), receipt.id, { amount: 100, method: W }, OTHER)).rejects.toThrow(ForbiddenException);
    await receipts.submit(String(o._id), receipt.id, { amount: 100, method: W }, STAFF);
    await expect(receipts.editPending(String(o._id), receipt.id, { amount: 90, method: W }, OTHER)).rejects.toThrow(ForbiddenException);
    await expect(receipts.withdraw(String(o._id), receipt.id, OTHER)).rejects.toThrow(ForbiddenException);
    await expect(receipts.withdraw(String(o._id), receipt.id, STAFF)).resolves.toMatchObject({ success: true });
    expect(mockR2.has(receipt.imageKey)).toBe(false);
  });

  it('warns when the same image is used on two orders', async () => {
    const { receipts, ocr } = setup();
    ocr.prepareForStorage.mockImplementation(async () => Buffer.from('identical-image'));
    const o1 = await newOrder();
    const o2 = await newOrder();
    await addPending(receipts, String(o1._id), 200, W);
    const { receipt } = await receipts.uploadDraft(String(o2._id), img(), STAFF);
    expect(receipt.warnings).toEqual([{ code: 'same-image', orderRef: o1.ref }]);
  });
});

describe('manager side — the vault moves on approval, exactly once', () => {
  it('approval books the amount into the receipt’s vault, attributed to the UPLOADER', async () => {
    const { receipts, vault, scoring } = setup();
    const o = await newOrder();
    const id = await addPending(receipts, String(o._id), 500, 'Instapay');
    const res = await receipts.approve(String(o._id), id, ADMIN);
    expect(res.success).toBe(true);
    expect(vault.entries).toEqual([expect.objectContaining({ amount: 500, method: 'Instapay', source: 'ديبوزت مبيعات', employee: 'أحمد علي' })]);
    const doc = await fresh(String(o._id));
    const r = doc.depositReceipts.find((x: any) => x.id === id);
    expect(r.status).toBe('معتمد');
    expect(r.reviewedBy).toBe('محمد أشرف');
    expect(r.vaultTxNo).toBe('SAL-001');
    expect(doc.depositAmount).toBe(500);
    expect(doc.depositStatus).toBe('partial');
    expect(scoring.scoreDepositDetection).toHaveBeenCalled();
  });

  it('two simultaneous approvals of the same receipt book the vault ONCE', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder();
    const id = await addPending(receipts, String(o._id), 500, W);
    const results = await Promise.allSettled([
      receipts.approve(String(o._id), id, ADMIN),
      receipts.approve(String(o._id), id, ADMIN),
      receipts.approve(String(o._id), id, ADMIN),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(vault.entries).toHaveLength(1);
  });

  it('approving an already-approved receipt is refused', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder();
    const id = await addPending(receipts, String(o._id), 500, W);
    await receipts.approve(String(o._id), id, ADMIN);
    await expect(receipts.approve(String(o._id), id, ADMIN)).rejects.toThrow('تم اعتماد هذا العربون بالفعل');
    expect(vault.entries).toHaveLength(1);
  });

  it('a failed vault write puts the receipt back under review', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder();
    const id = await addPending(receipts, String(o._id), 500, W);
    vault.failNextWrite();
    await expect(receipts.approve(String(o._id), id, ADMIN)).rejects.toThrow('vault write failed');
    const r = (await fresh(String(o._id))).depositReceipts.find((x: any) => x.id === id);
    expect(r.status).toBe('معلق');
    expect(r.reviewedBy).toBeUndefined();
    await receipts.approve(String(o._id), id, ADMIN);
    expect(vault.entries).toHaveLength(1);
  });

  it('approval re-checks the total — an order edited down below the receipt is refused', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder({ total: 1500 });
    const id = await addPending(receipts, String(o._id), 1200, W);
    await orderModel.updateOne({ _id: o._id }, { $set: { total: 1000 } });
    await expect(receipts.approve(String(o._id), id, ADMIN)).rejects.toThrow(/المتبقي/);
    expect(vault.entries).toHaveLength(0);
    expect((await fresh(String(o._id))).depositReceipts.find((x: any) => x.id === id).status).toBe('معلق');
  });

  it('rejection books nothing and deletes the image', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder();
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    await receipts.submit(String(o._id), receipt.id, { amount: 300, method: W }, STAFF);
    await receipts.reject(String(o._id), receipt.id, ADMIN, 'الصورة لا تخص هذا الطلب');
    const r = (await fresh(String(o._id))).depositReceipts.find((x: any) => x.id === receipt.id);
    expect(r.status).toBe('مرفوض');
    expect(r.imageDeleted).toBe(true);
    expect(mockR2.has(receipt.imageKey)).toBe(false);
    expect(vault.entries).toHaveLength(0);
  });
});

describe('confirming the order — reads the approved deposit, books nothing', () => {
  it('two receipts in two vaults become two deposit lines; the vault is not touched again', async () => {
    const { receipts, shop, vault } = setup();
    const o = await newOrder({ total: 1500 });
    await receipts.approve(String(o._id), await addPending(receipts, String(o._id), 500, 'Instapay'), ADMIN);
    await receipts.approve(String(o._id), await addPending(receipts, String(o._id), 300, 'كاش', OTHER), ADMIN);
    expect(vault.entries).toHaveLength(2);

    const res = await shop.approveOrder(String(o._id), 'admin', 'bosta');
    expect(res.success).toBe(true);
    expect(vault.entries).toHaveLength(2); // ⚠ the double-booking guard

    const tx: any = await txModel.findById(res.txId).lean();
    expect(tx.deposit).toBe(800);
    expect(tx.remaining).toBe(700);
    expect(tx.payStatus).toBe('معلق');
    expect(tx.deposits.map((d: any) => [d.amount, d.method, d.by, d.source])).toEqual([
      [500, 'Instapay', 'أحمد علي', 'deposit-receipt'],
      [300, 'كاش', 'رنا فؤاد', 'deposit-receipt'],
    ]);
    expect(tx.depositReceipts).toHaveLength(2);
    expect((await fresh(String(o._id))).status).toBe('approved');
  });

  it('a receipt still under review blocks confirmation', async () => {
    const { receipts, shop } = setup();
    const o = await newOrder();
    await addPending(receipts, String(o._id), 500, W);
    await expect(shop.approveOrder(String(o._id), 'admin', 'bosta')).rejects.toThrow(/قيد المراجعة/);
    expect(await txModel.countDocuments({ shopifyOrderId: o.shopifyId })).toBe(0);
  });

  it('an order without any receipt confirms with no deposit (the deposit is optional)', async () => {
    const { shop, vault } = setup();
    const o = await newOrder({ total: 900 });
    const res = await shop.approveOrder(String(o._id), 'admin', 'bosta');
    const tx: any = await txModel.findById(res.txId).lean();
    expect(tx.deposit).toBe(0);
    expect(tx.remaining).toBe(900);
    expect(tx.deposits).toEqual([]);
    expect(vault.entries).toHaveLength(0);
  });

  it('abandoned drafts are removed at confirmation', async () => {
    const { receipts, shop } = setup();
    const o = await newOrder();
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    await shop.approveOrder(String(o._id), 'admin', 'bosta');
    expect((await fresh(String(o._id))).depositReceipts).toHaveLength(0);
    expect(mockR2.has(receipt.imageKey)).toBe(false);
  });
});

describe('cancelling before confirmation — approved money is refunded, each from its own vault', () => {
  it('refunds every approved receipt, voids the pending one, then cancels', async () => {
    const { receipts, shop, vault } = setup();
    const o = await newOrder();
    await receipts.approve(String(o._id), await addPending(receipts, String(o._id), 500, 'Instapay'), ADMIN);
    await receipts.approve(String(o._id), await addPending(receipts, String(o._id), 300, 'كاش'), ADMIN);
    const pendingId = await addPending(receipts, String(o._id), 100, W);

    await shop.cancelOrder(String(o._id), 'admin', '', 'customer-changed-mind', '');

    expect(vault.entries.filter((e) => e.amount < 0).map((e) => [e.amount, e.method])).toEqual([
      [-500, 'Instapay'],
      [-300, 'كاش'],
    ]);
    expect(vault.balance).toEqual({ Instapay: 0, 'كاش': 0 });
    const doc = await fresh(String(o._id));
    expect(doc.cancelled).toBe(true);
    expect(doc.depositReceipts.map((r: any) => r.status)).toEqual(['مُسترد', 'مُسترد', 'ملغي']);
    expect(doc.depositReceipts.find((r: any) => r.id === pendingId).imageDeleted).toBe(true);
    expect(doc.depositAmount).toBe(0);
  });

  it('a refund that cannot be paid leaves the order live', async () => {
    const { receipts, shop, vault } = setup();
    const o = await newOrder();
    await receipts.approve(String(o._id), await addPending(receipts, String(o._id), 500, 'Instapay'), ADMIN);
    vault.balance.Instapay = 100; // the segment was spent meanwhile
    await expect(shop.cancelOrder(String(o._id), 'admin', '', 'customer-changed-mind', '')).rejects.toThrow(/غير كافٍ/);
    const doc = await fresh(String(o._id));
    expect(doc.cancelled).toBe(false);
    expect(doc.depositReceipts[0].status).toBe('معتمد');
  });

  it('a Shopify-side cancellation of an order holding approved money does not refund on its own', async () => {
    const { receipts, shop, vault } = setup();
    const o = await newOrder();
    await receipts.approve(String(o._id), await addPending(receipts, String(o._id), 500, W), ADMIN);
    const res = await shop.handleOrderCancelled({ id: o.shopifyId, cancel_reason: 'customer' });
    expect(res.handled).toBe(true);
    const doc = await fresh(String(o._id));
    expect(doc.cancelled).toBe(false);
    expect(doc.shopifyCancelConflict).toMatchObject({ approvedAmount: 500, resolved: false });
    expect(vault.entries.filter((e) => e.amount < 0)).toHaveLength(0);
  });
});

describe('nightly cleanup', () => {
  // The cleanup counts images across ALL orders — start each case from an empty collection.
  beforeEach(async () => {
    await orderModel.deleteMany({});
    await txModel.deleteMany({});
  });

  it('automatically trims oldest approved images on upload with a user-selected small limit', async () => {
    const { receipts } = setup({}, { max: 2 });
    const o = await newOrder({ depositReceipts: [
      { id: 'oldest', status: 'معتمد', imageKey: 'deposit-receipts/oldest.jpg', imageDeleted: false, uploadedAt: '2026-01-01T00:00:00Z' },
      { id: 'older', status: 'مُسترد', imageKey: 'deposit-receipts/older.jpg', imageDeleted: false, uploadedAt: '2026-02-01T00:00:00Z' },
      { id: 'pending', status: 'معلق', imageKey: 'deposit-receipts/pending.jpg', imageDeleted: false, amount: 1 },
    ] });
    for (const name of ['oldest', 'older', 'pending']) mockR2.set(`deposit-receipts/${name}.jpg`, Buffer.from(name));
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    const doc = await fresh(String(o._id));
    expect(mockR2.has('deposit-receipts/oldest.jpg')).toBe(false);
    expect(mockR2.has('deposit-receipts/older.jpg')).toBe(false);
    expect(mockR2.has('deposit-receipts/pending.jpg')).toBe(true);
    expect(mockR2.has(receipt.imageKey)).toBe(true);
    expect(doc.depositReceipts.filter((r: any) => !r.imageDeleted)).toHaveLength(2);
  });

  it('keeps backup objects while collecting orphaned receipt images', async () => {
    const { receipts } = setup();
    const backupKey = 'backups/backup_existing.json.gz';
    mockR2.set(backupKey, Buffer.from('existing backup'));
    const orphanKey = 'deposit-receipts/2020-01/missing-order/missing-receipt.jpg';
    mockR2.set(orphanKey, Buffer.from('orphan'));
    await receipts.runCleanup(new Date());
    expect(mockR2.has(backupKey)).toBe(true);
    expect(mockR2.has(orphanKey)).toBe(false);
  });

  it('removes drafts older than a day and keeps the newer ones', async () => {
    const { receipts } = setup();
    const o = await newOrder();
    const { receipt } = await receipts.uploadDraft(String(o._id), img(), STAFF);
    expect((await receipts.runCleanup(new Date())).drafts).toBe(0);
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    expect((await receipts.runCleanup(later)).drafts).toBe(1);
    expect((await fresh(String(o._id))).depositReceipts).toHaveLength(0);
    expect(mockR2.has(receipt.imageKey)).toBe(false);
  });

  it('over the cap, deletes the oldest APPROVED images and never a pending one', async () => {
    const { receipts } = setup({}, { max: 100 });
    const o = await newOrder({ total: 100000 });
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push(await addPending(receipts, String(o._id), 1, W));
    for (const id of ids.slice(0, 3)) await receipts.approve(String(o._id), id, ADMIN);
    const extra = await addPending(receipts, String(o._id), 1, W); // 102 stored, 99 of them pending

    const summary = await receipts.runCleanup(new Date());
    expect(summary.capped).toBe(0); // The upload already trimmed the two oldest approved images.
    const doc = await fresh(String(o._id));
    const byId = (id: string) => doc.depositReceipts.find((r: any) => r.id === id);
    expect(byId(ids[0]).imageDeleted).toBe(true);
    expect(byId(ids[1]).imageDeleted).toBe(true);
    expect(byId(ids[2]).imageDeleted).toBe(false);
    expect(doc.depositReceipts.filter((r: any) => r.status === 'معلق' && r.imageDeleted)).toHaveLength(0);
    expect(byId(extra).imageDeleted).toBe(false);
  });
});
