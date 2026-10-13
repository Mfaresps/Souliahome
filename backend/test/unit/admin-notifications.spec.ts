import { NotificationsService, DEFAULTS, eligible, notificationBody } from '../../src/notifications/notifications.service';
import { ADMIN_TYPES, shopifyChangeEvent, notifyApproval } from '../../src/notifications/admin-events';
import { DiscountOtpService } from '../../src/discount-otp/discount-otp.service';
import { SecurityAuditService } from '../../src/security-audit/security-audit.service';
import { RolesGuard } from '../../src/core/guards/roles.guard';
import { PermsGuard } from '../../src/core/guards/perms.guard';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { ExpensesService } from '../../src/expenses/expenses.service';
import { ProductsService } from '../../src/products/products.service';

const id = '507f1f77bcf86cd799439011';
const subscription = { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
function fixture() {
  const admin: any = { _id: id, userId: id, role: 'admin', isActive: true };
  const account: any = { preferences: { ...DEFAULTS, enabled: true }, subscriptions: [subscription], language: 'en' };
  const otp: any = { _id: id, otp: '493821', status: 'unused', expiresAt: new Date(Date.now() + 90000).toISOString() };
  const jobs = { updateOne: jest.fn(async (_filter: any, _update: any) => ({})) };
  const users = { find: jest.fn(() => ({ toArray: async () => [admin] })), findOne: jest.fn(async () => admin) };
  const connection: any = { collection: (name: string) => ({ users, notificationjobs: jobs, notificationaccounts: { findOne: async () => account }, discountotps: { findOne: async () => otp } } as any)[name] };
  const service: any = new NotificationsService(connection);
  service.push = { sendNotification: jest.fn(async () => ({})) };
  const job: any = { _id: id, userId: id, endpoint: subscription.endpoint, type: 'otp', otpId: id, attempts: 1, payload: JSON.stringify({ body: 'Ahmed · Open cash register · #2771 · OTP: {OTP}' }) };
  return { admin, account, otp, jobs, users, service, job };
}
describe('Admin-only notifications and OTP secrecy', () => {
  it.each(ADMIN_TYPES)('isolates %s from staff, viewer and inactive admins', async type => {
    const { service, admin, account, jobs } = fixture();
    for (const role of ['staff', 'viewer']) {
      admin.role = role;
      expect(eligible(admin, account.preferences, type)).toBe(false);
      await expect(service.preferences(admin, { [type]: true })).rejects.toThrow();
      await service.enqueue(type, 'event', '2771', 'otp:' + id, undefined, undefined, { expiresAt: new Date(Date.now() + 90000).toISOString() });
      expect(jobs.updateOne).not.toHaveBeenCalled();
    }
    admin.role = 'admin'; admin.isActive = false;
    expect(eligible(admin, account.preferences, type)).toBe(false);
  });
  it('stores only an OTP reference and inserts the actual code at dispatch with bounded TTL', async () => {
    const { service, otp, jobs, job } = fixture();
    await service.enqueue('otp', 'otp:' + id, '2771', 'otp:' + id, undefined, undefined, { actorName: 'Ahmed', actionKey: 'vault-access', expiresAt: otp.expiresAt });
    const stored = jobs.updateOne.mock.calls[0][1].$setOnInsert;
    expect(JSON.stringify(stored)).not.toContain(otp.otp);
    expect(stored.otpId).toBe(id); expect(stored.expiresAt.getTime()).toBe(Date.parse(otp.expiresAt));
    await service.dispatchJob(job);
    const sent = service.push.sendNotification.mock.calls[0];
    expect(JSON.parse(sent[1]).body).toContain('OTP: ' + otp.otp);
    expect(sent[2].TTL).toBeGreaterThan(0); expect(sent[2].TTL).toBeLessThanOrEqual(90);
    expect(job.payload).not.toContain(otp.otp);
    expect(JSON.stringify(jobs.updateOne.mock.calls)).not.toContain(otp.otp);
  });
  it.each(['used', 'expired'])('does not send a %s OTP', async status => {
    const { service, otp, job, jobs } = fixture(); otp.status = status;
    await service.dispatchJob(job);
    expect(service.push.sendNotification).not.toHaveBeenCalled();
    expect(jobs.updateOne).toHaveBeenCalledWith({ _id: id }, expect.objectContaining({ $set: { done: true } }));
  });
  it.each(['approved', 'rejected'])('does not send a code for an already %s edit request', async status => {
    const { service, otp, job } = fixture(); otp.editStatus = status;
    await service.dispatchJob(job); expect(service.push.sendNotification).not.toHaveBeenCalled();
  });
  it('rechecks expiry, recipient role and category immediately before sending', async () => {
    const { service, otp, job, admin, account } = fixture();
    otp.expiresAt = new Date(Date.now() - 1000).toISOString();
    await service.dispatchJob(job);
    otp.expiresAt = new Date(Date.now() + 90000).toISOString(); admin.role = 'staff';
    await service.dispatchJob(job);
    admin.role = 'admin'; account.preferences.otp = false;
    await service.dispatchJob(job); expect(service.push.sendNotification).not.toHaveBeenCalled();
  });
  it('formats each action and decision without raw audit details or customer data', () => {
    expect(notificationBody('otp', '2771', { actorName: 'Fares', actionKey: 'edit-tx' }, 'en')).toBe('Fares · Modify invoice · #2771 · OTP: {OTP}');
    expect(notificationBody('approval', '2771', { actorName: 'Fares', actionKey: 'cancel', status: 'rejected' }, 'en')).toContain('Rejected');
    expect(notificationBody('security', '', { actorName: 'Ahmed', actionKey: 'failed_login' }, 'en')).toBe('Ahmed · Failed login');
    expect(notificationBody('shopifyChange', '2771', { changedFields: ['address', 'quantity', 'price', 'products'] }, 'en')).toBe('Order #2771 · Address, Quantity, Price, Products');
  });
  it('OTP requests notify only after persistence and remain successful if notifications fail', async () => {
    const service: any = Object.create(DiscountOtpService.prototype);
    const doc = { _id: id, requestedByName: 'Ahmed', kind: 'vault-access', expiresAt: new Date(Date.now() + 60000).toISOString(), otp: '493821' };
    service.otpModel = { create: jest.fn(async () => doc) }; service.notifications = { enqueue: jest.fn(async () => {}) };
    expect(await service.createOtpDocument({ otp: doc.otp })).toBe(doc);
    expect(service.notifications.enqueue).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(service.notifications.enqueue.mock.calls)).not.toContain(doc.otp);
    service.otpModel.create.mockRejectedValueOnce(new Error('database'));
    await expect(service.createOtpDocument({})).rejects.toThrow('database');
    expect(service.notifications.enqueue).toHaveBeenCalledTimes(2);
    service.notifications.enqueue.mockRejectedValueOnce(new Error('push unavailable'));
    expect(await service.createOtpDocument({})).toBe(doc);
  });
  it('audit alerts exclude private details and cannot break audit persistence', async () => {
    const service: any = new SecurityAuditService({ create: async () => ({ _id: id }) } as any);
    service.notifications = { enqueue: jest.fn(async () => { throw new Error('offline'); }) };
    await expect(service.log({ userId: id, username: 'Ahmed', violationType: 'failed_login', action: 'Failed', detail: 'private password or token' })).resolves.toEqual({ _id: id });
    expect(JSON.stringify(service.notifications.enqueue.mock.calls)).not.toContain('private password');
    expect(service.notifications.enqueue).toHaveBeenCalledWith('security', 'audit:' + id, '', 'audit:' + id, undefined, undefined, { actorName: 'Ahmed', actionKey: 'failed_login' });
  });
  it.each([RolesGuard, PermsGuard])('%p preserves permission denial when the audit service fails', Guard => {
    const guard: any = new Guard({ getAllAndOverride: () => ['admin'] } as any);
    guard.audit = { log: jest.fn(() => Promise.reject(new Error('offline'))) };
    const request = { user: { userId: id, username: 'Ahmed', role: 'staff', perms: [] } };
    const context: any = { getHandler: () => {}, getClass: () => {}, switchToHttp: () => ({ getRequest: () => request }) };
    expect(guard.canActivate(context)).toBe(false); expect(guard.canActivate(context)).toBe(false);
    expect(guard.audit.log).toHaveBeenCalledTimes(1);
  });
  it('approval notification transport failures are swallowed', async () => {
    await expect(notifyApproval({ enqueue: async () => { throw new Error('offline'); } } as any, 'event', '2771', 'tx:' + id, { actionKey: 'cancel', status: 'approved' })).resolves.toBeUndefined();
  });
  it('expense approval sends the decision only after the vault deduction succeeds', async () => {
    const expense: any = { _id: id, expenseNo: 'EXP-1', employee: 'Ahmed', status: 'معلق', save: jest.fn(async () => expense) };
    const vault: any = { assertSufficientBalance: jest.fn(async () => {}), addSystemEntry: jest.fn(async () => {}) };
    const service: any = new ExpensesService({ findById: () => ({ exec: async () => expense }) } as any, vault);
    service.notifications = { enqueue: jest.fn(async () => {}) };
    vault.addSystemEntry.mockRejectedValueOnce(new Error('vault failure'));
    await expect(service.approve(id, 'Admin')).rejects.toThrow('vault failure');
    expect(service.notifications.enqueue).not.toHaveBeenCalled();
    expense.status = 'معلق'; await service.approve(id, 'Admin');
    expect(service.notifications.enqueue).toHaveBeenCalledWith('approval', 'approval:expense:' + id + ':approved', 'EXP-1', 'expense:' + id, undefined, undefined, { actorName: 'Ahmed', actionKey: 'expense', status: 'approved' });
  });
  it('product rejection preserves employee and request identity and tolerates push failure', async () => {
    const service: any = Object.create(ProductsService.prototype);
    const product: any = { _id: id, code: 'SKU-1', editRequest: { status: 'معلق', requestedBy: 'Ahmed', requestedAt: 'request-time' }, markModified: jest.fn(), save: jest.fn(async () => product) };
    service.productModel = { findById: () => ({ exec: async () => product }) }; service.emit = jest.fn();
    service.notifications = { enqueue: jest.fn(async () => { throw new Error('offline'); }) };
    expect(await service.rejectProductEdit(id, 'Admin')).toBe(product);
    expect(product.editRequest.status).toBe('مرفوض');
    expect(service.notifications.enqueue).toHaveBeenCalledWith('approval', 'approval:product:' + id + ':request-time:rejected', 'SKU-1', 'product:' + id, undefined, undefined, { actorName: 'Ahmed', actionKey: 'product', status: 'rejected' });
  });
});
describe('Shopify modification detection', () => {
  const original = { id: 1, updated_at: '2026-10-13T10:00:00Z', total_price: '100.00', shipping_address: { address1: 'Private street', city: 'Cairo' }, line_items: [{ id: 2, product_id: 5, variant_id: 6, title: 'Item', quantity: 1, price: '100.00' }] };
  it('ignores replayed payloads, timestamps, equivalent numeric formats and key ordering', () => {
    expect(shopifyChangeEvent(original, { ...original, total_price: 100, updated_at: 'later', shipping_address: { city: 'Cairo', address1: 'Private street' } }).fields).toEqual([]);
  });
  it('identifies address, price, quantities and products without including their values', () => {
    const changed = { ...original, total_price: '200', shipping_address: { address1: 'Other private street' }, line_items: [{ ...original.line_items[0], product_id: 7, quantity: 2, price: '110' }] };
    const event = shopifyChangeEvent(original, changed);
    expect(event.fields).toEqual(expect.arrayContaining(['address', 'price', 'quantity', 'products']));
    expect(JSON.stringify(event)).not.toContain('private street');
    expect(shopifyChangeEvent(original, changed).fingerprint).toBe(event.fingerprint);
    expect(shopifyChangeEvent(changed, changed).fields).toEqual([]);
  });
  it('detects frozen-order financial changes even when the local total remains unchanged', async () => {
    const service: any = Object.create(ShopifyService.prototype);
    const order: any = { _id: id, ref: '2771', status: 'approved', total: 100, rawData: original, save: jest.fn(async () => {}), markModified: jest.fn() };
    service.shopifyOrderModel = { findOne: async () => order };
    service.mapItems = async () => [];
    service.txModel = { findOne: () => ({ select: () => ({ lean: async () => null }) }), updateOne: async () => ({}) };
    service.notifications = { enqueue: jest.fn(async () => {}) }; service.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() }; service.emit = jest.fn();
    await service.handleOrderUpdate({ ...original, total_price: '200', line_items: [{ ...original.line_items[0], quantity: 2 }] });
    expect(order.total).toBe(100);
    expect(service.notifications.enqueue).toHaveBeenCalledWith('shopifyChange', expect.any(String), '2771', 'shopify:' + id, undefined, undefined, { changedFields: expect.arrayContaining(['price', 'quantity']) });
    service.notifications.enqueue.mockClear();
    await service.handleOrderUpdate(order.rawData); expect(service.notifications.enqueue).not.toHaveBeenCalled();
  });
});
