import { Schema } from 'mongoose';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { trackingMongo } from '../helpers/tracking-mongo';
import { OrderAuditService } from '../../src/shopify/order-audit.service';

describe('Order audit scoped reads with isolated MongoDB', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>;
  let tx: any, orders: any, products: any;
  const period = { fromDate: '2026-10-01', toDate: '2026-10-20' };
  const item = { code: 'P', name: 'Basket', qty: 2, price: 100 };
  beforeAll(async () => {
    mongo = await trackingMongo(false);
    tx = mongo.connection.model('AuditPerformanceTransaction', new Schema({}, { strict: false }));
    orders = mongo.connection.model('AuditPerformanceOrder', new Schema({}, { strict: false }));
    products = mongo.connection.model('AuditPerformanceProduct', new Schema({}, { strict: false }));
    const sale = (ref: string, extra = {}) => ({ ref, type: 'مبيعات', date: '2026-10-10', total: 220, shipCost: 20, items: [item], ...extra });
    await tx.insertMany([
      ...Array.from({ length: 1200 }, (_, i) => sale(String(3000 + i), { date: '2025-01-01', notes: 'x'.repeat(8192) })),
      sale('#A-1-0', { cancelled: true }),
      sale('10', { bostaOrderId: 'delivery-10', bostaRawResponse: { wallet: { cashCycle: { bosta_fees: 11.5 } } } }),
      sale('30', { date: '2026-09-30T22:30:00Z' }),
      sale('2000'),
    ]);
    await orders.insertMany([
      { ref: '20', status: 'pending', shopifyCreatedAt: '2026-10-12', total: 200, items: [item], shipWithoutDeposit: true },
      { ref: '2000', status: 'approved', shopifyCreatedAt: '2026-09-10' },
      ...Array.from({ length: 1200 }, (_, i) => ({ ref: String(3000 + i), shopifyCreatedAt: '2025-01-01', raw: 'x'.repeat(8192) })),
    ]);
    await products.insertMany([{ code: 'P', buyPrice: 30 }, { code: 'UNUSED', buyPrice: 999, image: 'x'.repeat(8192) }]);
  }, 40000);
  afterAll(async () => { await mongo?.close(); });

  function service(unscoped = false) {
    const reads: Array<{ name: string; projection: any; count: number; bytes: number }> = [];
    const wrap = (model: any, name: string) => ({ find: (filter: any, projection?: any) => ({ lean: async () => {
      // The old report materialized whole collections twice for a date report.
      const rows = await model.find(unscoped ? name === 'tx' ? { type: 'مبيعات' } : {} : filter, unscoped ? undefined : projection).lean();
      reads.push({ name, projection, count: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
      return rows;
    } }) });
    const s: any = Object.create(OrderAuditService.prototype);
    s.txModel = wrap(tx, 'tx'); s.shopifyOrderModel = wrap(orders, 'orders'); s.productModel = wrap(products, 'products');
    s.loadReviews = jest.fn(async () => new Map()); s.saveAuditLog = jest.fn(async () => {});
    s.carrierDetails = { bostaDetails: jest.fn(async () => { throw new Error('No external shipping reads expected'); }) };
    return { s, reads };
  }
  it('matches full-read calculations with legacy refs, duplicate sales, Cairo boundaries and Shopify date precedence', async () => {
    const baseline = service(true), optimized = service();
    const start = performance.now();
    const before = await baseline.s.runAuditPeriod(period, { persist: false });
    const baselineMs = performance.now() - start;
    const next = performance.now();
    const after = await optimized.s.runAuditPeriod(period, { persist: false });
    const optimizedMs = performance.now() - next;
    expect({ ...after, generatedAt: '' }).toEqual({ ...before, generatedAt: '' });
    expect(after.rows.map((row: any) => row.orderNumber)).toEqual(['10', '20', '30']);
    expect(after.rows[0]).toMatchObject({ cancelled: false, productCost: 60, actualShipCost: 11.5 });
    expect(after.rows[1].shipWithoutDeposit).toBe(true);
    expect(after.rows[2].actualShippingKnown).toBe(false);
    expect(optimized.s.carrierDetails.bostaDetails).not.toHaveBeenCalled();
    expect(optimized.reads.filter(read => !read.projection).map(read => [read.name, read.count]).sort()).toEqual([['orders', 1], ['tx', 3]]);
    expect(optimized.reads.find(read => read.name === 'products')?.count).toBe(1);
    const bytes = (reads: typeof optimized.reads) => reads.reduce((sum, read) => sum + read.bytes, 0);
    expect(bytes(optimized.reads)).toBeLessThan(bytes(baseline.reads) / 20);
    const output = resolve(__dirname, '../../../artifacts/order-audit-performance');
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'database.json'), JSON.stringify({ fixture: '1200 historical orders and selected October orders; isolated MongoDB; no carrier API', baselineMs, optimizedMs, baselineBytes: bytes(baseline.reads), optimizedBytes: bytes(optimized.reads), reads: optimized.reads }, null, 2));
  });
  it('preserves numeric gaps and reads changed orders afresh', async () => {
    const { s } = service();
    const report = await s.runAudit(10, 20, { persist: false });
    expect(report.rows).toHaveLength(11); expect(report.sequence.missingCount).toBe(9);
    await tx.updateOne({ ref: '10' }, { $set: { total: 250 } });
    const next = await s.runAuditPeriod(period, { persist: false });
    expect(next.rows[0].orderTotal).toBe(250);
  });
  it('does not load full orders or product data for an empty period', async () => {
    const { s, reads } = service();
    const report = await s.runAuditPeriod({ fromDate: '2024-01-01', toDate: '2024-01-31' }, { persist: false });
    expect(report.rows).toEqual([]);
    expect(reads).toHaveLength(2); expect(reads.every(read => read.projection)).toBe(true);
  });
});
