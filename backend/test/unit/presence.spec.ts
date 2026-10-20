import { PresenceGateway } from '../../src/auth/presence.gateway';
import { AuthController } from '../../src/auth/auth.controller';

jest.mock('../../src/shared/geo-lookup.util', () => ({ fetchGeo: jest.fn(async () => null) }));

function fixture() {
  const user = { _id: 'alice', name: 'Alice', username: 'alice', role: 'staff', isActive: true };
  const users = { findById: jest.fn(async () => user), findAll: jest.fn(async () => [user]), updateLastSeen: jest.fn(async () => {}) };
  const gateway = new PresenceGateway({ verify: () => ({ sub: 'alice' }) } as any, users as any);
  gateway.server = { emit: jest.fn() } as any;
  const client = (id: string) => ({ id, connected: true, handshake: { auth: { token: 'test' }, headers: {}, address: '127.0.0.1' }, on: jest.fn(), emit: jest.fn(), disconnect: jest.fn() } as any);
  return { gateway, users, user, client };
}

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
