/**
 * Overpayment resolution — OrderCreditService against a real MongoDB scratch database: every write
 * is a conditional findOneAndUpdate, which a model stub would not exercise. The vault is a fake that
 * records entries (and can refuse an outflow like an empty segment does).
 *
 * Run with: TEST_MONGODB_URI=mongodb://127.0.0.1:27018/soulia_test_order_credit?replicaSet=souliaDev npx jest order-credit
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import mongoose, { Connection, Model } from 'mongoose';

export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { TransactionSchema } = require('../../src/transactions/schemas/transaction.schema');
const { OrderCreditService } = require('../../src/transactions/order-credit.service');
const { reconcile } = require('../../src/shared/payment-reconciliation.util');
/* eslint-enable @typescript-eslint/no-var-requires */

const URI = process.env.TEST_MONGODB_URI || `mongodb://127.0.0.1:27017/soulia_test_order_credit_${process.pid}_${Date.now()}`;
const scratchDb = URI.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '';
if (!/^soulia_test_order_credit(?:_[a-zA-Z0-9_-]+)?$/.test(scratchDb)) {
  throw new Error('Refusing to drop any database outside the soulia_test_order_credit prefix');
}

const ADMIN = { name: 'محمد', role: 'admin' };
const STAFF = { name: 'أحمد', role: 'staff' };

let conn: Connection;
let txModel: Model<any>;
let vaultEntries: Array<{ amount: number; method: string; source: string }>;
let vaultRefuses = false;
let service: any;

async function sale(o: Record<string, any> = {}) {
  const paid = o.paid ?? 500;
  delete o.paid;
  return txModel.create({
    type: 'مبيعات', date: '2026-11-13', employee: 'x', client: 'Mona', phone: '01001234567', ref: String(Math.floor(Math.random() * 1e6)),
    items: [{ code: 'A', name: 'A', qty: 1, price: 1000, total: 1000 }], total: 1000,
    deposit: paid, deposits: paid ? [{ id: 'd1', amount: paid, method: 'كاش' }] : [], payments: [],
    remaining: Math.max(0, 1000 - paid), payStatus: 'معلق', ...o,
  });
}
const fresh = async (doc: any) => (await txModel.findById(doc._id).lean()) as any;
const rec = async (doc: any) => reconcile(await fresh(doc));

beforeAll(async () => {
  conn = await mongoose.createConnection(URI).asPromise();
  txModel = conn.model('Transaction', TransactionSchema);
});
afterAll(async () => {
  await conn.dropDatabase();
  await conn.close();
});
beforeEach(async () => {
  await txModel.deleteMany({});
  vaultEntries = [];
  vaultRefuses = false;
  const vault = {
    addSystemEntry: jest.fn(async (amount: number, method: string, _desc: string, _date: string, source: string) => {
      if (vaultRefuses && amount < 0) throw new BadRequestException('رصيد كاش غير كافٍ');
      vaultEntries.push({ amount, method, source });
      return { _id: new mongoose.Types.ObjectId(), txNo: 'TXN-' + vaultEntries.length };
    }),
  };
  service = new OrderCreditService(txModel, vault, undefined);
});

describe('OrderCreditService', () => {
  it('C: an overpaid order can be kept as customer credit — no cash moves', async () => {
    const o = await sale({ total: 400 });
    await service.setMode(String(o._id), 'credit', 'العميل هيستخدمها', ADMIN);
    expect(await rec(o)).toMatchObject({ overpayment: 100, state: 'credit' });
    expect(vaultEntries).toEqual([]);
    const doc = await fresh(o);
    expect(doc.reconciliationLog.at(-1)).toMatchObject({ kind: 'mode', mode: 'credit', overpayment: 100, by: 'محمد' });
  });

  it('only an admin resolves an overpayment', async () => {
    const o = await sale({ total: 400 });
    await expect(service.setMode(String(o._id), 'credit', '', STAFF)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.requestRefund(String(o._id), { amount: 50, reason: 'رد' }, STAFF)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('8/9/10: partial refund — pending reserves, completion is the only cash move', async () => {
    const o = await sale({ total: 400 });
    const id = String(o._id);
    await service.requestRefund(id, { amount: 60, reason: 'طلب العميل', requestKey: 'k1' }, ADMIN);
    expect(vaultEntries).toEqual([]);
    expect(await rec(o)).toMatchObject({ netPaid: 500, refundPending: 60, available: 40 });
    // H: no second refund over the reserved amount
    await expect(service.requestRefund(id, { amount: 50, reason: 'تاني' }, ADMIN)).rejects.toThrow('المتاح للاسترداد 40');
    // repeated request key → the same move, not a second one
    await service.requestRefund(id, { amount: 60, reason: 'طلب العميل', requestKey: 'k1' }, ADMIN);
    const moveId = (await fresh(o)).creditMoves[0].id;
    expect((await fresh(o)).creditMoves).toHaveLength(1);
    await service.completeRefund(id, moveId, { method: 'كاش', date: '2026-11-13', reference: 'R-1' }, ADMIN);
    expect(vaultEntries).toEqual([{ amount: -60, method: 'كاش', source: 'رد زيادة دفع' }]);
    expect(await rec(o)).toMatchObject({ refunded: 60, netPaid: 440, overpayment: 40, available: 40 });
    // a double click on «complete» pays nothing twice
    await service.completeRefund(id, moveId, { method: 'كاش' }, ADMIN);
    expect(vaultEntries).toHaveLength(1);
    // the original deposit history is untouched
    const doc = await fresh(o);
    expect(doc.deposit).toBe(500);
    expect(doc.deposits).toEqual([expect.objectContaining({ amount: 500 })]);
  });

  it('a refund the vault cannot pay stays pending and can be retried', async () => {
    const o = await sale({ total: 400 });
    const id = String(o._id);
    await service.requestRefund(id, { amount: 100, reason: 'رد' }, ADMIN);
    const moveId = (await fresh(o)).creditMoves[0].id;
    vaultRefuses = true;
    await expect(service.completeRefund(id, moveId, { method: 'كاش' }, ADMIN)).rejects.toThrow('غير كافٍ');
    expect((await fresh(o)).creditMoves[0].status).toBe('pending');
    vaultRefuses = false;
    await service.completeRefund(id, moveId, { method: 'كاش' }, ADMIN);
    expect(await rec(o)).toMatchObject({ overpayment: 0, refunded: 100 });
  });

  it('a pending refund can be cancelled; cancelling makes the amount available again', async () => {
    const o = await sale({ total: 400 });
    const id = String(o._id);
    await service.requestRefund(id, { amount: 100, reason: 'رد' }, ADMIN);
    const moveId = (await fresh(o)).creditMoves[0].id;
    await service.cancelRefund(id, moveId, 'العميل غيّر رأيه', ADMIN);
    expect(await rec(o)).toMatchObject({ available: 100, refundPending: 0 });
    expect(vaultEntries).toEqual([]);
  });

  it('7/11: credit moves to another order of the same customer, with no cash', async () => {
    const src = await sale({ total: 400, overpaymentMode: 'credit' });
    const tgt = await sale({ paid: 0, total: 300, ref: '9002' });
    const list = await service.customerCredits({ txId: String(tgt._id) });
    expect(list).toMatchObject({ available: 100 });
    await service.transfer(String(src._id), { targetTxId: String(tgt._id), amount: 100, customerApproved: true, reason: 'بموافقة العميل', requestKey: 'tr1' }, ADMIN);
    expect(await rec(src)).toMatchObject({ overpayment: 0, creditOut: 100, cashPaid: 500 });
    expect(await rec(tgt)).toMatchObject({ creditIn: 100, remaining: 200, cashPaid: 0 });
    expect((await fresh(tgt)).remaining).toBe(200);
    expect(vaultEntries).toEqual([]);
    const out = (await fresh(src)).creditMoves[0];
    const inn = (await fresh(tgt)).creditMoves[0];
    expect(out).toMatchObject({ kind: 'transfer-out', counterpartTxId: String(tgt._id), customerApproved: true });
    expect(inn).toMatchObject({ kind: 'transfer-in', counterpartTxId: String(src._id), id: out.id });
  });

  it('12: a repeated transfer request moves the money once', async () => {
    const src = await sale({ total: 400 });
    const tgt = await sale({ paid: 0, total: 300 });
    const body = { targetTxId: String(tgt._id), amount: 100, customerApproved: true, requestKey: 'same' };
    await service.transfer(String(src._id), body, ADMIN);
    await service.transfer(String(src._id), body, ADMIN);
    expect((await fresh(src)).creditMoves).toHaveLength(1);
    expect((await fresh(tgt)).creditMoves).toHaveLength(1);
  });

  it('13: two concurrent uses of the same credit cannot both succeed', async () => {
    const src = await sale({ total: 400 });
    const t1 = await sale({ paid: 0, total: 300 });
    const t2 = await sale({ paid: 0, total: 300 });
    const results = await Promise.allSettled([
      service.transfer(String(src._id), { targetTxId: String(t1._id), amount: 100, customerApproved: true }, ADMIN),
      service.transfer(String(src._id), { targetTxId: String(t2._id), amount: 100, customerApproved: true }, ADMIN),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const s = await rec(src);
    expect(s.creditOut).toBe(100);
    expect(s.overpayment).toBe(0);
    const ins = (await rec(t1)).creditIn + (await rec(t2)).creditIn;
    expect(ins).toBe(100);
  });

  it('a transfer is refused without customer approval, across customers, or beyond what is owed', async () => {
    const src = await sale({ total: 400 });
    const other = await sale({ paid: 0, total: 300, phone: '01112223334', client: 'Other' });
    const small = await sale({ paid: 0, total: 50 });
    await expect(service.transfer(String(src._id), { targetTxId: String(small._id), amount: 100 }, ADMIN)).rejects.toThrow('موافقة العميل');
    await expect(service.transfer(String(src._id), { targetTxId: String(other._id), amount: 50, customerApproved: true }, ADMIN)).rejects.toThrow('نفس العميل');
    await expect(service.transfer(String(src._id), { targetTxId: String(small._id), amount: 100, customerApproved: true }, ADMIN)).rejects.toThrow('المتبقي');
    await expect(service.transfer(String(src._id), { targetTxId: String(small._id), amount: 150, customerApproved: true }, ADMIN)).rejects.toThrow('المتاح للتحويل 100');
  });

  it('a transfer onto an order with a live Bosta shipment is refused (its COD is fixed)', async () => {
    const src = await sale({ total: 400 });
    const tgt = await sale({ paid: 0, total: 300, bostaOrderId: 'B1', bostaStatus: 'PICKUP_REQUESTED' });
    await expect(service.transfer(String(src._id), { targetTxId: String(tgt._id), amount: 50, customerApproved: true }, ADMIN)).rejects.toThrow('بوليصة');
  });

  it('19: a credit write fails when a payment landed after the read', async () => {
    const o = await sale({ total: 400 });
    const stale = await fresh(o);
    await txModel.updateOne({ _id: o._id }, { $push: { payments: { id: 'p', amount: 10, collectedAmount: 10 } } });
    await expect((service as any).write(stale, { overpaymentMode: 'credit' })).rejects.toThrow('تغيّرت مدفوعات الطلب');
  });

  it('customer profile totals come from the orders, per state', async () => {
    const a = await sale({ total: 400, overpaymentMode: 'credit' });
    await sale({ total: 450 });
    const c = await sale({ total: 300 });
    await service.requestRefund(String(c._id), { amount: 200, reason: 'رد' }, ADMIN);
    const sum = await service.customerCredits({ phone: '+20 100 123 4567' });
    expect(sum).toMatchObject({ available: 100, unresolved: 50, pendingRefunds: 200 });
    expect(sum.orders.map((x: any) => x._id).sort()).toEqual([String(a._id), expect.any(String), String(c._id)].sort());
  });
});
