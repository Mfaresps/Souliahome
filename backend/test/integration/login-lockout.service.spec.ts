import mongoose, { Connection, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../src/auth/auth.service';
import { UsersService } from '../../src/users/users.service';
import { UserSchema, UserDocument } from '../../src/users/schemas/user.schema';
import { lockMinutesFor, minutesLeft, nextLockLevel } from '../../src/auth/login-lockout.util';

// Wrong passwords pause NEW sign-ins for a while; they never disable the account. Before this,
// 4 wrong passwords on «admin» disabled the admin (and kicked out its open sessions) until
// another admin re-enabled it.
describe('login lockout — temporary pause, never a disabled account', () => {
  const dbName = `soulia_test_login_lockout_${Date.now()}`;
  let connection: Connection;
  let model: Model<UserDocument>;
  let users: UsersService;
  let auth: AuthService;
  const notified: string[] = [];

  const login = (username: string, password: string) => auth.login({ username, password } as any, '10.0.0.1');
  const message = async (p: Promise<unknown>) => {
    try { await p; return 'OK'; } catch (e) { expect(e).toBeInstanceOf(UnauthorizedException); return (e as Error).message; }
  };
  const raw = (username: string) => model.collection.findOne({ username }) as Promise<any>;

  beforeAll(async () => {
    connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    model = connection.model<UserDocument>('User', UserSchema as any) as any;
    users = new UsersService(model);
    const jwt = { sign: () => 'signed-token' } as any;
    const mentions = { createMany: async (rows: any[]) => { notified.push(...rows.map(r => r.commentText || '')); } } as any;
    const audit = { log: async () => undefined } as any;
    const totp = { getGlobal2faStatus: async () => false } as any;
    auth = new AuthService(users, jwt, mentions, audit, totp);
  });

  beforeEach(async () => {
    await model.deleteMany({});
    notified.length = 0;
    await users.createUser({ username: 'admin', password: 'right-pass', name: 'Admin', role: 'admin' });
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('4 wrong passwords pause sign-in for 15 minutes and keep the account active', async () => {
    expect(await message(login('admin', 'x1'))).toMatch(/تبقى 3/);
    await login('admin', 'x2').catch(() => null);
    await login('admin', 'x3').catch(() => null);
    expect(await message(login('admin', 'x4'))).toMatch(/مؤقتًا.*15 دقيقة/);

    const u = await raw('admin');
    expect(u.isActive).not.toBe(false); // open sessions keep working (JwtStrategy checks isActive)
    expect(minutesLeft(u.loginLockedUntil, new Date())).toBe(15);
    expect(notified.some(t => /مؤقتًا/.test(t))).toBe(true);
  });

  it('refuses even the right password while paused, then lets it in once the pause ends', async () => {
    for (const p of ['a', 'b', 'c', 'd']) await login('admin', p).catch(() => null);
    expect(await message(login('admin', 'right-pass'))).toMatch(/حاول بعد/);

    await model.collection.updateOne({ username: 'admin' }, { $set: { loginLockedUntil: new Date(Date.now() - 1000) } });
    expect(await message(login('admin', 'right-pass'))).toBe('OK');
    const u = await raw('admin');
    expect(u.loginAttempts).toBe(0);
    expect(u.loginLockedUntil).toBeNull();
    expect(u.loginLockLevel).toBe(0);
  });

  it('a second pause within a day lasts longer (15 → 30)', async () => {
    for (const p of ['a', 'b', 'c', 'd']) await login('admin', p).catch(() => null);
    await model.collection.updateOne({ username: 'admin' }, { $set: { loginLockedUntil: new Date(Date.now() - 1000) } });
    for (const p of ['a', 'b', 'c']) await login('admin', p).catch(() => null);
    expect(await message(login('admin', 'e'))).toMatch(/30 دقيقة/);
  });

  it('simultaneous wrong attempts start one pause, not several', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => login('admin', 'wrong' + i).catch(() => null)));
    const u = await raw('admin');
    expect(u.isActive).not.toBe(false);
    expect(u.loginLockLevel).toBe(0);
    expect(minutesLeft(u.loginLockedUntil, new Date())).toBe(15);
  });

  it('an admin can lift the pause, and it is listed with the locked accounts until then', async () => {
    for (const p of ['a', 'b', 'c', 'd']) await login('admin', p).catch(() => null);
    const listed = await users.findLockedUsers();
    expect(listed.map(u => u.username)).toEqual(['admin']);

    const u = await raw('admin');
    await users.unlockAccount(String(u._id), 'another-admin');
    expect((await users.findLockedUsers()).length).toBe(0);
    expect(await message(login('admin', 'right-pass'))).toBe('OK');
  });

  it('pause rules', () => {
    const now = new Date('2026-11-24T10:00:00Z');
    expect([0, 1, 2, 3, 9].map(lockMinutesFor)).toEqual([15, 30, 60, 60, 60]);
    expect(nextLockLevel(0, null, now)).toBe(0);
    expect(nextLockLevel(1, new Date('2026-11-24T09:00:00Z'), now)).toBe(2);
    expect(nextLockLevel(2, new Date('2026-11-22T09:00:00Z'), now)).toBe(0); // older than a day
    expect(bcrypt).toBeDefined();
  });
});
