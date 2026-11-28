import mongoose, { Connection, Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../src/auth/auth.service';
import { SignInVerificationService } from '../../src/auth/sign-in-verification.service';
import { TokenIssuerService } from '../../src/auth/token-issuer.service';
import { LoginGuardService } from '../../src/auth/login-guard.service';
import { TrustedDevicesService } from '../../src/auth/trusted-devices.service';
import { UsersService } from '../../src/users/users.service';
import { UserSchema, UserDocument } from '../../src/users/schemas/user.schema';
import { UserSessionsService } from '../../src/auth/user-sessions.service';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import { legacyTokenAllowed, sessionStatus } from '../../src/auth/user-sessions.util';

jest.mock('../../src/shared/geo-lookup.util', () => ({ fetchGeo: jest.fn(async () => ({ city: 'القاهرة', region: '', country: 'مصر' })) }));

// «الجلسات والأجهزة» (Nov 27, 2026): every sign-in is a session the server can end.
describe('sign-in sessions — recorded, listed and ended from the server', () => {
  const dbName = `soulia_test_user_sessions_${Date.now()}`;
  let connection: Connection;
  let model: Model<UserDocument>;
  let users: UsersService;
  let sessions: UserSessionsService;
  let jwt: JwtService;
  let auth: AuthService;
  let strategy: JwtStrategy;

  const chrome = { ipAddress: '41.1.1.1', userAgent: 'x', device: 'كمبيوتر', browser: 'Chrome', os: 'Windows' };
  const iphone = { ipAddress: '41.2.2.2', userAgent: 'y', device: 'موبايل', browser: 'Safari', os: 'iOS' };
  const login = (username: string, client = chrome) => auth.login({ username, password: 'right-pass' } as any, client.ipAddress, client as any);
  const sidOf = (token: string) => (jwt.decode(token) as any).sid as string;
  const validate = (token: string) => strategy.validate(jwt.verify(token));
  // Staff with 2FA off finish on the password; the second step has its own suite.
  const makeAuth = (sess: any) => {
    const totp = { getGlobal2faStatus: async () => false, backupCodesLeft: () => 0 } as any;
    const audit = { log: async () => undefined } as any;
    const mentions = { createMany: async () => undefined } as any;
    const guard = new LoginGuardService(connection);
    (guard as any).overIpRate = () => false;
    const verification = new SignInVerificationService(users, totp, {} as any, {} as any, { configured: () => false } as any, new TokenIssuerService(jwt, sess), audit, mentions, {} as any, {} as any, guard);
    return new AuthService(users, mentions, audit, verification, guard, new TrustedDevicesService(connection));
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; return null; } catch (e: any) { return e.getResponse?.() ?? e; }
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-user-sessions-0123456789';
    connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    model = connection.model<UserDocument>('User', UserSchema as any) as any;
    users = new UsersService(model);
    sessions = new UserSessionsService(connection);
    await sessions.onModuleInit();
    jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '24h' } });
    auth = makeAuth(sessions);
    strategy = new JwtStrategy(users, sessions);
  });

  beforeEach(async () => {
    await model.deleteMany({});
    await connection.collection('usersessions').deleteMany({});
    // role staff: an admin always passes a second step on a new device (sign-in-verification spec).
    await users.createUser({ username: 'admin', password: 'right-pass', name: 'Admin', role: 'staff' });
    await users.createUser({ username: 'sara', password: 'right-pass', name: 'Sara', role: 'staff' });
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('records each sign-in with its device and puts the session id in the token', async () => {
    const { accessToken } = await login('sara');
    const sid = sidOf(accessToken!);
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    const row: any = await connection.collection('usersessions').findOne({ _id: sid as any });
    expect(row).toMatchObject({ username: 'sara', method: 'password', browser: 'Chrome', os: 'Windows', ip: '41.1.1.1', endedAt: null, newDevice: false });
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(await validate(accessToken!)).toMatchObject({ username: 'sara', sid });
  });

  it('flags a device the account never used before, not the first sign-in or a known device', async () => {
    await login('sara');
    const again = await login('sara');
    const phone = await login('sara', iphone);
    const flag = async (t: string) => ((await connection.collection('usersessions').findOne({ _id: sidOf(t) as any })) as any).newDevice;
    expect(await flag(again.accessToken!)).toBe(false);
    expect(await flag(phone.accessToken!)).toBe(true);
  });

  it('an ended session signs that device out at once, with who ended it', async () => {
    const a = await login('sara');
    const b = await login('sara', iphone);
    await validate(a.accessToken!); // cached as valid
    await sessions.end(sidOf(a.accessToken!), 'revoked', { id: 'x', name: 'Admin' });
    const refused: any = await refusal(validate(a.accessToken!));
    expect(refused).toMatchObject({ code: 'SESSION_ENDED' });
    expect(refused.message).toContain('Admin');
    expect(await validate(b.accessToken!)).toMatchObject({ username: 'sara' });
  });

  it('logout ends only this session and is reported as a sign-out', async () => {
    const a = await login('sara');
    await sessions.end(sidOf(a.accessToken!), 'logout', null);
    const row: any = await sessions.findOne(sidOf(a.accessToken!));
    expect(sessionStatus(row)).toBe('logged-out');
    expect((await refusal(validate(a.accessToken!)) as any).code).toBe('SESSION_ENDED');
    // ending twice changes nothing
    expect((await sessions.end(sidOf(a.accessToken!), 'revoked', null)).changed).toBe(false);
  });

  it('«خروج من كل الأجهزة» keeps the caller\'s own session and refuses old tokens without a session id', async () => {
    const own = await login('admin');
    const other = await login('admin', iphone);
    const sara = await login('sara');
    const user = await users.findByUsername('admin');
    const legacy = jwt.sign({ sub: String(user!._id), username: 'admin', iat: Math.floor(Date.now() / 1000) - 60 });
    expect(await validate(legacy)).toMatchObject({ username: 'admin' });

    const { ended } = await sessions.endAllForUser(String(user!._id), { id: 'a', name: 'Admin' }, { exceptSid: sidOf(own.accessToken!) });
    expect(ended).toEqual([sidOf(other.accessToken!)]);
    expect(await validate(own.accessToken!)).toMatchObject({ username: 'admin' });
    expect((await refusal(validate(other.accessToken!)) as any).code).toBe('SESSION_ENDED');
    expect((await refusal(validate(legacy)) as any).code).toBe('SESSION_ENDED');
    expect(await validate(sara.accessToken!)).toMatchObject({ username: 'sara' }); // other accounts untouched
  });

  it('a token whose session row is missing is refused (never treated as an old token)', async () => {
    const a = await login('sara');
    await connection.collection('usersessions').deleteMany({});
    const fresh = new JwtStrategy(users, new UserSessionsService(connection));
    expect((await refusal(fresh.validate(jwt.verify(a.accessToken!))) as any).code).toBe('SESSION_ENDED');
  });

  it('if the session cannot be written, the sign-in still works with an old-style token', async () => {
    const broken = { newSessionId: () => 'f'.repeat(32), create: async () => { throw new Error('db down'); } } as any;
    const authNoDb = makeAuth(broken);
    const { accessToken } = await authNoDb.login({ username: 'sara', password: 'right-pass' } as any, '1.1.1.1', chrome as any);
    expect((jwt.decode(accessToken!) as any).sid).toBeUndefined();
    expect(await validate(accessToken!)).toMatchObject({ username: 'sara', sid: '' });
  });

  it('overview counts open sessions and devices per account; history filters by state', async () => {
    const a = await login('sara');
    await login('sara', iphone);
    const adminLogin = await login('admin');
    await sessions.end(sidOf(adminLogin.accessToken!), 'logout', null);
    const ov = await sessions.overview(new Set([sidOf(a.accessToken!)]), new Set());
    const sara = ov.accounts.find((x: any) => x.username === 'sara')!;
    expect(sara).toMatchObject({ activeCount: 2, onlineCount: 1, deviceCount: 2, loginCount: 2, knownDevices: 2 });
    expect(sara.lastLogin!.browser).toBe('Safari');
    expect(ov.accounts.find((x: any) => x.username === 'admin')).toMatchObject({ activeCount: 0, loginCount: 1 });
    expect(ov.totals).toMatchObject({ activeSessions: 2, signedInUsers: 1, onlineSessions: 1, newDevices24h: 1 });
    expect((await sessions.history({ status: 'logged-out' }, new Set())).rows.map((r: any) => r.username)).toEqual(['admin']);
    expect((await sessions.history({ status: 'active' }, new Set())).total).toBe(2);
  });

  it('old tokens stay valid until the account is signed out everywhere', () => {
    const now = Date.now();
    expect(legacyTokenAllowed(Math.floor(now / 1000), null)).toBe(true);
    expect(legacyTokenAllowed(Math.floor(now / 1000) - 10, new Date(now))).toBe(false);
    expect(legacyTokenAllowed(Math.floor(now / 1000) + 1, new Date(now))).toBe(true);
  });
});
