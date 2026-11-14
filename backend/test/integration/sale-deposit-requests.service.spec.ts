/**
 * Another deposit on a CONFIRMED sale (DepositReceiptsService: submitSaleReceipt / submitSaleNoImage /
 * approveSaleDeposit / rejectSaleDeposit / withdrawSaleDeposit). Real MongoDB scratch database: the single booking
 * and the budget rest on atomic findOneAndUpdate. Vault and R2 are replaced.
 *
 * Run with: TEST_MONGODB_URI=mongodb://127.0.0.1:27018/soulia_test_deposit_receipts_sale?replicaSet=souliaDev npx jest sale-deposit-requests
 */
import mongoose, { Connection, Model } from 'mongoose';

export {};

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
jest.mock('../../src/shared/r2-uploader.util', () => ({
  r2PutObject: jest.fn(async () => ({ ok: true, message: '' })),
  r2DeleteObject: jest.fn(async () => ({ ok: true, message: '' })),
  r2GetObjectBuffer: jest.fn(async () => ({ ok: false, message: 'NoSuchKey', body: Buffer.alloc(0), status: 404 })),
  r2ListObjects: jest.fn(async () => ({ ok: true, message: '', objects: [] })),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { ShopifyOrderSchema } = require('../../src/shopify/schemas/shopify-order.schema');
const { TransactionSchema } = require('../../src/transactions/schemas/transaction.schema');
const { ManualDepositReceiptSchema } = require('../../src/shopify/schemas/manual-deposit-receipt.schema');
const { DepositReceiptsService } = require('../../src/shopify/deposit-receipts.service');
/* eslint-enable @typescript-eslint/no-var-requires */

const URI = process.env.TEST_MONGODB_URI || `mongodb://localhost:27017/soulia_test_deposit_receipts_sale_${process.pid}_${Date.now()}`;
const scratchDb = URI.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '';
if (!/^soulia_test_deposit_receipts(?:_[a-zA-Z0-9_-]+)?$/.test(scratchDb)) {
  throw new Error('Refusing to drop any database outside the soulia_test_deposit_receipts prefix');
}

const STAFF = { id: 'u-staff', username: 'staff', name: 'أحمد علي', isAdmin: false };
const ADMIN = { id: 'u-admin', username: 'admin', name: 'محمد أشرف', isAdmin: true };
let conn: Connection; let orderModel: Model<any>; let txModel: Model<any>; let manualModel: Model<any>;

function setup() {
  const entries: Array<{ amount: number; method: string; desc: string; source: string }> = [];
  const vault = { entries, addSystemEntry: jest.fn(async (amount: number, method: string, desc: string, _d: string, source: string) => {
    entries.push({ amount, method, desc, source });
    return { _id: new mongoose.Types.ObjectId(), txNo: `SAL-${entries.length}` };
  }) };
  const settings = { getR2Config: jest.fn(async () => ({ accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' })),
    getSettings: jest.fn(async () => ({ r2ReceiptsMax: 2000, depositNoImageSkipOtp: true })) };
  const receipts = new DepositReceiptsService(orderModel, txModel, vault, settings, {}, { scoreDepositDetection: jest.fn(async () => undefined) }, { emitEvent: jest.fn() }, manualModel);
  receipts.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  receipts.depositMetafields = { requestSync: jest.fn(async () => undefined) };
  return { receipts, vault };
}
let seq = 0;
async function newSale(over: Record<string, unknown> = {}) {
  seq += 1;
  return txModel.create({ type: 'مبيعات', ref: String(8000 + seq), client: 'عميل', employee: 'x', date: '2026-11-10', total: 3020, itemsTotal: 2900, shipCost: 120,
    deposit: 500, remaining: 2520, payStatus: 'معلق', depMethod: 'Instapay', shopifyOrderId: `sh-${seq}`,
    deposits: [{ id: 'd0', amount: 500, method: 'Instapay', note: 'عربون', date: '2026-11-10', by: 'x', source: 'deposit-receipt', receiptId: 'd0' }],
    depositReceipts: [{ id: 'd0', amount: 500, method: 'Instapay', imageKey: 'k0', imageDeleted: false, needsReview: false }], ...over });
}
async function uploadedReceipt(amount: number, method = 'فودافون كاش', owner = STAFF.id) {
  seq += 1;
  const receiptId = `dr_test${seq}`;
  await manualModel.create({ receiptId, ownerId: owner, ref: '', client: '', state: 'submitted', expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    receipt: { id: receiptId, status: 'معلق', imageKey: `deposit-receipts/x/${receiptId}.jpg`, imageSha256: `sha-${receiptId}`, imageBytes: 10, imageDeleted: false,
      amount, method, ocr: { amount, method, confident: true, reference: '', dateText: '', pattern: '', ran: true, ms: 1 }, needsReview: false, warnings: [],
      uploadedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), submittedBy: 'أحمد علي', submittedById: owner } });
  return receiptId;
}
const msg = async (p: Promise<any>) => { try { await p; return 'ok'; } catch (e: any) { return e.message; } };

beforeAll(async () => {
  conn = await mongoose.createConnection(URI).asPromise();
  orderModel = conn.model('ShopifyOrder', ShopifyOrderSchema);
  txModel = conn.model('Transaction', TransactionSchema);
  manualModel = conn.model('ManualDepositReceipt', ManualDepositReceiptSchema);
});
afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

describe('another deposit on a confirmed sale', () => {
  it('staff: a receipt waits for a manager; the vault does not move', async () => {
    const { receipts, vault } = setup();
    const tx = await newSale();
    const rid = await uploadedReceipt(1000);
    const res = await receipts.submitSaleReceipt(String(tx._id), rid, STAFF);
    expect(res.pendingApproval).toBe(true);
    const saved = await txModel.findById(tx._id).lean() as any;
    expect(saved.depositRequests.map((r: any) => [r.id, r.status, r.amount])).toEqual([[rid, 'معلق', 1000]]);
    expect(saved.deposit).toBe(500);
    expect(saved.depositReceipts).toHaveLength(1);          // approved list untouched
    expect(vault.entries).toHaveLength(0);
    expect((await manualModel.findOne({ receiptId: rid }).lean() as any).state).toBe('consumed');
  });

  it('approval books the vault once and records the deposit on the sale', async () => {
    const { receipts, vault } = setup();
    const tx = await newSale();
    const rid = await uploadedReceipt(1000);
    await receipts.submitSaleReceipt(String(tx._id), rid, STAFF);
    const res = await receipts.approveSaleDeposit(String(tx._id), rid, ADMIN);
    expect(res).toMatchObject({ success: true, remaining: 1520 });
    const s = await txModel.findById(tx._id).lean() as any;
    expect(s.deposit).toBe(1500);
    expect(s.remaining).toBe(1520);
    expect(s.payStatus).toBe('معلق');
    expect(s.deposits.at(-1)).toMatchObject({ amount: 1000, method: 'فودافون كاش', source: 'deposit-receipt', receiptId: rid, vaultTxNo: 'SAL-1' });
    expect(s.depositReceipts.at(-1)).toMatchObject({ id: rid, amount: 1000, reviewedBy: 'محمد أشرف', vaultTxNo: 'SAL-1' });
    expect(s.depositRequests[0].status).toBe('معتمد');
    expect(vault.entries).toEqual([expect.objectContaining({ amount: 1000, method: 'فودافون كاش', source: 'ديبوزت مبيعات' })]);
    expect(receipts.depositMetafields.requestSync).toHaveBeenCalledWith(String(tx.shopifyOrderId), 'deposit-receipt');
  });

  it('two managers approving at once book it once', async () => {
    const { receipts, vault } = setup();
    const tx = await newSale();
    const rid = await uploadedReceipt(700);
    await receipts.submitSaleReceipt(String(tx._id), rid, STAFF);
    const out = await Promise.all([1, 2, 3].map(() => msg(receipts.approveSaleDeposit(String(tx._id), rid, ADMIN))));
    expect(out.filter(x => x === 'ok')).toHaveLength(1);
    expect(vault.entries).toHaveLength(1);
    expect((await txModel.findById(tx._id).lean() as any).deposit).toBe(1200);
  });

  it('a manager\'s own receipt is approved in the same call; paying the rest completes the sale', async () => {
    const { receipts, vault } = setup();
    const tx = await newSale();
    const rid = await uploadedReceipt(2520, 'كاش', ADMIN.id);
    const res = await receipts.submitSaleReceipt(String(tx._id), rid, ADMIN);
    expect(res).toMatchObject({ pendingApproval: false, remaining: 0 });
    const s = await txModel.findById(tx._id).lean() as any;
    expect(s.payStatus).toBe('مكتمل');
    expect(vault.entries).toHaveLength(1);
  });

  it('cannot exceed the remaining, counting requests still waiting', async () => {
    const { receipts } = setup();
    const tx = await newSale();
    await receipts.submitSaleReceipt(String(tx._id), await uploadedReceipt(2000), STAFF);
    expect(await msg(receipts.submitSaleReceipt(String(tx._id), await uploadedReceipt(600), STAFF))).toMatch(/أكبر من المتبقي/);
    expect(await msg(receipts.submitSaleNoImage(String(tx._id), { amount: 600, method: 'كاش' }, STAFF, { role: 'staff', perms: ['shopify-deposit-no-image'] }))).toMatch(/أكبر من المتبقي/);
  });

  it('refused on a cancelled, delivered or carrier-settled sale', async () => {
    const { receipts } = setup();
    for (const over of [{ cancelled: true }, { bostaStatus: 'DELIVERED' }, { carrierSettlement: { status: 'pending' } }, { type: 'مشتريات' }]) {
      const tx = await newSale(over);
      expect(await msg(receipts.submitSaleNoImage(String(tx._id), { amount: 100, method: 'كاش' }, ADMIN, { role: 'admin' }))).not.toBe('ok');
    }
  });

  it('no image: needs the permission; with it the request waits for a manager', async () => {
    const { receipts } = setup();
    const tx = await newSale();
    expect(await msg(receipts.submitSaleNoImage(String(tx._id), { amount: 100, method: 'كاش' }, STAFF, { role: 'staff', perms: [] }))).toMatch(/صلاحية/);
    const res = await receipts.submitSaleNoImage(String(tx._id), { amount: 100, method: 'كاش', reason: 'دفع في المحل' }, STAFF, { role: 'staff', perms: ['shopify-deposit-no-image'] });
    expect(res.request).toMatchObject({ noImage: true, status: 'معلق', noImageReason: 'دفع في المحل' });
  });

  it('reject and withdraw leave the money untouched; an approved request cannot be withdrawn', async () => {
    const { receipts, vault } = setup();
    const tx = await newSale();
    const a = await uploadedReceipt(100), b = await uploadedReceipt(200), c = await uploadedReceipt(300);
    for (const r of [a, b, c]) await receipts.submitSaleReceipt(String(tx._id), r, STAFF);
    await receipts.rejectSaleDeposit(String(tx._id), a, ADMIN, 'صورة غير واضحة');
    await receipts.withdrawSaleDeposit(String(tx._id), b, STAFF);
    expect(await msg(receipts.withdrawSaleDeposit(String(tx._id), c, { ...STAFF, id: 'someone-else' }))).toMatch(/موظف آخر/);
    await receipts.approveSaleDeposit(String(tx._id), c, ADMIN);
    expect(await msg(receipts.withdrawSaleDeposit(String(tx._id), c, STAFF))).toMatch(/لم يعد قيد المراجعة/);
    const s = await txModel.findById(tx._id).lean() as any;
    expect(s.depositRequests.map((r: any) => r.status)).toEqual(['مرفوض', 'مسحوب', 'معتمد']);
    expect(s.depositRequests[0].rejectReason).toBe('صورة غير واضحة');
    expect(s.deposit).toBe(800);
    expect(vault.entries).toHaveLength(1);
  });

  it('only a manager approves; staff cannot approve their own request', async () => {
    const { receipts } = setup();
    const tx = await newSale();
    const rid = await uploadedReceipt(100);
    await receipts.submitSaleReceipt(String(tx._id), rid, STAFF);
    expect(await msg(receipts.approveSaleDeposit(String(tx._id), rid, STAFF))).toMatch(/للمدير فقط/);
  });
});
