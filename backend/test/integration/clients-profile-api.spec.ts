import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Connection } from 'mongoose';
import { ClientsController } from '../../src/clients/clients.controller';
import { ClientsService } from '../../src/clients/clients.service';
import { ClientContactSchema } from '../../src/clients/client-contact.schema';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { ShopifyOrderSchema } from '../../src/shopify/schemas/shopify-order.schema';
import { ReturnRequestSchema } from '../../src/returns/schemas/return-request.schema';
import { FollowUpSchema } from '../../src/followups/schemas/followup.schema';
import { ComplaintSchema } from '../../src/complaints/schemas/complaint.schema';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';

// Real projections and contact persistence, isolated from the workspace database.
const uri = process.env.CLIENT_PROFILE_TEST_MONGODB_URI || `mongodb://127.0.0.1:27017/soulia_test_client_profile_${process.pid}_${Date.now()}`;
if (!/^soulia_test_client_profile_[a-zA-Z0-9_-]+$/.test(uri.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '')) {
  throw new Error('Only a dedicated soulia_test_client_profile_ database is allowed');
}
describe('clients API — real MongoDB', () => {
  let connection: Connection, app: any, origin: string, models: any;
  const phone = '01012345678', key = 'p:201012345678';
  const sale = (id: mongoose.Types.ObjectId, extra: any = {}) => ({ _id: id, type: 'مبيعات', client: 'منى', phone,
    ref: String(id), total: 1000, deposit: 250, remaining: 750, date: '2026-10-01', ...extra });
  const request = (path: string, init: RequestInit = {}) => fetch(origin + '/api/clients' + path, {
    ...init, headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  beforeAll(async () => {
    connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 3000 }).asPromise();
    models = { Transaction: connection.model('Transaction', TransactionSchema),
      ShopifyOrder: connection.model('ShopifyOrder', ShopifyOrderSchema),
      ReturnRequest: connection.model('ReturnRequest', ReturnRequestSchema), FollowUp: connection.model('FollowUp', FollowUpSchema),
      ClientContact: connection.model('ClientContact', ClientContactSchema), Complaint: connection.model('Complaint', ComplaintSchema) };
    const module = await Test.createTestingModule({ controllers: [ClientsController], providers: [ClientsService,
      ...Object.entries(models).map(([name, model]) => ({ provide: getModelToken(name), useValue: model }))] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
        const req = context.switchToHttp().getRequest();
        req.user = { role: 'staff', username: 'profile-reviewer', perms: req.headers['x-test-access'] === 'none' ? []
          : req.headers['x-test-access'] === 'tickets' ? ['clients', 'complaints'] : ['clients'] };
        return true;
      } }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  });
  afterEach(async () => { if (models) for (const model of Object.values(models) as any[]) await model.deleteMany({}); });
  afterAll(async () => {
    await app?.close();
    if (connection) { await connection.dropDatabase(); await connection.close(); }
  });
  it('includes unregistered cancellations, deduplicates conversions, and reads legacy Shopify email without exposing raw data', async () => {
    const txId = new mongoose.Types.ObjectId(), orderId = new mongoose.Types.ObjectId();
    await models.Transaction.collection.insertMany([sale(txId, { shopifyOrderId: '101', pickupStatus: 'Delivered' })]);
    await models.ShopifyOrder.collection.insertMany([{ _id: orderId, shopifyId: '101', ref: '101', client: 'منى', phone,
      rawData: { customer: { id: 'customer-1', email: 'Person@Example.com' }, privateToken: 'NEVER_RETURN_RAW_DATA' } },
    { _id: new mongoose.Types.ObjectId(), shopifyId: '102', ref: '102', client: 'منى', phone,
      cancelled: true, cancelReasonCode: 'customer-changed-mind' }]);
    const res = await request('/profile?key=s%3Acustomer-1');
    expect(res.status).toBe(200);
    const p: any = await res.json();
    expect(p.stats).toMatchObject({ orders: 2, delivered: 1, cancelledBefore: 1 });
    expect(p.email).toBe('person@example.com');
    expect(JSON.stringify(p)).not.toContain('NEVER_RETURN_RAW_DATA');
    const byOrder: any = await (await request('/order-profile?id=' + orderId)).json();
    expect(byOrder.key).toBe(p.key);
    const list: any = await (await request('')).json();
    expect(list).toHaveLength(1); expect(list[0].history).toBeUndefined();
  });
  it('opens a profile at the first Shopify order without an invoice and reuses it for manual sales and conversion', async () => {
    const orderId = new mongoose.Types.ObjectId();
    await models.ShopifyOrder.create({ _id: orderId, shopifyId: 'first-site-order', ref: 'site-1', client: 'عميل جديد', phone,
      rawData: { customer: { id: 'first-customer', email: 'first@example.com' } }, status: 'pending', total: 1000, items: [] });
    let list: any = await (await request('')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 's:first-customer', stats: { orders: 1, invoices: 0, unregisteredOrders: 1 }, money: { total: 0 } });
    const savedKey = list[0].key;
    let p: any = await (await request('/profile?key=' + encodeURIComponent(savedKey))).json();
    expect(p.history).toHaveLength(1); expect(p.history[0].source).toBe('shopify');

    // A separate manually saved sale for the same phone joins the same customer.
    await models.Transaction.collection.insertOne(sale(new mongoose.Types.ObjectId()));
    list = await (await request('')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: savedKey, stats: { orders: 2, invoices: 1, unregisteredOrders: 1 } });

    // Converting the original website order replaces its history row rather than duplicating it.
    await models.Transaction.collection.insertOne(sale(new mongoose.Types.ObjectId(), { shopifyOrderId: 'first-site-order' }));
    p = await (await request('/profile?key=' + encodeURIComponent(savedKey))).json();
    expect(p.stats).toMatchObject({ orders: 2, invoices: 2, unregisteredOrders: 0 });
    expect(p.history).toHaveLength(2);
    expect(await models.ClientContact.countDocuments()).toBe(0); // No manual profile/contact setup is required.
  });
  it('includes a customer immediately after their first manual sale, even without a previous website order', async () => {
    await models.Transaction.collection.insertOne(sale(new mongoose.Types.ObjectId(), { client: 'عميل يدوي جديد' }));
    const list: any = await (await request('')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key, name: 'عميل يدوي جديد', stats: { orders: 1, invoices: 1, unregisteredOrders: 0 } });
    expect((await request('/profile?key=' + encodeURIComponent(key))).status).toBe(200);
  });
  it('persists manual email through subsequent reads and later Shopify identity enrichment', async () => {
    await models.Transaction.collection.insertOne(sale(new mongoose.Types.ObjectId()));
    expect((await request('/email?key=' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify({ email: 'Manual@Example.com' }) })).status).toBe(200);
    let p: any = await (await request('/profile?key=' + encodeURIComponent(key))).json();
    expect(p.email).toBe('manual@example.com'); expect(p.emailSource).toBe('manual');
    await models.ShopifyOrder.collection.insertOne({ _id: new mongoose.Types.ObjectId(), shopifyId: 'new-order', client: 'منى', phone,
      rawData: { customer: { id: 'new-customer', email: 'shopify@example.com' } } });
    p = await (await request('/profile?key=' + encodeURIComponent(key))).json();
    expect(p.key).toBe('s:new-customer'); expect(p.email).toBe('manual@example.com');
    await request('/email?key=' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify({ email: '' }) });
    p = await (await request('/profile?key=s%3Anew-customer')).json();
    expect(p.email).toBe('');
  });
  it('does not transfer a manual email to other customers sharing a phone', async () => {
    await models.ClientContact.create({ key, email: 'private@example.com' });
    await models.ShopifyOrder.collection.insertMany(['a', 'b'].map(id => ({ _id: new mongoose.Types.ObjectId(), shopifyId: id,
      client: id, phone, shopifyCustomerId: id })));
    const list: any = await (await request('')).json();
    expect(list).toHaveLength(2); expect(list.every((p: any) => p.email !== 'private@example.com')).toBe(true);
    expect((await request('/profile?key=' + encodeURIComponent(key))).status).toBe(404);
  });
  it('validates email, rejects missing clients permission, and returns explicit not-found responses', async () => {
    expect((await request('/email?key=' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify({ email: 'invalid' }) })).status).toBe(400);
    expect((await request('', { headers: { 'x-test-access': 'none' } })).status).toBe(403);
    expect((await request('/email?key=' + encodeURIComponent(key), { method: 'PATCH', headers: { 'x-test-access': 'none' }, body: JSON.stringify({ email: 'x@example.com' }) })).status).toBe(403);
    expect((await request('/profile?key=missing')).status).toBe(404);
    expect((await request('/order-profile')).status).toBe(404);
  });
  it('provides distinct named profile links, resolves older names, and opens the customer from an invoice', async () => {
    const first = new mongoose.Types.ObjectId(), second = new mongoose.Types.ObjectId();
    await models.Transaction.collection.insertMany([sale(first), sale(second, { phone: '01112345678' })]);
    const list: any = await (await request('')).json();
    expect(list[0].code).not.toBe(list[1].code);
    expect(list[0].code).toMatch(/^CL-[A-F\d]{20}$/);
    expect(decodeURIComponent(list[0].profilePath)).toContain('منى~CL-');
    const token = decodeURIComponent(list[0].profilePath.split('/').pop());
    let p: any = await (await request('/profile?key=' + encodeURIComponent(token))).json();
    expect(p.key).toBe(list[0].key);
    await models.Transaction.updateOne({ _id: first }, { $set: { client: 'الاسم الجديد' } });
    p = await (await request('/profile?key=' + encodeURIComponent(token))).json();
    expect(p.name).toBe('الاسم الجديد'); expect(p.code).toBe(list[0].code);
    const byInvoice: any = await (await request('/order-profile?source=transaction&id=' + first)).json();
    expect(byInvoice.code).toBe(p.code);
  });
  it('keeps an old coded link usable when a legacy phone gains a Shopify customer identity', async () => {
    await models.Transaction.collection.insertOne(sale(new mongoose.Types.ObjectId()));
    const before: any = await (await request('')).json();
    const token = decodeURIComponent(before[0].profilePath.split('/').pop());
    await models.ShopifyOrder.collection.insertOne({ _id: new mongoose.Types.ObjectId(), shopifyId: 'new', phone, client: 'منى', shopifyCustomerId: 'stable-customer' });
    const p: any = await (await request('/profile?key=' + encodeURIComponent(token))).json();
    expect(p.key).toBe('s:stable-customer'); expect(p.stats.orders).toBe(2);
  });
  it('loads related follow-ups and complaints only with Customer Care permission and excludes other customers', async () => {
    const txId = new mongoose.Types.ObjectId(), unrelated = new mongoose.Types.ObjectId();
    await models.Transaction.collection.insertMany([sale(txId), sale(unrelated, { phone: '01112345678' })]);
    await models.FollowUp.collection.insertMany([{ transactionId: String(txId), ticketNo: 'FU-1', reason: 'تأكيد البيانات', status: 'قيد المتابعة', createdAt: new Date() },
      { transactionId: String(unrelated), ticketNo: 'FU-OTHER', reason: 'عميل آخر', createdAt: new Date() }]);
    await models.Complaint.collection.insertMany([{ transactionId: String(txId), complaintNo: 'CMP-1', description: 'شكوى العميل', status: 'معلق', createdAt: new Date() },
      { phone, complaintNo: 'CMP-PHONE', description: 'شكوى مرتبطة بالهاتف', createdAt: new Date() },
      { transactionId: String(unrelated), complaintNo: 'CMP-OTHER', description: 'عميل آخر', createdAt: new Date() }]);
    expect((await request('/tickets?key=' + encodeURIComponent(key))).status).toBe(403);
    const response = await request('/tickets?key=' + encodeURIComponent(key), { headers: { 'x-test-access': 'tickets' } });
    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.rows.map((r: any) => r.number).sort()).toEqual(['CMP-1', 'CMP-PHONE', 'FU-1']);
    expect(data.rows.map((r: any) => r.kind)).toEqual(expect.arrayContaining(['followup', 'complaint']));
  });
  it('does not attach phone-only tickets to different Shopify customers sharing a family number', async () => {
    const txId = new mongoose.Types.ObjectId();
    await models.Transaction.collection.insertOne(sale(txId, { shopifyOrderId: 'a', shopifyCustomerId: 'a' }));
    await models.ShopifyOrder.collection.insertMany(['a', 'b'].map(id => ({ _id: new mongoose.Types.ObjectId(), shopifyId: id, shopifyCustomerId: id, client: id, phone })));
    await models.Complaint.collection.insertMany([{ complaintNo: 'CMP-SHARED', phone, description: 'غير محدد' },
      { complaintNo: 'CMP-LINKED', transactionId: String(txId), phone, description: 'مرتبطة بالطلب' }]);
    const headers = { 'x-test-access': 'tickets' };
    const a: any = await (await request('/tickets?key=s%3Aa', { headers })).json();
    const b: any = await (await request('/tickets?key=s%3Ab', { headers })).json();
    expect(a.rows.map((r: any) => r.number)).toEqual(['CMP-LINKED']); expect(b.rows).toEqual([]);
  });
  it('opens the customer from a reversed return invoice through its original sale', async () => {
    const txId = new mongoose.Types.ObjectId();
    await models.Transaction.collection.insertOne(sale(txId));
    await models.ReturnRequest.collection.insertOne({ originalTransactionId: String(txId), returnTxId: 'old-return', status: 'معتمد', reversedAt: new Date().toISOString() });
    const response = await request('/order-profile?source=transaction&id=old-return');
    expect(response.status).toBe(200); expect((await response.json() as any).key).toBe(key);
  });
});
