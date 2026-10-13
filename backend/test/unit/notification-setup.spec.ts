import { NotificationsService } from '../../src/notifications/notifications.service';
const webPush = require('web-push');

function database() {
  let saved: any;
  const config = { findOne: jest.fn(async () => saved), updateOne: jest.fn(async (_query, update) => { saved ||= { ...update.$setOnInsert }; }) };
  const accounts = { createIndex: jest.fn(), findOne: jest.fn(async () => null) };
  const jobs = { createIndex: jest.fn() };
  const connection: any = { collection: (name: string) => ({ notificationaccounts: accounts, notificationjobs: jobs, notificationconfig: config } as any)[name] };
  return { connection, config, saved: () => saved };
}
const user = { userId: '507f1f77bcf86cd799439011', role: 'admin' };
describe('Live push server configuration', () => {
  const names = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
  let original: Array<string | undefined>;
  beforeEach(() => { original = names.map(name => process.env[name]); names.forEach(name => delete process.env[name]); });
  afterEach(() => names.forEach((name, index) => { if (original[index] === undefined) delete process.env[name]; else process.env[name] = original[index]; }));
  it('automatically configures a live container with no local env file and exposes only the public key', async () => {
    const db = database(), service = new NotificationsService(db.connection);
    await service.onModuleInit(); const state = await service.settings(user);
    expect(state.configured).toBe(true); expect(state.configurationIssue).toBeNull();
    expect(state.publicKey).toBe(db.saved().publicKey); expect(state.publicKey).toMatch(/^[\w-]{87}$/);
    expect(JSON.stringify(state)).not.toContain(db.saved().privateKey);
  });
  it('keeps the same persisted pair after a deployment restart', async () => {
    const db = database(), first = new NotificationsService(db.connection), second = new NotificationsService(db.connection);
    await first.onModuleInit(); const before = await first.settings(user);
    await second.onModuleInit(); expect((await second.settings(user)).publicKey).toBe(before.publicKey);
    expect(db.config.updateOne).toHaveBeenCalledTimes(1);
  });
  it('concurrent startup instances converge on one pair', async () => {
    const db = database(), first = new NotificationsService(db.connection), second = new NotificationsService(db.connection);
    await Promise.all([first.onModuleInit(), second.onModuleInit()]);
    expect((await first.settings(user)).publicKey).toBe((await second.settings(user)).publicKey);
  });
  it('preserves an existing explicit key pair even if its subject was omitted', async () => {
    const pair = webPush.generateVAPIDKeys(); process.env.VAPID_PUBLIC_KEY = pair.publicKey; process.env.VAPID_PRIVATE_KEY = pair.privateKey;
    const db = database(), service = new NotificationsService(db.connection);
    await service.onModuleInit(); expect(service.configured).toBe(true); expect((await service.settings(user)).publicKey).toBe(pair.publicKey);
    expect(db.config.findOne).not.toHaveBeenCalled();
  });
  it('does not replace a partially configured pair or silently rotate registered devices', async () => {
    process.env.VAPID_PUBLIC_KEY = webPush.generateVAPIDKeys().publicKey;
    const db = database(), service = new NotificationsService(db.connection);
    await service.onModuleInit(); expect((await service.settings(user)).configurationIssue).toBe('incomplete_keys');
    expect(service.configured).toBe(false); expect(db.config.updateOne).not.toHaveBeenCalled();
  });
  it('reports invalid configuration without crashing the entire application', async () => {
    process.env.VAPID_PUBLIC_KEY = 'invalid'; process.env.VAPID_PRIVATE_KEY = 'invalid';
    const service = new NotificationsService(database().connection);
    await expect(service.onModuleInit()).resolves.toBeUndefined(); expect(service.configured).toBe(false);
    expect((await service.settings(user)).configurationIssue).toBe('setup_failed');
  });
});
