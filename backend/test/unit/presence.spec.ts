import { PresenceGateway } from '../../src/auth/presence.gateway';
import { AuthController } from '../../src/auth/auth.controller';

jest.mock('../../src/shared/geo-lookup.util', () => ({ fetchGeo: jest.fn(async () => null) }));

function fixture(store: { config: any } = { config: null }) {
  const user = { _id: 'alice', name: 'Alice', username: 'alice', role: 'staff', isActive: true };
  const users = { findById: jest.fn(async () => user), findAll: jest.fn(async () => [user]), updateLastSeen: jest.fn(async () => {}) };
  const collection = {
    findOne: jest.fn(async () => store.config ? { config: store.config } : null),
    updateOne: jest.fn(async (_filter, update) => { store.config = update.$set.config; }),
  };
  const gateway = new PresenceGateway({ verify: () => ({ sub: 'alice' }) } as any, users as any, { collection: () => collection } as any);
  gateway.server = { emit: jest.fn() } as any;
  const client = (id: string) => ({ id, connected: true, handshake: { auth: { token: 'test' }, headers: {}, address: '127.0.0.1' }, on: jest.fn(), emit: jest.fn(), disconnect: jest.fn() } as any);
  return { gateway, users, user, client, collection, store };
}

it('returns disabled state instead of leaving stale employee banners visible', async () => {
  const { gateway, client } = fixture();
  const employee = client('employee');
  await gateway.handleConnection(employee);
  expect(employee.emit).toHaveBeenCalledWith('banner:changed', { enabled: false });
});

it('persists administrator visibility changes and restores them after a gateway restart', async () => {
  const { gateway, user, client, collection, store } = fixture();
  user.role = 'admin';
  const admin = client('admin');
  await gateway.handleConnection(admin);
  const publish = admin.on.mock.calls.find(([event]: any[]) => event === 'banner:publish')[1];
  const send = (cfg: any) => new Promise(resolve => publish(cfg, resolve));
  expect(await send({ enabled: true, messages: ['Hello'] })).toEqual({ ok: true });
  expect(await send({ enabled: false, messages: ['Hello'] })).toEqual({ ok: true });
  expect(collection.updateOne).toHaveBeenCalledTimes(2);
  expect(gateway.server.emit).toHaveBeenCalledWith('banner:changed', { enabled: false, messages: ['Hello'] });
  const restarted = fixture(store), employee = restarted.client('reconnected');
  await restarted.gateway.handleConnection(employee);
  expect(employee.emit).toHaveBeenCalledWith('banner:changed', store.config);
});

it('rejects employee publishing and reports failed saves without broadcasting them', async () => {
  const { gateway, client, collection } = fixture();
  const employee = client('employee');
  await gateway.handleConnection(employee);
  const publish = employee.on.mock.calls.find(([event]: any[]) => event === 'banner:publish')[1], ack = jest.fn();
  publish({ enabled: true }, ack);
  expect(ack).toHaveBeenCalledWith({ ok: false });
  expect(collection.updateOne).not.toHaveBeenCalled();
  const adminFixture = fixture(); adminFixture.user.role = 'admin';
  const admin = adminFixture.client('admin'); await adminFixture.gateway.handleConnection(admin);
  adminFixture.collection.updateOne.mockRejectedValueOnce(new Error('database unavailable'));
  const adminPublish = admin.on.mock.calls.find(([event]: any[]) => event === 'banner:publish')[1];
  const result = await new Promise(resolve => adminPublish({ enabled: false }, resolve));
  expect(result).toEqual({ ok: false });
  expect(adminFixture.gateway.server.emit).not.toHaveBeenCalledWith('banner:changed', expect.anything());
});

it('keeps a user online until their final tab disconnects and records last seen', async () => {
  const { gateway, users, client } = fixture();
  const first = client('one'), second = client('two');
  await gateway.handleConnection(first);
  await gateway.handleConnection(second);
  expect(gateway.getOnlineUserIds()).toEqual(['alice']);
  await gateway.handleDisconnect(first);
  expect(gateway.getOnlineUserIds()).toEqual(['alice']);
  expect(users.updateLastSeen).not.toHaveBeenCalled();
  await gateway.handleDisconnect(second);
  expect(gateway.getOnlineUserIds()).toEqual([]);
  expect(users.updateLastSeen).toHaveBeenCalledWith('alice');
});

it('does not register inactive users or sockets disconnected during authentication', async () => {
  const { gateway, user, client } = fixture();
  user.isActive = false;
  await gateway.handleConnection(client('disabled'));
  user.isActive = true;
  const gone = client('gone'); gone.connected = false;
  await gateway.handleConnection(gone);
  expect(gateway.getOnlineUserIds()).toEqual([]);
});

it('reads socket state after awaiting users in both broadcast and HTTP snapshots', async () => {
  const { gateway, users, user, client } = fixture();
  const tab = client('one');
  await gateway.handleConnection(tab);
  let finish!: (users: any) => void;
  users.findAll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const broadcast = (gateway as any).broadcastOnlineUsers();
  await gateway.handleDisconnect(tab);
  finish([user]);
  await broadcast;
  expect((gateway.server.emit as jest.Mock).mock.calls.at(-1)[1].users[0].isOnline).toBe(false);

  await gateway.handleConnection(tab);
  const controller = new AuthController({} as any, gateway, users as any, {} as any);
  users.findAll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const response = controller.getUsersStatus();
  await gateway.handleDisconnect(tab);
  finish([user]);
  expect((await response).users[0].isOnline).toBe(false);
});

it('updates last seen using the authenticated JWT strategy userId', async () => {
  const { gateway, users } = fixture();
  const controller = new AuthController({} as any, gateway, users as any, {} as any);
  expect(await controller.updateLastSeen({ user: { userId: 'alice' } } as any)).toEqual({ success: true });
  expect(users.updateLastSeen).toHaveBeenCalledWith('alice');
});
