import { ShopifyService } from '../../src/shopify/shopify.service';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { notificationBody, DEFAULTS, eligible } from '../../src/notifications/notifications.service';
import { notificationTitle } from '../../src/notifications/notification-titles';
import { OrderEditActor } from '../../src/shopify/order-edit.util';
import { normalizeInvoiceEdit } from '../../src/shopify/order-edit.util';

const staff: OrderEditActor = { id: 'staff1', name: 'Ahmed', username: 'ahmed', role: 'staff', perms: ['shopify-orders'] };
const admin: OrderEditActor = { id: 'admin1', name: 'Manager', username: 'manager', role: 'admin', perms: [] };
const direct = { ...staff, perms: ['shopify-orders', 'shopify-edit-direct'] };
const clone = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function setup() {
  const order: any = { _id: 'o1', shopifyId: 's1', ref: '2820', status: 'pending', cancelled: false, __v: 0,
    items: [{ productId: 'p1', name: 'Chair', code: 'C', qty: 1, price: 1000, total: 1000 }],
    itemsTotal: 1000, total: 1000, discount: 0, shipCost: 0, editHistory: [], editRequestHistory: [] };
  const tx: any = { _id: 't1', ref: '2820', shopifyOrderId: 's1', type: 'مبيعات',
    items: clone(order.items), itemsTotal: 1000, total: 1000, discount: 0, deposit: 0, remaining: 1000 };
  const service: any = Object.create(ShopifyService.prototype);
  const apply = (filter: any, update: any) => {
    if (filter._id && filter._id !== order._id) return null;
    if (filter.__v != null && filter.__v !== order.__v) return null;
    if (filter['editRequest.id'] && filter['editRequest.id'] !== order.editRequest?.id) return null;
    const status = filter['editRequest.status'];
    if (typeof status === 'string' && order.editRequest?.status !== status) return null;
    if (status?.$ne && order.editRequest?.status === status.$ne) return null;
    if (status?.$nin?.includes(order.editRequest?.status)) return null;
    if (typeof filter.status === 'string' && order.status !== filter.status) return null;
    if (filter.cancelled?.$ne === true && order.cancelled) return null;
    for (const [key, value] of Object.entries(update.$set || {})) {
      if (key === 'editRequest.status') order.editRequest.status = value;
      else order[key] = clone(value);
    }
    for (const [key, value] of Object.entries(update.$push || {})) order[key] = [...(order[key] || []), clone(value)];
    order.__v += update.$inc?.__v || 0;
    return clone(order);
  };
  service.shopifyOrderModel = { findById: jest.fn(async () => clone(order)), findOne: jest.fn(async () => clone(order)),
    findOneAndUpdate: jest.fn(async (filter, update) => apply(filter, update)), updateOne: jest.fn(async (filter, update) => apply(filter, update)) };
  service.txModel = { findById: jest.fn(async () => clone(tx)) };
  service.transactionsService = { acquireEditLock: jest.fn(), releaseEditLock: jest.fn(),
    update: jest.fn(async (_id, patch) => { Object.assign(tx, patch); return clone(tx); }) };
  service.settingsService = { getSettings: jest.fn(async () => ({ otpEnabled: true, highValueDiscountLimit: 200 })) };
  service.discountOtpService = { assertOtpForTransaction: jest.fn(async () => {
    throw new Error('OTP required');
  }) };
  service.notifications = { enqueue: jest.fn(async () => {}) };
  service.mentionsService = { createMany: jest.fn(async () => []) };
  service.presence = { emitEvent: jest.fn(), emitToUser: jest.fn() };
  service.logger = { warn: jest.fn(), log: jest.fn() };
  return { service, order, tx };
}

it('keeps combined staff item and discount edits unapplied until one admin decision', async () => {
  const { service, order } = setup();
  const result = await service.submitOrderEdit('o1', { items: [{ productId: 'p1', name: 'Chair', qty: 2, price: 1000 }],
    discount: { manualDiscount: 100 } }, staff);
  expect(result.pendingApproval).toBe(true);
  expect(order.items[0].qty).toBe(1); expect(order.total).toBe(1000);
  expect(order.editRequest.patch.total).toBe(1900);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('approval', expect.any(String), '2820', 'shopify:o1', undefined, undefined,
    expect.objectContaining({ status: 'pending', actionKey: 'edit-shopify' }));
  await service.decideOrderEdit('o1', result.requestId, true, admin);
  expect(order.items[0].qty).toBe(2); expect(order.total).toBe(1900);
  expect(order.editRequest.status).toBe('معتمد');
  expect(order.editHistory[0].editedBy).toBe(staff.name);
  expect(order.editHistory[0].approvedBy).toBe(admin.name);
  expect(service.notifications.enqueue).toHaveBeenLastCalledWith('orderEdit', expect.any(String), '2820', 'shopify:o1', staff.id, undefined,
    { actorName: admin.name, status: 'approved', editRequestId: result.requestId });
});

it('rejects without changing the order and notifies only the requesting employee', async () => {
  const { service, order } = setup();
  const result = await service.submitOrderEdit('o1', { discount: { manualDiscount: 150 } }, staff);
  await service.decideOrderEdit('o1', result.requestId, false, admin, 'Incorrect discount');
  expect(order.total).toBe(1000); expect(order.manualDiscount).toBeUndefined();
  expect(order.editRequest.rejectedReason).toBe('Incorrect discount'); expect(order.editHistory).toEqual([]);
  expect(service.notifications.enqueue).toHaveBeenLastCalledWith('orderEdit', expect.any(String), '2820', 'shopify:o1', staff.id, undefined,
    { actorName: admin.name, status: 'rejected', editRequestId: result.requestId });
});

it('blocks employee review, duplicate requests, duplicate decisions and stale approval', async () => {
  const { service, order } = setup();
  const result = await service.submitOrderEdit('o1', { discount: { manualDiscount: 150 } }, staff);
  await expect(service.submitOrderEdit('o1', { discount: { manualDiscount: 160 } }, direct)).rejects.toThrow();
  await expect(service.decideOrderEdit('o1', result.requestId, true, staff)).rejects.toThrow();
  order.shipCost = 50;
  await expect(service.decideOrderEdit('o1', result.requestId, true, admin)).rejects.toThrow('تغيّر الأوردر');
  await service.decideOrderEdit('o1', result.requestId, false, admin);
  await expect(service.decideOrderEdit('o1', result.requestId, false, admin)).rejects.toThrow();
});

it('detects a concurrent change when applying a direct edit', async () => {
  const { service, order } = setup();
  service.shopifyOrderModel.findOneAndUpdate.mockResolvedValueOnce(null);
  await expect(service.submitOrderEdit('o1', { discount: { manualDiscount: 150 } }, direct)).rejects.toThrow('تغيّر الأوردر');
  expect(order.total).toBe(1000);
});

it('allows explicitly delegated edits immediately but still enforces the discount ceiling', async () => {
  const { service, order } = setup();
  await expect(service.submitOrderEdit('o1', { discount: { manualDiscount: 201 } }, direct)).rejects.toThrow('OTP required');
  expect(order.total).toBe(1000);
  expect(service.discountOtpService.assertOtpForTransaction).toHaveBeenCalledWith('', 201);
  const result = await service.submitOrderEdit('o1', { discount: { manualDiscount: 200 } }, direct);
  expect(result.pendingApproval).toBe(false); expect(order.total).toBe(800);
  expect(order.editHistory).toHaveLength(1);
});

it('validates the OTP against the requester, order, amount and expiry', async () => {
  const { service, order } = setup();
  const otp = { requestedById: staff.id, txRef: '2820', kind: 'discount', expiresAt: new Date(Date.now() + 60000).toISOString() };
  service.discountOtpService.assertOtpForTransaction.mockResolvedValue(otp);
  const input = { discount: { manualDiscount: 300, highValueDiscountOtpId: 'otp1' } };
  for (const invalid of [{ requestedById: 'someone-else' }, { txRef: '999' }, { kind: 'edit-tx' }, { expiresAt: new Date(0).toISOString() }]) {
    service.discountOtpService.assertOtpForTransaction.mockResolvedValueOnce({ ...otp, ...invalid });
    await expect(service.submitOrderEdit('o1', input, direct)).rejects.toThrow('كود الخصم');
  }
  await service.submitOrderEdit('o1', input, staff);
  expect(order.total).toBe(1000); expect(order.editRequest.patch.manualDiscount).toBe(300);
});

it('does not let disabling OTP turn staff edits into automatic approvals', async () => {
  const { service, order } = setup();
  service.settingsService.getSettings.mockResolvedValue({ otpEnabled: false, highValueDiscountLimit: 200 });
  await service.submitOrderEdit('o1', { discount: { manualDiscount: 300 } }, staff);
  expect(order.editRequest.status).toBe('معلق'); expect(order.total).toBe(1000);
});

it('rejects invalid quantities and nonfinite or excessive discounts before writing', async () => {
  const { service } = setup();
  await expect(service.submitOrderEdit('o1', { items: [{ qty: -1, price: 100 }] }, staff)).rejects.toThrow();
  await expect(service.submitOrderEdit('o1', { discount: { manualDiscount: Infinity } }, staff)).rejects.toThrow();
  await expect(service.submitOrderEdit('o1', { discount: { manualDiscount: 1100 } }, staff)).rejects.toThrow();
  expect(service.shopifyOrderModel.findOneAndUpdate).not.toHaveBeenCalled();
});

it('requires review for conflict resolution rather than silently applying remote items', async () => {
  const { service, order } = setup();
  order.itemSyncConflict = { revision: 'v1', detectedAt: 'now', conflictingKeys: ['p1'], shopifyItems: [{ productId: 'p1', qty: 2, price: 1000 }] };
  await service.submitOrderEdit('o1', { itemConflict: { source: 'local', revision: 'v1' } }, staff);
  expect(order.itemSyncConflict.revision).toBe('v1'); expect(order.editRequest.patch.itemSyncConflict).toBeNull();
});

it('uses the existing invoice service only after approval of confirmed-order edits', async () => {
  const { service, order, tx } = setup(); order.status = 'approved';
  const result = await service.submitConfirmedOrderEdit('t1', { notes: 'Customer requested delivery tomorrow' }, staff);
  expect(tx.notes).toBeUndefined(); expect(service.transactionsService.update).not.toHaveBeenCalled();
  await service.decideOrderEdit('o1', result.requestId, true, admin);
  expect(service.transactionsService.update).toHaveBeenCalledWith('t1', { notes: 'Customer requested delivery tomorrow' }, staff.name, admin.name, 'admin', admin.name, []);
  expect(tx.notes).toBe('Customer requested delivery tomorrow'); expect(order.editRequest.status).toBe('معتمد');
  expect(service.transactionsService.releaseEditLock).toHaveBeenCalledWith('t1');
});

it('delegates confirmed edits while retaining staff shipping restrictions and OTP', async () => {
  const { service, order } = setup(); order.status = 'approved';
  await expect(service.submitConfirmedOrderEdit('t1', { discount: 300 }, direct)).rejects.toThrow('OTP required');
  await service.submitConfirmedOrderEdit('t1', { notes: 'Direct edit' }, direct);
  expect(service.transactionsService.update).toHaveBeenCalledWith('t1', { notes: 'Direct edit' }, staff.name, staff.name, 'staff', staff.name, direct.perms);
});

it('rejects confirmed edits whose invoice changed during review', async () => {
  const { service, order, tx } = setup(); order.status = 'approved';
  const result = await service.submitConfirmedOrderEdit('t1', { notes: 'Proposed' }, staff);
  tx.deposit = 100;
  await expect(service.decideOrderEdit('o1', result.requestId, true, admin)).rejects.toThrow('تغيّرت الفاتورة');
  expect(service.transactionsService.update).not.toHaveBeenCalled();
});

it('does not announce approval if the invoice update fails', async () => {
  const { service, order } = setup(); order.status = 'approved';
  const result = await service.submitConfirmedOrderEdit('t1', { notes: 'Proposed' }, staff);
  service.transactionsService.update.mockRejectedValueOnce(new Error('Stock unavailable'));
  await expect(service.decideOrderEdit('o1', result.requestId, true, admin)).rejects.toThrow('Stock unavailable');
  expect(order.editRequest.status).toBe('معلق');
  expect(service.notifications.enqueue.mock.calls.some((call: any[]) => call[0] === 'orderEdit')).toBe(false);
  expect(service.transactionsService.releaseEditLock).toHaveBeenCalledWith('t1');
});

it('blocks a direct invoice API bypass even if the caller supplies an approvedBy name', async () => {
  const service: any = Object.create(TransactionsService.prototype);
  service.transactionModel = { findById: () => ({ exec: async () => ({ shopifyOrderId: 's1', discount: 0 }) }) };
  await expect(service.update('t1', { notes: 'Attempt' }, staff.name, admin.name, 'staff')).rejects.toThrow('موافقة المدير');
});

it('derives invoice totals on the server so a lower posted total cannot bypass the discount rule', () => {
  const tx = { items: [{ qty: 2, price: 1000 }], discount: 100, shipCost: 50, deposit: 0 };
  expect(normalizeInvoiceEdit(tx, { total: 1 })).toMatchObject({ itemsTotal: 2000, total: 1950, discount: 100, remaining: 1950 });
});

it('blocks confirmation of an order with an undecided edit', async () => {
  const { service, order } = setup();
  order.editRequest = { status: 'معلق' };
  await expect(service.approveOrder('o1', admin.name)).rejects.toThrow('راجع طلب تعديل');
});

it('sends both legacy edit endpoints through the authenticated approval workflow', async () => {
  const controller: any = Object.create(ShopifyController.prototype);
  controller.shopifyService = { submitOrderEdit: jest.fn() };
  const req = { user: { userId: staff.id, name: staff.name, username: staff.username, role: staff.role, perms: staff.perms } };
  await controller.updateItems('o1', [{ qty: 2 }], req);
  await controller.updateDiscount('o1', { manualDiscount: 100 }, req);
  expect(controller.shopifyService.submitOrderEdit).toHaveBeenNthCalledWith(1, 'o1', { items: [{ qty: 2 }] }, expect.objectContaining(staff));
  expect(controller.shopifyService.submitOrderEdit).toHaveBeenNthCalledWith(2, 'o1', { discount: { manualDiscount: 100 } }, expect.objectContaining(staff));
});

it('formats approval and rejection notifications for staff in both languages', () => {
  expect(eligible({ role: 'staff' }, { ...DEFAULTS, enabled: true }, 'orderEdit')).toBe(true);
  expect(notificationTitle('orderEdit', { status: 'approved' }, 'en')).toBe('✅ Order Edit Approved · SOULIA');
  expect(notificationBody('orderEdit', '2820', { actorName: 'Manager', status: 'rejected' }, 'en')).toBe('Order #2820 · Edit rejected · Manager');
  expect(notificationBody('orderEdit', '2820', { actorName: 'المدير', status: 'approved' }, 'ar')).toBe('الطلب #2820 · تم قبول التعديل · المدير');
  expect(notificationBody('otp', '2820', { actorName: 'Ahmed', actionKey: 'discount', amount: 300 }, 'en')).toBe('Ahmed · Discount request · #2820 · Discount: EGP 300 · OTP: {OTP}');
});
