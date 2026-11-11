import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { trackingMongo } from '../helpers/tracking-mongo';
import { mongoShopifyConfirmed, shopifyConfirmationBucket } from '../../src/shopify/shopify-confirmation.util';
import { TransactionsService } from '../../src/transactions/transactions.service';

describe('Shopify confirmation definition across browser and Mongo aggregates', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>;
  const browser: any = { _spFollowUpsFor: () => [], _fuIsSettled: () => true, _payMethodLabel: (value: string) => value };
  beforeAll(async () => {
    mongo = await trackingMongo(false);
    const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const kpis = readFileSync(resolve(__dirname, '../../../frontend/public/shopify-kpis.js'), 'utf8');
    runInNewContext(html.slice(html.indexOf('function _spDepositOf('), html.indexOf('\n/* "A deposit was recorded"')), browser);
    runInNewContext(kpis.slice(kpis.indexOf('function _spkOrderMs('), kpis.indexOf('\nfunction _spkStats(')), browser);
  }, 20000);
  afterAll(async () => { await mongo?.close(); });
  it.each([
    ['approved deposit before registration', { status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 100 }] }, 'deposit'],
    ['pending review', { status: 'pending', depositReceipts: [{ status: 'معلق', amount: 100 }] }, null],
    ['draft', { depositReceipts: [{ status: 'مسودة', amount: 100 }] }, null],
    ['rejected receipt', { depositReceipts: [{ status: 'مرفوض', amount: 100 }] }, null],
    ['refunded receipt', { depositReceipts: [{ status: 'مُسترد', amount: 100 }] }, null],
    ['withdrawn receipt', { depositReceipts: [{ status: 'مسحوب', amount: 100 }] }, null],
    ['cancelled receipt', { depositReceipts: [{ status: 'ملغي', amount: 100 }] }, null],
    ['explicit no-deposit approval', { status: 'pending', shipWithoutDeposit: true }, 'nodep'],
    ['registered without deposit', { status: 'approved' }, 'nodep'],
    ['legacy registered deposit', { status: 'approved', depositAmount: 100 }, 'deposit'],
    ['cancelled order with money', { cancelled: true, status: 'approved', depositReceipts: [{ status: 'معتمد', amount: 100 }] }, 'cancelled'],
    ['rejected order with money', { status: 'rejected', depositReceipts: [{ status: 'معتمد', amount: 100 }] }, 'cancelled'],
    ['stale summary without approval', { status: 'pending', depositAmount: 100 }, null],
    ['tag without approval', { status: 'pending', tags: 'confirmed', confirmationApproved: true }, null],
    ['mixed receipt history', { status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 25.25 }, { status: 'مُسترد', amount: 100 }] }, 'deposit'],
  ])('%s', async (_name, fields: any, expected) => {
    const order = { total: 1000, ...fields };
    expect(shopifyConfirmationBucket(order)).toBe(expected);
    const browserBucket = browser._spkBucket(order);
    expect(browserBucket === 'open' ? null : browserBucket).toBe(expected);
    const inserted = await mongo.connection.collection('confirmation_parity').insertOne(order);
    const rows = await mongo.connection.collection('confirmation_parity').aggregate([
      { $match: { _id: inserted.insertedId } }, { $project: { confirmed: mongoShopifyConfirmed() } },
    ]).toArray();
    expect(rows[0].confirmed).toBe(expected === 'deposit' || expected === 'nodep');
  });
  const overviewService = (prefix: string) => {
    const model = (name: string) => ({ collection: { name }, aggregate: (pipeline: any[]) => ({
      exec: () => mongo.connection.collection(name).aggregate(pipeline).toArray(),
    }) });
    return { shopifyOrderModel: model(prefix + '_orders'), transactionModel: model(prefix + '_sales'),
      returnRequestModel: model(prefix + '_returns') } as unknown as TransactionsService;
  };
  it('reconciles 15 received and 14 confirmed with Shopify despite only six invoices and an extra manual sale', async () => {
    const orders = Array.from({ length: 15 }, (_, index) => ({ shopifyId: 'shop-' + index,
      shopifyCreatedAt: '2026-11-09T10:00:00Z', total: 1000 + index,
      status: index < 6 ? 'approved' : 'pending', cancelled: index === 14,
      depositReceipts: [{ status: 'معتمد', amount: 100 }] }));
    await mongo.connection.collection('reconcile_orders').insertMany(orders);
    await mongo.connection.collection('reconcile_sales').insertMany([
      ...orders.slice(0, 6).map((order, index) => ({ type: 'مبيعات', shopifyOrderId: order.shopifyId,
        date: '2026-11-10', total: 900 + index, itemsTotal: 800 + index, cancelled: false })),
      { type: 'مبيعات', date: '2026-11-09', total: 100, itemsTotal: 80, shipCost: 20 },
    ]);
    browser._shopifyOrders = orders;
    const shopify = browser._spkCount(+new Date('2026-11-09T00:00:00+02:00'), +new Date('2026-11-10T00:00:00+02:00'));
    const service = overviewService('reconcile');
    let overview = await TransactionsService.prototype.getSalesOverview.call(service, 2026, 11);
    let day = overview.days.find(row => row.date === '2026-11-09')!;
    expect(shopify).toMatchObject({ received: 15, confirmed: 14, deposit: 14, cancelled: 1 });
    expect(day).toMatchObject({ orders: shopify.received, confirmedOrders: shopify.confirmed,
      receivedValue: 15105, confirmedValue: 14091, revenue: 80 });
    expect(overview).toMatchObject({ totalOrders: 15, confirmedOrders: 14, orderSource: 'shopify' });
    expect(overview.days.find(row => row.date === '2026-11-10')!.orders).toBe(0);

    // Registering an already confirmed order must not count it twice or change its cohort value.
    await mongo.connection.collection('reconcile_orders').updateOne({ shopifyId: 'shop-8' }, { $set: { status: 'approved' } });
    await mongo.connection.collection('reconcile_sales').insertOne({ type: 'مبيعات', shopifyOrderId: 'shop-8', date: '2026-11-11', total: 999 });
    overview = await TransactionsService.prototype.getSalesOverview.call(service, 2026, 11);
    expect(overview.days.find(row => row.date === '2026-11-09')).toMatchObject({ orders: 15, confirmedOrders: 14, confirmedValue: 14091 });

    // An unregistered order with a refunded receipt is no longer confirmed.
    await mongo.connection.collection('reconcile_orders').updateOne({ shopifyId: 'shop-10' }, { $set: { 'depositReceipts.0.status': 'مُسترد' } });
    overview = await TransactionsService.prototype.getSalesOverview.call(service, 2026, 11);
    day = overview.days.find(row => row.date === '2026-11-09')!;
    expect(day).toMatchObject({ orders: 15, confirmedOrders: 13, confirmedValue: 13081 });
  });
  it('uses Cairo arrival days and the Shopify creation fallback, while keeping old imports on their original day', async () => {
    await mongo.connection.collection('dated_orders').insertMany([
      { shopifyCreatedAt: '2026-11-08T22:30:00Z', total: 100, depositReceipts: [{ status: 'معتمد', amount: 10 }] },
      { shopifyCreatedAt: '2026-11-09T22:30:00Z', total: 200, shipWithoutDeposit: true },
      { createdAt: new Date('2026-11-09T12:00:00Z'), total: 300, status: 'approved' },
      { shopifyCreatedAt: '2026-10-20T12:00:00Z', createdAt: new Date('2026-11-09T12:00:00Z'), total: 999, status: 'approved' },
      { shopifyCreatedAt: '2026-11-09T12:00:00Z', total: 400, depositReceipts: [{ status: 'معلق', amount: 100 }] },
    ]);
    const overview = await TransactionsService.prototype.getSalesOverview.call(overviewService('dated'), 2026, 11);
    expect(overview.days.find(row => row.date === '2026-11-09')).toMatchObject({ orders: 3, confirmedOrders: 2, receivedValue: 800, confirmedValue: 400 });
    expect(overview.days.find(row => row.date === '2026-11-10')).toMatchObject({ orders: 1, confirmedOrders: 1, receivedValue: 200, confirmedValue: 200 });
    expect(overview.totalOrders).toBe(4);
  });
});
