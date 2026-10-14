import { BostaService } from '../../src/bosta/bosta.service';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { FollowUpsService } from '../../src/followups/followups.service';
import { FollowUpsController } from '../../src/followups/followups.controller';
import { TransactionsController } from '../../src/transactions/transactions.controller';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
function bosta(tx: any) {
  const service: any = Object.create(BostaService.prototype);
  const enqueue = jest.fn(async () => {}); service.notifications = { enqueue };
  service.logger = { log() {}, warn() {}, error() {} }; service.emit = jest.fn();
  service.txModel = { findByIdAndUpdate: jest.fn(async () => tx), findById: () => ({ lean: async () => tx }) };
  service.autoSettleScheduleFor = async () => ({});
  service.followUpsService = { openShippingIssueFollowUp: jest.fn(async () => null) };
  return { service, enqueue };
}
it('new Shopify orders pass the saved assignee into the same new-order push event and skip duplicates', async () => {
  const service: any = Object.create(ShopifyService.prototype);
  const employeeId = '507f1f77bcf86cd799439011';
  let stored: any = null;
  const order: any = { _id: '507f1f77bcf86cd799439012', ref: '2771', total: 2450, save: jest.fn(async () => order) };
  service.shopifyOrderModel = { findOne: () => ({ lean: async () => stored }), create: jest.fn(async () => { stored = order; return order; }) };
  service.logger = { log() {}, warn() {}, error() {} };
  service.mapItems = async () => [{ qty: 2, price: 100 }, { qty: 3, price: 200 }]; service.pickOrderDiscountApplication = () => undefined;
  service.applyDerivedDeposit = jest.fn();
  service.employeeShiftService = { resolveAssignee: async () => ({ userId: employeeId, username: 'ahmed', name: 'Ahmed', reason: 'shift' }) };
  service.employeeScoringService = { scoreDepositDetection: async () => {} };
  service.notifyOrderAssigned = jest.fn(async () => {});
  service.notifications = { enqueue: jest.fn(async () => {}) };
  expect((await service.handleOrder({ id: 1, name: '#2771' })).saved).toBe(true);
  expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('order', 'order:shopify:1', '2771', 'shopify:' + order._id, undefined, undefined, { orderTotal: 2450, itemCount: 5, assignedUserId: employeeId });
  const before = service.notifications.enqueue.mock.calls.length;
  expect((await service.handleOrder({ id: 1, name: '#2771' })).saved).toBe(false);
  expect(service.notifications.enqueue).toHaveBeenCalledTimes(before);
});
it.each(['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'UNKNOWN'])('does not alert on intermediate Bosta %s', async status => {
  const { service, enqueue } = bosta({ _id: 't1', ref: '100', bostaStatus: 'CREATED' });
  await service.applyDeliveryUpdate('t1', { _id: 't1', ref: '100', bostaStatus: 'CREATED' }, { status }, 'webhook'); expect(enqueue).not.toHaveBeenCalled();
});
it('alerts only on verified delivery transition and ignores repeats', async () => {
  const tx = { _id: 't1', ref: '100', bostaOrderId: 'B1', bostaStatus: 'IN_TRANSIT' }; const { service, enqueue } = bosta(tx);
  await service.applyDeliveryUpdate('t1', tx, { status: 'DELIVERED' }, 'webhook'); expect(enqueue).toHaveBeenCalledWith('delivered', 'delivered:t1:B1', '100', 'tx:t1');
  enqueue.mockClear(); await service.applyDeliveryUpdate('t1', { ...tx, bostaStatus: 'DELIVERED' }, { status: 'DELIVERED' }, 'webhook'); expect(enqueue).not.toHaveBeenCalled();
});
it('does not alert again for an unresolved delivery issue or a return after delivery', async () => {
  const tx = { _id: 't1', ref: '100', bostaStatus: 'IN_TRANSIT' }; const { service, enqueue } = bosta(tx);
  await service.applyDeliveryUpdate('t1', tx, { status: 'FAILED_ATTEMPT' }, 'webhook'); expect(enqueue).toHaveBeenCalledWith('deliveryProblem', expect.any(String), '100', 'tx:t1', undefined, 'FAILED_ATTEMPT');
  enqueue.mockClear(); await service.applyDeliveryUpdate('t1', { ...tx, shipIssueState: 'open', bostaStatus: 'FAILED_ATTEMPT' }, { status: 'RETURNED' }, 'webhook'); expect(enqueue).not.toHaveBeenCalled();
  await service.applyDeliveryUpdate('t1', { ...tx, deliveredAt: '2026-01-01', bostaStatus: 'DELIVERED' }, { status: 'RETURNED' }, 'webhook'); expect(enqueue).not.toHaveBeenCalled();
});
it('resolution closes the existing issue and produces a delivery notification', async () => {
  const tx = { _id: 't1', ref: '100', bostaStatus: 'FAILED_ATTEMPT', shipIssueState: 'open' }; const { service, enqueue } = bosta(tx);
  await service.applyDeliveryUpdate('t1', tx, { status: 'DELIVERED' }, 'webhook');
  expect(service.txModel.findByIdAndUpdate).toHaveBeenCalledWith('t1', expect.objectContaining({ $set: expect.objectContaining({ shipIssueState: 'closed' }) })); expect(enqueue).toHaveBeenCalledTimes(1);
});
it('manual delivery lock ignores incoming carrier events', async () => {
  const tx = { _id: 't1', bostaStatus: 'DELIVERED', deliverySource: 'MANUAL' }; const { service, enqueue } = bosta(tx);
  await service.applyDeliveryUpdate('t1', tx, { status: 'FAILED_ATTEMPT' }, 'webhook'); expect(enqueue).not.toHaveBeenCalled();
});
it('Shopify comment updates alert only new persisted IDs', async () => {
  const service: any = Object.create(ShopifyService.prototype); const order = { _id: 'o1', ref: '100', comments: [{ id: 1 }], markModified: jest.fn(), save: jest.fn(async () => {}) };
  service.shopifyOrderModel = { findById: async () => order }; service.notifications = { enqueue: jest.fn(async () => {}) };
  await service.updateOrderComments('o1', [{ id: 1 }, { id: 2, employee: 'Fares', text: 'Called customer' }], 'u1'); await service.updateOrderComments('o1', [{ id: 1 }, { id: 2 }], 'u1'); expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('comment', 'comment:shopify:o1:2', '100', 'shopify:o1', undefined, undefined, { actorUserId: 'u1', actorName: 'Fares', commentId: 2, commentText: 'Called customer' });
  order.save.mockRejectedValueOnce(new Error('failed') as never); await expect(service.updateOrderComments('o1', [{ id: 3 }])).rejects.toThrow('failed'); expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
});
it('transaction comments notify after persistence and ignore unchanged IDs', async () => {
  const service: any = Object.create(TransactionsService.prototype);
  service.transactionModel = { findById: () => ({ lean: async () => ({ comments: [{ id: 1 }] }) }), findByIdAndUpdate: () => ({ exec: async () => ({ ref: '100' }) }) };
  service.notifications = { enqueue: jest.fn(async () => {}) }; await service.addComments('t1', [{ id: 1 }, { id: 2, employee: 'Fares', text: 'Called customer' }], 'u1'); expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('comment', 'comment:tx:t1:2', '100', 'tx:t1', undefined, undefined, { actorUserId: 'u1', actorName: 'Fares', commentId: 2, commentText: 'Called customer' });
});
it('follow-up retries with the same actor/request ID do not add a comment or alert', async () => {
  const service: any = Object.create(FollowUpsService.prototype); const before = { comments: [{ requestKey: 'u1:nonce' }] };
  service.model = { findById: () => ({ lean: async () => before }), findOneAndUpdate: jest.fn() }; service.notifications = { enqueue: jest.fn() };
  expect(await service.addComment('f1', 'u1', 'Test', 'fixture', 'nonce')).toBe(before); expect(service.model.findOneAndUpdate).not.toHaveBeenCalled(); expect(service.notifications.enqueue).not.toHaveBeenCalled();
});
it('notifies a new follow-up only after the ticket was saved', async () => {
  const service: any = Object.create(FollowUpsService.prototype);
  service.generateTicketNo = jest.fn(async () => 'FU-2771-N001');
  service.model = { create: jest.fn(async () => ({ _id: 'f1', orderRef: '2771' })) };
  service.notifications = { enqueue: jest.fn(async () => {}) };
  await service.create({ orderRef: '2771' }, 'u1');
  expect(service.notifications.enqueue).toHaveBeenCalledWith('followup', 'followup:f1', '2771', 'followup:f1', undefined, undefined, { actorUserId: 'u1' });
  service.notifications.enqueue.mockClear(); service.model.create.mockRejectedValueOnce(new Error('save failed'));
  await expect(service.create({ orderRef: '2771' })).rejects.toThrow('save failed'); expect(service.notifications.enqueue).not.toHaveBeenCalled();
});
it('passes the authenticated actor for transaction, Shopify and new follow-up requests', async () => {
  const req = { user: { userId: 'authenticated-user' } };
  const comments = [{ id: 2, employee: 'Another name', text: 'Comment', actorUserId: 'spoofed-user' }];
  const tx: any = Object.create(TransactionsController.prototype);
  tx.transactionsService = { addComments: jest.fn() };
  await tx.addComments('t1', { comments }, req);
  expect(tx.transactionsService.addComments).toHaveBeenCalledWith('t1', comments, 'authenticated-user');
  const shopify: any = Object.create(ShopifyController.prototype);
  shopify.shopifyService = { updateOrderComments: jest.fn() };
  await shopify.addComment('o1', comments, req);
  expect(shopify.shopifyService.updateOrderComments).toHaveBeenCalledWith('o1', comments, 'authenticated-user');
  const fu: any = Object.create(FollowUpsController.prototype);
  fu.service = { create: jest.fn(async () => ({ _id: 'f1' })) }; fu.presence = { emitEvent: jest.fn() };
  await fu.create({ orderRef: '100' }, req);
  expect(fu.service.create).toHaveBeenCalledWith({ orderRef: '100' }, 'authenticated-user');
});
it('excludes the author from follow-up participant alerts and passes their ID to push', async () => {
  const service: any = Object.create(FollowUpsService.prototype);
  const before = { orderRef: '100', responsibleId: 'u1', comments: [{ _id: 'old', authorId: 'u2' }] };
  service.model = { findById: () => ({ lean: async () => before }), findOneAndUpdate: () => ({ lean: async () => ({ ...before, comments: [...before.comments, { _id: 'new', authorId: 'u1' }] }) }) };
  service.notifications = { enqueue: jest.fn() }; service.mentionsService = { create: jest.fn(async () => ({ _id: 'm1' })) }; service.presence = { emitToUser: jest.fn() };
  await service.addComment('f1', 'u1', 'Fares', 'Called customer');
  expect(service.notifications.enqueue).toHaveBeenCalledWith('comment', 'comment:followup:f1:new', '100', 'followup:f1', undefined, undefined, { actorUserId: 'u1', actorName: 'Fares', commentId: 'new', commentText: 'Called customer' });
  expect(service.mentionsService.create).toHaveBeenCalledTimes(1);
  expect(service.mentionsService.create).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: 'u2' }));
});
it('does not send a follow-up reason-change alert to the person making the change', async () => {
  const controller: any = Object.create(FollowUpsController.prototype);
  controller.service = { update: jest.fn(async () => ({ _id: 'f1', responsibleId: 'u1', orderRef: '100' })) };
  controller.presence = { emitToUser: jest.fn(), emitEvent: jest.fn() };
  await controller.update('f1', { reason: 'Changed' }, { user: { userId: 'u1' } });
  expect(controller.presence.emitToUser).not.toHaveBeenCalled();
  await controller.update('f1', { reason: 'Changed again' }, { user: { userId: 'u2' } });
  expect(controller.presence.emitToUser).toHaveBeenCalledWith('u1', 'followup:notify', expect.any(Object));
});
it.each([undefined, 444])('uses a saved transaction comment ID for mention routing and retry suppression (%p)', async savedCommentId => {
  const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
  const start = html.indexOf('async function processMentionsInComment(');
  const end = html.indexOf('/** Build mention notifications list', start);
  const requests: any[] = [];
  const context: any = {
    transactions: [{ _id: 'tx1', comments: [{ id: 123, text: '@fixture' }] }],
    extractMentions: () => [{ _id: 'target', name: 'Fixture', username: 'fixture' }],
    api: async (_url: string, options: any) => requests.push(JSON.parse(options.body)),
    refreshMentionsFromServer: async () => {}, buildNotifications: () => {}, _warnMentionFailed: jest.fn(),
  };
  runInNewContext(html.slice(start, end) + '\nthis.send = processMentionsInComment;', context);
  await context.send('@fixture', 'tx1', '2638', savedCommentId);
  expect(requests[0].mentions[0].commentId).toBe(savedCommentId || 123);
  expect(context._warnMentionFailed).not.toHaveBeenCalled();
});
