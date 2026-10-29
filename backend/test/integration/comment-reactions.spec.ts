import mongoose, { Connection, Types } from 'mongoose';
import { setCommentReaction } from '../../src/shared/comment-reactions';
import { FollowUpSchema } from '../../src/followups/schemas/followup.schema';
import { ShopifyOrderSchema } from '../../src/shopify/schemas/shopify-order.schema';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import { FollowUpsController } from '../../src/followups/followups.controller';
import { FollowUpsService } from '../../src/followups/followups.service';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { TransactionsController } from '../../src/transactions/transactions.controller';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { PresenceGateway } from '../../src/auth/presence.gateway';
import { NotificationsService } from '../../src/notifications/notifications.service';

describe('Persistent comment reactions', () => {
  let connection: Connection;
  let app: INestApplication;
  let baseUrl: string;
  const presence = { emitEvent: jest.fn(), emitToUser: jest.fn() };
  const reactionServices = new Map<string, any>();
  const jwt = new JwtService({ secret: 'comment-reaction-test-only-secret' });
  const dbName = `soulia_test_reactions_${process.pid}_${Date.now()}`;
  beforeAll(async () => {
    connection = await mongoose.createConnection(`mongodb://127.0.0.1:27017/${dbName}`, {
      serverSelectionTimeoutMS: 3000, autoIndex: false,
    }).asPromise();
    const controllers = [FollowUpsController, ShopifyController, TransactionsController];
    const providers = new Map<any, any>();
    // Only unrelated service dependencies are stubs. Controllers, reaction services,
    // JWT authentication, role/permission guards, and MongoDB use production code.
    controllers.forEach(controller => {
      (Reflect.getMetadata('design:paramtypes', controller) || []).forEach((token: any) => providers.set(token, {}));
    });
    for (const [serviceClass, modelKey, name, schema] of [
      [FollowUpsService, 'model', 'FollowUp', FollowUpSchema],
      [ShopifyService, 'shopifyOrderModel', 'ShopifyOrder', ShopifyOrderSchema],
      [TransactionsService, 'transactionModel', 'Transaction', TransactionSchema],
    ] as const) {
      const service = Object.create(serviceClass.prototype);
      service[modelKey] = connection.model(name, schema as any);
      service.presence = presence;
      service.notifications = new NotificationsService(connection);
      (service.notifications as any).push = {};
      reactionServices.set(name, service);
      providers.set(serviceClass, service);
    }
    providers.set(PresenceGateway, presence);
    const previousSecret = process.env.JWT_SECRET;
    let strategy: JwtStrategy;
    try {
      process.env.JWT_SECRET = 'comment-reaction-test-only-secret';
      strategy = new JwtStrategy({ findById: async (id: string) => ['staff-a', 'staff-b', 'disabled'].includes(id)
        ? { name: id, role: 'staff', perms: [], isActive: id !== 'disabled' } : null } as any);
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
    const module = await Test.createTestingModule({ controllers, providers: [
      ...Array.from(providers, ([provide, useValue]) => ({ provide, useValue })),
      { provide: JwtStrategy, useValue: strategy },
    ] }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    if (!connection) return;
    if (connection.name !== dbName || !/^soulia_test_reactions_\d+_\d+$/.test(connection.name)) throw new Error('Unexpected test database');
    await connection.dropDatabase();
    await connection.close();
  });

  it.each([
    ['FollowUp', FollowUpSchema, true], ['ShopifyOrder', ShopifyOrderSchema, false], ['Transaction', TransactionSchema, false],
  ] as const)('%s: persists, switches, removes and preserves concurrent reactions without altering activity', async (name, schema, embedded) => {
    const model = connection.model(name, schema as any);
    const _id = new Types.ObjectId(), cid = embedded ? new Types.ObjectId() : 123;
    const createdAt = new Date('2026-01-01T00:00:00Z');
    await model.collection.insertOne({ _id, comments: [{ [embedded ? '_id' : 'id']: cid, text: 'Well done', createdAt }], updatedAt: createdAt });
    const react = (user: string, reaction: unknown, comment = String(cid)) => setCommentReaction(model, String(_id), comment, embedded, user, '$literal name <test>', reaction);
    const first = await react('a', 'applause');
    expect(first.reactions).toEqual([{ commentId: String(cid), userId: 'a', userName: '$literal name <test>', reaction: 'applause' }]);
    await react('a', 'applause'); // Retrying does not toggle or duplicate.
    expect((await model.findById(_id).lean() as any).commentReactions).toHaveLength(1);
    await Promise.all(Array.from({ length: 12 }, (_, i) => react('user-' + i, 'strong')));
    const switched = await react('a', 'love');
    expect(switched.reactions).toHaveLength(13);
    expect(switched.reactions.find(r => r.userId === 'a')?.reaction).toBe('love');
    const removed = await react('a', null);
    expect(removed.reactions).toHaveLength(12);
    expect(removed.reactions.some(r => r.userId === 'a')).toBe(false);
    await react('a', null);
    const stored: any = await model.findById(_id).lean();
    expect(stored.updatedAt).toEqual(createdAt);
    expect(stored.comments[0].createdAt).toEqual(createdAt);
    // Legacy clients still replace the full comment list when adding/editing notes.
    await model.findByIdAndUpdate(_id, { comments: [{ ...stored.comments[0], text: 'Edited' }] });
    expect((await model.findById(_id).lean() as any).commentReactions).toHaveLength(12);
    await expect(react('a', 'sad')).rejects.toThrow('Invalid reaction');
    await expect(react('a', undefined)).rejects.toThrow('Invalid reaction');
    await expect(react('', 'like')).rejects.toThrow('Authentication required');
    await expect(react('a', 'like', 'bad-id')).rejects.toThrow('Invalid comment ID');
    await expect(react('a', 'like', embedded ? String(new Types.ObjectId()) : '999')).rejects.toThrow('Comment not found');
    // Deleted comments cannot receive reactions or be recreated by a stale request.
    await model.collection.updateOne({ _id }, { $set: { comments: [] } });
    await expect(react('a', 'like')).rejects.toThrow('Comment not found');
  });

  it.each([
    ['FollowUp', '/followups', true], ['ShopifyOrder', '/shopify/orders', false], ['Transaction', '/transactions', false],
  ] as const)('%s: ordinary staff can react through HTTP and increase the count', async (name, prefix, embedded) => {
    const model = connection.model(name), _id = new Types.ObjectId();
    const cid = embedded ? new Types.ObjectId() : 456;
    await model.collection.insertOne({ _id, comments: [{ [embedded ? '_id' : 'id']: cid, authorId: 'someone-else', text: 'Done' }] });
    const url = `${baseUrl}${prefix}/${_id}/comments/${cid}/reaction`;
    const request = (user: string, reaction: string | null) => fetch(url, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(user ? {
        Authorization: `Bearer ${jwt.sign({ sub: user, username: user }, { expiresIn: '5m' })}`,
      } : {}) }, body: JSON.stringify({ reaction, userId: 'forged-user', userName: 'forged-name' }),
    });
    expect((await request('', 'applause')).status).toBe(401);
    expect((await request('disabled', 'applause')).status).toBe(401);
    const first = await request('staff-a', 'applause');
    expect(first.status).toBe(200);
    expect((await first.json()).reactions).toEqual([{ commentId: String(cid), userId: 'staff-a', userName: 'staff-a', reaction: 'applause' }]);
    const second = await request('staff-b', 'applause');
    expect(second.status).toBe(200);
    expect((await second.json()).reactions.filter((r: any) => r.reaction === 'applause')).toHaveLength(2);
    expect((await (await request('staff-b', 'applause')).json()).reactions).toHaveLength(2);
    const changed = (await (await request('staff-a', 'strong')).json()).reactions;
    expect(changed.filter((r: any) => r.reaction === 'applause')).toHaveLength(1);
    expect(changed.filter((r: any) => r.reaction === 'strong')).toHaveLength(1);
    const removed = await (await request('staff-a', null)).json();
    expect(removed.reactions).toEqual([{ commentId: String(cid), userId: 'staff-b', userName: 'staff-b', reaction: 'applause' }]);
    expect(presence.emitEvent).toHaveBeenLastCalledWith('comment:reaction', expect.objectContaining({ id: String(_id), ...removed }));
    expect((await model.findById(_id).lean() as any).commentReactions).toEqual(removed.reactions);
  });

  it.each([
    ['FollowUp', 'followup', true], ['ShopifyOrder', 'shopify', false], ['Transaction', 'tx', false],
  ] as const)('%s: notifies only the author for every new reaction, including push and comment navigation', async (name, recordKind, embedded) => {
    const model = connection.model(name), _id = new Types.ObjectId(), author = new Types.ObjectId(), actor = new Types.ObjectId();
    const cid = embedded ? new Types.ObjectId() : 789;
    const authorName = name + ' comment author';
    await connection.collection('users').insertMany([
      { _id: author, name: authorName, username: name + '-author', role: 'staff', isActive: true },
      { _id: actor, name: name + ' colleague', role: 'staff', isActive: true },
      { _id: new Types.ObjectId(), name: 'Unrelated administrator', role: 'admin', isActive: true },
    ]);
    await connection.collection('notificationaccounts').insertOne({ userId: String(author), preferences: { enabled: true, comment: true },
      subscriptions: [{ endpoint: 'https://web.push.apple.com/' + name, keys: {} }] });
    await model.collection.insertOne({ _id, ref: '2966', orderRef: '2966', comments: [{ [embedded ? '_id' : 'id']: cid,
      ...(embedded ? { authorId: String(author) } : { employee: authorName }), text: 'Customer confirmed the order' }] });
    const service = reactionServices.get(name);
    const react = (reaction: string | null, userId = String(actor)) => service.reactToComment(String(_id), String(cid), userId, name + ' colleague', reaction);
    const inbox = connection.collection('notificationinbox'), jobs = connection.collection('notificationjobs');
    const filter = { recordId: `${recordKind}:${_id}` };
    for (const [index, reaction] of ['like', 'applause', 'strong', 'love', 'fire', 'star', 'angry'].entries()) {
      await Promise.all([react(reaction), react(reaction), react(reaction)]);
      const entries = await inbox.find(filter).toArray();
      expect(entries).toHaveLength(index + 1);
      expect(entries.every(row => row.userId === String(author))).toBe(true);
      const row = entries.find(row => row.reaction === reaction)!;
      expect(row.event).toBe(String(cid));
      expect(row.body).toContain(name + ' colleague');
      expect(row.body).toContain('Customer confirmed the order');
      expect(row.title).toMatch(/تفاعل جديد|New reaction/);
      const url = new URL(row.url, 'https://example.test');
      expect(url.searchParams.get('pushRecord')).toBe(`${recordKind}:${_id}`);
      expect(url.searchParams.get('pushEvent')).toBe(String(cid));
      expect(url.searchParams.get('pushType')).toBe('comment');
      expect(await jobs.countDocuments({ userId: String(author) })).toBe(index + 1);
      expect(presence.emitToUser).toHaveBeenLastCalledWith(String(author), 'notification:new', { source: 'reaction' });
    }
    await react(null);
    await react('like', String(author)); // Self-reactions and removals do not notify.
    expect(await inbox.countDocuments(filter)).toBe(7);
    await react('star'); // A newly added reaction after removal gets its own notification.
    expect(await inbox.countDocuments(filter)).toBe(8);
    // Ambiguous legacy display names must not notify the wrong employee.
    if (!embedded) {
      await connection.collection('users').insertOne({ _id: new Types.ObjectId(), name: authorName, role: 'staff', isActive: true });
      await react('fire');
      expect(await inbox.countDocuments(filter)).toBe(8);
    }
  });
});
