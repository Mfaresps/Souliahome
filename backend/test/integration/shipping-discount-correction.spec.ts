/**
 * Historical shipping-discount correction — the write path, on a scratch database (real MongoDB).
 * The owner approves an exact list of sales; nothing outside it is written, and a confirmed order's
 * Shopify record is written only together with its own sale (so excluded sales stay fully untouched).
 *
 * Run with: TEST_MONGODB_URI=mongodb://127.0.0.1:27018/soulia_test_shipdisc?replicaSet=souliaDev npx jest shipping-discount-correction
 */
import { MongoClient, Db } from 'mongodb';
import { applyApprovedShippingCorrection, applyCorrectionPlan, buildCorrectionPlan, loadCorrectionInputs, rollbackCorrection } from '../../src/transactions/shipping-discount-correction';

export {};

const URI = process.env.TEST_MONGODB_URI || `mongodb://localhost:27017/soulia_test_shipdisc_${process.pid}_${Date.now()}`;
const scratchDb = new URL(URI.replace(/^mongodb:\/\//, 'http://')).pathname.slice(1);
if (!/^soulia_test_shipdisc(?:_[a-zA-Z0-9_-]+)?$/.test(scratchDb)) throw new Error('Refusing any database outside the soulia_test_shipdisc prefix');

let client: MongoClient; let db: Db;
const order = (id: string, sd: number) => ({ shopifyId: id, ref: id, status: 'approved', shipCost: 120, discount: 120,
  rawData: { current_total_price: '2470.00', shipping_lines: [{ price: '120', discount_allocations: sd ? [{ amount: String(sd) }] : [] }] } });
const sale = (id: string, extra: any = {}) => ({ ref: id, type: 'مبيعات', date: '2026-10-05', shopifyOrderId: id, client: 'C',
  discount: 120, shipCost: 120, itemsTotal: 2470, total: 2470, remaining: 0, deposit: 2470,
  items: [{ code: 'A', price: 2470, qty: 1, total: 2470, unitCost: 1000, costSource: 'sale-snapshot' }], ...extra });

beforeAll(async () => {
  client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 5000 });
  db = client.db(scratchDb);
  await db.dropDatabase();
  await db.collection('products').insertOne({ code: 'A', buyPrice: 900 });
  await db.collection('shopifyorders').insertMany([order('1', 120), order('2', 120), order('3', 120), order('9', 120)]);
  await db.collection('transactions').insertMany([sale('1'), sale('2'), sale('3', { cancelled: true })]);
  // order 9 never became a sale (pending) — it carries no financial record.
  await db.collection('vaultentries').insertOne({ ref: '3', amount: 500, source: 'ديبوزت مبيعات' });
});
afterAll(async () => { await db?.dropDatabase(); await client?.close(); });

const tx = (ref: string) => db.collection('transactions').findOne({ ref });
const so = (ref: string) => db.collection('shopifyorders').findOne({ ref });

describe('apply only the approved list', () => {
  it('refuses to write without the exact approved list, or with an id the plan does not contain', async () => {
    const plan = buildCorrectionPlan(await loadCorrectionInputs(db), scratchDb);
    await expect(applyCorrectionPlan(db, plan, { runId: 'test-run-0', approvedBy: 'x', onlyTxIds: [] })).rejects.toThrow(/onlyTxIds/);
    await expect(applyCorrectionPlan(db, plan, { runId: 'test-run-0', approvedBy: 'x', onlyTxIds: ['not-in-plan'] })).rejects.toThrow(/not in the current plan/);
    expect((await tx('1'))!.shippingDiscount).toBeUndefined();
  });

  it('writes only the approved sale; excluded and cancelled sales and their order records stay untouched', async () => {
    const plan = buildCorrectionPlan(await loadCorrectionInputs(db), scratchDb);
    expect(plan.affected.map(r => r.ref).sort()).toEqual(['1', '2']);
    expect(plan.cancelledReview.map(r => r.ref)).toEqual(['3']);
    const before2 = JSON.stringify(await tx('2')), before3 = JSON.stringify(await tx('3'));
    const beforeSo2 = JSON.stringify(await so('2')), beforeSo3 = JSON.stringify(await so('3'));
    const id1 = String((await tx('1'))!._id);
    const r = await applyCorrectionPlan(db, plan, { runId: 'test-run-1', approvedBy: 'owner test', onlyTxIds: [id1] });
    expect(r.written).toBe(1);
    expect((await tx('1'))!.shippingDiscount).toBe(120);
    expect((await so('1'))!.shippingDiscount).toBe(120);           // follows its written sale
    expect(JSON.stringify(await tx('2'))).toBe(before2);            // not approved → untouched
    expect(JSON.stringify(await tx('3'))).toBe(before3);            // cancelled → untouched
    expect(JSON.stringify(await so('2'))).toBe(beforeSo2);          // its order record too
    expect(JSON.stringify(await so('3'))).toBe(beforeSo3);
    expect((await so('9'))!.shippingDiscount).toBe(120);           // a pending order (no sale) gets the label
    expect((await tx('1'))!.total).toBe(2470);                     // totals never written
  });

  it('rollback restores the approved sale and its order record exactly', async () => {
    const r = await rollbackCorrection(db, 'test-run-1', 'test');
    expect(r.transactions).toBe(1);
    const t1 = await tx('1');
    expect(t1!.shippingDiscount).toBeUndefined();
    expect(t1!.shippingDiscountSource).toBeUndefined();
    expect(t1!.editHistory).toBeUndefined();
    expect((await so('1'))!.shippingDiscount).toBeUndefined();
  });
});

describe('the approved list runs once at startup', () => {
  it('writes only approved, still-eligible ids, reports the rest, and never runs twice', async () => {
    const id1 = String((await tx('1'))!._id), id3 = String((await tx('3'))!._id);
    const approval = { runId: 'approved-test-run', approvedBy: 'owner test', sha256: 'x', onlyTxIds: [id1, id3, '000000000000000000000000'] };
    const r: any = await applyApprovedShippingCorrection(db, approval);
    expect(r.written).toBe(1);                                         // #1 only
    expect(r.missingFromPlan.sort()).toEqual(['000000000000000000000000', id3].sort()); // cancelled / unknown: reported, not written
    expect((await tx('3'))!.shippingDiscount).toBeUndefined();
    expect((await tx('2'))!.shippingDiscount).toBeUndefined();           // not approved
    const again: any = await applyApprovedShippingCorrection(db, approval);
    expect(again.skipped).toBe('already-run');
    const marker = await db.collection('financialcorrections').findOne({ _id: 'approved-test-run' as any });
    expect(marker!.status).toBe('done');
  });
});
