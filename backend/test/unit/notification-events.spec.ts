import { BostaService } from '../../src/bosta/bosta.service';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { FollowUpsService } from '../../src/followups/followups.service';
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
  service.mapItems = async () => []; service.pickOrderDiscountApplication = () => undefined;
  service.applyDerivedDeposit = jest.fn();
  service.employeeShiftService = { resolveAssignee: async () => ({ userId: employeeId, username: 'ahmed', name: 'Ahmed', reason: 'shift' }) };
  service.employeeScoringService = { scoreDepositDetection: async () => {} };
  service.notifyOrderAssigned = jest.fn(async () => {});
  service.notifications = { enqueue: jest.fn(async () => {}) };
  expect((await service.handleOrder({ id: 1, name: '#2771' })).saved).toBe(true);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('order', 'order:shopify:1', '2771', 'shopify:' + order._id, undefined, undefined, { orderTotal: 2450, assignedUserId: employeeId });
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
  await service.updateOrderComments('o1', [{ id: 1 }, { id: 2, employee: 'Fares', text: 'Called customer' }]); await service.updateOrderComments('o1', [{ id: 1 }, { id: 2 }]); expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('comment', 'comment:shopify:o1:2', '100', 'shopify:o1', undefined, undefined, { actorName: 'Fares', commentId: 2, commentText: 'Called customer' });
  order.save.mockRejectedValueOnce(new Error('failed') as never); await expect(service.updateOrderComments('o1', [{ id: 3 }])).rejects.toThrow('failed'); expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
});
it('transaction comments notify after persistence and ignore unchanged IDs', async () => {
  const service: any = Object.create(TransactionsService.prototype);
  service.transactionModel = { findById: () => ({ lean: async () => ({ comments: [{ id: 1 }] }) }), findByIdAndUpdate: () => ({ exec: async () => ({ ref: '100' }) }) };
  service.notifications = { enqueue: jest.fn(async () => {}) }; await service.addComments('t1', [{ id: 1 }, { id: 2, employee: 'Fares', text: 'Called customer' }]); expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
  expect(service.notifications.enqueue).toHaveBeenCalledWith('comment', 'comment:tx:t1:2', '100', 'tx:t1', undefined, undefined, { actorName: 'Fares', commentId: 2, commentText: 'Called customer' });
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
  await service.create({ orderRef: '2771' });
  expect(service.notifications.enqueue).toHaveBeenCalledWith('followup', 'followup:f1', '2771', 'followup:f1');
  service.notifications.enqueue.mockClear(); service.model.create.mockRejectedValueOnce(new Error('save failed'));
  await expect(service.create({ orderRef: '2771' })).rejects.toThrow('save failed'); expect(service.notifications.enqueue).not.toHaveBeenCalled();
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
