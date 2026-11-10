/**
 * «إضافة عربون بدون صورة تحويل» — createWithoutImage + the deposit-no-image OTP.
 *
 * Real MongoDB scratch database (same harness and prefix rule as
 * shopify-deposit-receipts.service.spec.ts): the single-use OTP and the budget check both rest on
 * atomic findOneAndUpdate, which a model stub would not exercise. Vault and R2 are replaced.
 *
 * Run with: TEST_MONGODB_URI=mongodb://127.0.0.1:27018/soulia_test_deposit_receipts_noimg?replicaSet=souliaDev npm test -- deposit-no-image
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import mongoose, { Connection, Model } from 'mongoose';

export {};

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({
  EmployeeScoringService: class {},
}));
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
const { DiscountOtpSchema } = require('../../src/discount-otp/schemas/discount-otp.schema');
const { DepositReceiptsService } = require('../../src/shopify/deposit-receipts.service');
const { DiscountOtpService } = require('../../src/discount-otp/discount-otp.service');
/* eslint-enable @typescript-eslint/no-var-requires */

const URI = process.env.TEST_MONGODB_URI || `mongodb://localhost:27017/soulia_test_deposit_receipts_noimg_${process.pid}_${Date.now()}`;
const scratchDb = URI.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '';
if (!/^soulia_test_deposit_receipts(?:_[a-zA-Z0-9_-]+)?$/.test(scratchDb)) {
  throw new Error('Refusing to drop any database outside the soulia_test_deposit_receipts prefix');
}

const W = 'فودافون كاش';
const STAFF = { id: 'u-staff', username: 'staff', name: 'أحمد علي', isAdmin: false };
const ADMIN = { id: 'u-admin', username: 'admin', name: 'محمد أشرف', isAdmin: true };
const OTP_PERM = { role: 'staff', perms: ['shopify-orders', 'shopify-deposit-upload', 'shopify-deposit-no-image-otp'] };
const DIRECT_PERM = { role: 'staff', perms: ['shopify-orders', 'shopify-deposit-upload', 'shopify-deposit-no-image'] };
const NO_PERM = { role: 'staff', perms: ['shopify-orders', 'shopify-deposit-upload'] };

let conn: Connection;
let orderModel: Model<any>;
let txModel: Model<any>;
let manualModel: Model<any>;
let otpModel: Model<any>;

function setup(opts: { skipOtp?: boolean } = {}) {
  const entries: Array<{ amount: number; method: string; desc: string }> = [];
  const vault = {
    entries,
    addSystemEntry: jest.fn(async (amount: number, method: string, desc: string) => {
      entries.push({ amount, method, desc });
      return { _id: new mongoose.Types.ObjectId(), txNo: `SAL-${entries.length}` };
    }),
  };
  const settings = {
    getR2Config: jest.fn(async () => ({ accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' })),
    getSettings: jest.fn(async () => ({ r2ReceiptsMax: 2000, highValueDiscountOtpTtlMin: 10, depositNoImageSkipOtp: !!opts.skipOtp })),
  };
  const mentions = { createMany: jest.fn(async (rows: any[]) => rows) };
  const users = { findAll: jest.fn(async () => [{ _id: 'u-admin', role: 'admin', username: 'admin', name: 'محمد أشرف' }]), findById: jest.fn(async () => null) };
  const otp = new DiscountOtpService(otpModel, settings, mentions, users, { log: jest.fn(async () => undefined) }, { emitToUser: jest.fn() });
  const receipts = new DepositReceiptsService(orderModel, txModel, vault, settings, {}, { scoreDepositDetection: jest.fn(async () => undefined) }, { emitEvent: jest.fn() }, manualModel);
  receipts.discountOtp = otp;
  receipts.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { receipts, otp, vault, mentions };
}

let seq = 0;
async function newOrder(over: Record<string, unknown> = {}) {
  seq += 1;
  return orderModel.create({
    shopifyId: `noimg-${seq}-${Date.now()}`, ref: String(3000 + seq), client: 'Nano Saeid', total: 1500,
    itemsTotal: 1450, shipCost: 50, status: 'pending',
    items: [{ productId: 'p1', code: 'C1', name: 'سجادة', qty: 1, price: 1450, total: 1450 }], ...over,
  });
}
const fresh = (id: string) => orderModel.findById(id).lean().exec() as Promise<any>;

/** Requests and verifies a code the way the dialog does (request → manager reads it → validate). */
async function verifiedCode(otp: any, orderId: string, amount: number, method = W) {
  const { otpId } = await otp.requestDepositNoImageOtp({ orderId, orderRef: '#3001', client: 'Nano Saeid', amount, method, reason: '',
    requestedById: STAFF.id, requestedByName: STAFF.name, requestedByUsername: STAFF.username });
  const doc = await otpModel.findById(otpId).lean().exec() as any;
  expect((await otp.validateOtp(otpId, doc.otp)).valid).toBe(true);
  return otpId as string;
}

beforeAll(async () => {
  conn = await mongoose.createConnection(URI).asPromise();
  orderModel = conn.model('ShopifyOrder', ShopifyOrderSchema);
  txModel = conn.model('Transaction', TransactionSchema);
  manualModel = conn.model('ManualDepositReceipt', ManualDepositReceiptSchema);
  otpModel = conn.model('DiscountOtp', DiscountOtpSchema);
});
afterAll(async () => {
  await conn?.dropDatabase();
  await conn?.close();
});

describe('deposit without transfer image', () => {
  it('admin records it as a pending, image-less receipt; approval books the vault once', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder();
    const id = String(o._id);
    const { receipt } = await receipts.createWithoutImage(id, { amount: 300, method: W, reason: 'دفع كاش في المحل' }, ADMIN, { role: 'admin', perms: [] });
    expect(receipt).toMatchObject({ status: 'معلق', noImage: true, noImageAuth: 'admin', imageKey: '', amount: 300, method: W, needsReview: true, noImageReason: 'دفع كاش في المحل' });
    expect(vault.entries).toHaveLength(0);
    await receipts.approve(id, receipt.id, ADMIN);
    expect(vault.entries).toHaveLength(1);
    expect(vault.entries[0]).toMatchObject({ amount: 300, method: W });
    expect(vault.entries[0].desc).toContain('بدون صورة تحويل');
    expect((await fresh(id)).depositAmount).toBe(300);
  });

  it('two image-less receipts never collide in the duplicate / identity checks', async () => {
    const { receipts, vault } = setup();
    const o = await newOrder();
    const id = String(o._id);
    const a = (await receipts.createWithoutImage(id, { amount: 200, method: W }, ADMIN, { role: 'admin' })).receipt;
    const b = (await receipts.createWithoutImage(id, { amount: 250, method: W }, ADMIN, { role: 'admin' })).receipt;
    expect(a.imageSha256).not.toBe(b.imageSha256);
    await receipts.approve(id, a.id, ADMIN);
    await receipts.approve(id, b.id, ADMIN);
    expect(vault.entries.map(e => e.amount)).toEqual([200, 250]);
  });

  it('the direct perm records without a code; no perm is refused', async () => {
    const { receipts } = setup();
    const o = await newOrder();
    const id = String(o._id);
    const { receipt } = await receipts.createWithoutImage(id, { amount: 100, method: W }, STAFF, DIRECT_PERM);
    expect(receipt.noImageAuth).toBe('direct');
    await expect(receipts.createWithoutImage(id, { amount: 100, method: W }, STAFF, NO_PERM)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the OTP perm needs a verified code, and a code records exactly one deposit', async () => {
    const { receipts, otp, mentions } = setup();
    const o = await newOrder();
    const id = String(o._id);
    await expect(receipts.createWithoutImage(id, { amount: 400, method: W }, STAFF, OTP_PERM)).rejects.toBeInstanceOf(BadRequestException);
    const otpId = await verifiedCode(otp, id, 400);
    const [verified] = await otp.list({ kind: 'deposit-no-image', status: 'used' });
    expect(verified).toMatchObject({ kind: 'deposit-no-image', editTxId: id, itemsTotal: 400, txType: W, requestedById: STAFF.id, status: 'used', attempts: 0, txId: '' });
    expect(verified.otp).toMatch(/^\d{4}$/);
    expect(Number.isFinite(Date.parse(verified.createdAt))).toBe(true);
    expect(Number.isFinite(Date.parse(verified.expiresAt))).toBe(true);
    expect(Number.isFinite(Date.parse(verified.usedAt))).toBe(true);
    expect(mentions.createMany).toHaveBeenCalled();
    const [row] = mentions.createMany.mock.calls.at(-1)[0];
    // The bell card reads the code from line 1 and picks its layout by sender.
    expect(row.fromName).toBe('نظام عربون بدون صورة');
    expect(row.commentText.split('\n')[0]).toMatch(/^🔐 كود التحقق: \d{4}$/);
    expect((await otpModel.findById(otpId).lean().exec() as any).requestReason).toBe('');
    const { receipt } = await receipts.createWithoutImage(id, { amount: 400, method: W, otpId }, STAFF, OTP_PERM);
    expect(receipt).toMatchObject({ noImageAuth: 'otp', noImageOtpId: otpId });
    expect((await otpModel.findById(otpId).lean().exec() as any).txId).toBe(receipt.id);
    expect((await otp.list({ kind: 'deposit-no-image', status: 'used' }))[0].txId).toBe(receipt.id);
    await expect(receipts.createWithoutImage(id, { amount: 400, method: W, otpId }, STAFF, OTP_PERM)).rejects.toThrow('تم استخدام كود التحقق');
    expect((await fresh(id)).depositReceipts).toHaveLength(1);
  });

  it('an unverified code, or one for another amount, vault or order, is refused and not spent', async () => {
    const { receipts, otp } = setup();
    const o = await newOrder();
    const other = await newOrder();
    const id = String(o._id);
    const { otpId: unverified } = await otp.requestDepositNoImageOtp({ orderId: id, orderRef: '1', client: '', amount: 300, method: W, reason: '', requestedById: STAFF.id, requestedByName: '', requestedByUsername: '' });
    await expect(receipts.createWithoutImage(id, { amount: 300, method: W, otpId: unverified }, STAFF, OTP_PERM)).rejects.toThrow('لم يتم التحقق');
    const otpId = await verifiedCode(otp, id, 300);
    await expect(receipts.createWithoutImage(id, { amount: 350, method: W, otpId }, STAFF, OTP_PERM)).rejects.toThrow('المبلغ لا يطابق');
    await expect(receipts.createWithoutImage(id, { amount: 300, method: 'كاش', otpId }, STAFF, OTP_PERM)).rejects.toThrow('الخزنة لا تطابق');
    await expect(receipts.createWithoutImage(String(other._id), { amount: 300, method: W, otpId }, STAFF, OTP_PERM)).rejects.toThrow('أوردر آخر');
    expect((await otpModel.findById(otpId).lean().exec() as any).txId).toBe('');
    await receipts.createWithoutImage(id, { amount: 300, method: W, otpId }, STAFF, OTP_PERM);
  });

  it('gives the code back when the deposit cannot be recorded (budget taken meanwhile)', async () => {
    const { receipts, otp } = setup();
    const o = await newOrder({ total: 1000 });
    const id = String(o._id);
    const otpId = await verifiedCode(otp, id, 800);
    // Simulates a concurrent claim landing between the cap check and the atomic write.
    await orderModel.updateOne({ _id: o._id }, { $push: { depositReceipts: { id: 'dr_other', status: 'معلق', amount: 0 } } });
    const write = orderModel.findOneAndUpdate.bind(orderModel);
    const spy = jest.spyOn(orderModel, 'findOneAndUpdate').mockImplementationOnce(((...args: any[]) => {
      void orderModel.updateOne({ _id: o._id, 'depositReceipts.id': 'dr_other' }, { $set: { 'depositReceipts.$.amount': 500 } }).exec();
      return { exec: async () => { await new Promise(r => setTimeout(r, 50)); return write(...args).exec(); } };
    }) as any);
    await expect(receipts.createWithoutImage(id, { amount: 800, method: W, otpId }, STAFF, OTP_PERM)).rejects.toThrow('تعذّر التسجيل');
    spy.mockRestore();
    expect((await otpModel.findById(otpId).lean().exec() as any).txId).toBe('');
  });

  it('with the skip-OTP setting, the OTP perm records without a code', async () => {
    const { receipts } = setup({ skipOtp: true });
    const o = await newOrder();
    const { receipt } = await receipts.createWithoutImage(String(o._id), { amount: 150, method: W }, STAFF, OTP_PERM);
    expect(receipt.noImageAuth).toBe('otp-skipped');
  });

  it('refuses an amount over what is left on the order', async () => {
    const { receipts } = setup();
    const o = await newOrder({ total: 500 });
    await expect(receipts.createWithoutImage(String(o._id), { amount: 600, method: W }, ADMIN, { role: 'admin' })).rejects.toThrow('أكبر من المتبقي');
  });

  it('staff cannot edit an OTP-approved one (withdraw and re-add instead); admin can', async () => {
    const { receipts, otp } = setup();
    const o = await newOrder();
    const id = String(o._id);
    const otpId = await verifiedCode(otp, id, 200);
    const { receipt } = await receipts.createWithoutImage(id, { amount: 200, method: W, otpId }, STAFF, OTP_PERM);
    await expect(receipts.editPending(id, receipt.id, { amount: 900, method: W }, STAFF)).rejects.toBeInstanceOf(ForbiddenException);
    await receipts.editPending(id, receipt.id, { amount: 250, method: W }, ADMIN);
    await receipts.withdraw(id, receipt.id, STAFF);
    expect((await fresh(id)).depositReceipts[0].status).toBe('مسحوب');
  });

  it('the receipt has no image to stream', async () => {
    const { receipts } = setup();
    const o = await newOrder();
    const { receipt } = await receipts.createWithoutImage(String(o._id), { amount: 100, method: W }, ADMIN, { role: 'admin' });
    await expect(receipts.getImage(receipt.id, ADMIN)).rejects.toThrow('بدون صورة تحويل');
  });
});
