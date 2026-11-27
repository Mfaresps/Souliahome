import mongoose, { Connection, Model } from 'mongoose';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import * as speakeasy from 'speakeasy';
import { AuthService } from '../../src/auth/auth.service';
import { UsersService } from '../../src/users/users.service';
import { UserSchema, UserDocument } from '../../src/users/schemas/user.schema';
import { SettingsSchema } from '../../src/settings/schemas/settings.schema';
import { UserSessionsService } from '../../src/auth/user-sessions.service';
import { TotpService } from '../../src/auth/totp.service';
import { AuthChallengeService } from '../../src/auth/auth-challenge.service';
import { TrustedDevicesService } from '../../src/auth/trusted-devices.service';
import { SecurityMailerService } from '../../src/auth/security-mailer.service';
import { TokenIssuerService } from '../../src/auth/token-issuer.service';
import { SignInVerificationService } from '../../src/auth/sign-in-verification.service';
import { LoginGuardService } from '../../src/auth/login-guard.service';
import { leadingZeroBits } from '../../src/auth/login-guard.util';

jest.mock('../../src/shared/geo-lookup.util', () => ({ fetchGeo: jest.fn(async () => null) }));

// Password-guessing protection (Nov 27, 2026). Owner's rule: the source guessing is locked, never the
// account — the real admin keeps signing in from a trusted device or another place.
describe('login guard — the guessing source is locked, never the account', () => {
  const dbName = `soulia_test_login_guard_${Date.now()}`;
  let connection: Connection;
  let model: Model<UserDocument>;
  let users: UsersService;
  let totp: TotpService;
  let guard: LoginGuardService;
  let devices: TrustedDevicesService;
  let verify: SignInVerificationService;
  let auth: AuthService;
  const mails: { to: string; subject: string; text: string }[] = [];
  const emitted: any[] = [];
  const audits: any[] = [];
  const pc = { userAgent: 'x', device: 'كمبيوتر', browser: 'Chrome', os: 'Windows' };

  const login = (username: string, password: string, ip = '41.1.1.1', extra: Record<string, unknown> = {}) =>
    auth.login({ username, password, ...extra } as any, ip, { ...pc, ipAddress: ip } as any, ip) as Promise<any>;
  const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return { status: e.getStatus?.(), ...(e.getResponse?.() ?? {}) }; } };
  const solve = (challenge: string, difficulty: number) => {
    for (let n = 0; ; n++) if (leadingZeroBits(crypto.createHash('sha256').update(`${challenge}:${n}`).digest()) >= difficulty) return String(n);
  };
  /** Wrong passwords, answering the robot check whenever it is asked. */
  async function wrong(username: string, times: number, ip = '41.1.1.1') {
    let last: any = null;
    for (let i = 0; i < times; i++) {
      last = await err(login(username, 'bad-' + i, ip));
      if (last?.code === 'POW_REQUIRED') last = await err(login(username, 'bad-' + i, ip, { pow: { challenge: last.pow.challenge, nonce: solve(last.pow.challenge, last.pow.difficulty) } }));
    }
    return last;
  }
  const id = async (u: string) => String((await users.findByUsername(u))!._id);

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-login-guard-0123456789';
    connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    model = connection.model<UserDocument>('User', UserSchema as any) as any;
    const settingsModel = connection.model('Settings', SettingsSchema as any) as any;
    await settingsModel.create({ vaultPass: '1234', global2faEnabled: false });
    users = new UsersService(model);
    totp = new TotpService(model as any, settingsModel);
    const challenges = new AuthChallengeService(connection);
    devices = new TrustedDevicesService(connection);
    guard = new LoginGuardService(connection);
    await challenges.onModuleInit(); await devices.onModuleInit(); await guard.onModuleInit();
    const mailer = new SecurityMailerService();
    mailer.useTransport({ send: async (m) => { mails.push(m); } });
    const sessions = new UserSessionsService(connection);
    const jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '24h' } });
    const audit = { log: async (row: any) => { audits.push(row); } } as any;
    const mentions = { createMany: async () => undefined } as any;
    const presence = { emitToUser: (...a: any[]) => { emitted.push(a); return true; }, disconnectSessions: () => 0 } as any;
    verify = new SignInVerificationService(users, totp, challenges, devices, mailer, new TokenIssuerService(jwt, sessions), audit, mentions, presence, settingsModel, guard, undefined, sessions);
    auth = new AuthService(users, mentions, audit, verify, guard, devices);
  });

  beforeEach(async () => {
    await model.deleteMany({});
    for (const c of ['loginguard', 'loginattempts', 'loginalerts', 'authchallenges', 'trusteddevices', 'usersessions']) await connection.collection(c).deleteMany({});
    (guard as any).ipRequests.clear();
    mails.length = 0; emitted.length = 0; audits.length = 0;
    await users.createUser({ username: 'boss', password: 'right-pass', name: 'Boss', role: 'admin' });
    await users.createUser({ username: 'sara', password: 'right-pass', name: 'Sara', role: 'staff' });
  });

  afterAll(async () => { await connection.dropDatabase(); await connection.close(); });

  it('one generic message for a wrong password and an unknown username, with no attempts count', async () => {
    const a = await err(login('sara', 'nope'));
    const b = await err(login('nobody-here', 'nope'));
    expect(a).toMatchObject({ status: 401, code: 'BAD_CREDENTIALS', message: 'بيانات الدخول غير صحيحة.' });
    expect(b).toMatchObject({ status: 401, code: 'BAD_CREDENTIALS', message: 'بيانات الدخول غير صحيحة.' });
    expect((a as any).message).not.toMatch(/\d/);
  });

  it('after 3 failures the robot check is required; a solved challenge works once', async () => {
    await wrong('sara', 3);
    const r: any = await err(login('sara', 'right-pass'));
    expect(r).toMatchObject({ status: 428, code: 'POW_REQUIRED' });
    expect(r.pow.difficulty).toBeGreaterThanOrEqual(10);
    // a wrong nonce or a challenge reused is refused
    expect(await err(login('sara', 'right-pass', '41.1.1.1', { pow: { challenge: r.pow.challenge, nonce: 'x' } }))).toMatchObject({ code: 'POW_REQUIRED' });
    const pow = { challenge: r.pow.challenge, nonce: solve(r.pow.challenge, r.pow.difficulty) };
    expect((await login('sara', 'right-pass', '41.1.1.1', { pow })).accessToken).toBeTruthy();
    // a challenge issued for another IP cannot be used here
    await wrong('sara', 3, '9.9.9.9');
    await wrong('sara', 3, '7.7.7.7');
    const other: any = await err(login('sara', 'right-pass', '9.9.9.9'));
    expect(await err(login('sara', 'right-pass', '7.7.7.7', { pow: { challenge: other.pow.challenge, nonce: solve(other.pow.challenge, other.pow.difficulty) } }))).toMatchObject({ code: 'POW_REQUIRED' });
  });

  it('5 failures lock THAT IP for 15 minutes — even the right password — but the account is not locked', async () => {
    const r = await wrong('boss', 5, '66.6.6.6');
    expect(r).toMatchObject({ status: 423, code: 'LOGIN_LOCKED', minutes: 15 });
    expect(await err(login('boss', 'right-pass', '66.6.6.6'))).toMatchObject({ status: 423, code: 'LOGIN_LOCKED' });
    // the real admin from another place signs in (second step for an admin)
    expect((await login('boss', 'right-pass', '10.0.0.5')).challenge).toBeTruthy();
    const u: any = await model.collection.findOne({ username: 'boss' });
    expect(u.isActive).not.toBe(false);
    expect(u.loginLockedUntil ?? null).toBeNull();
    expect(u.loginBlock).toMatchObject({ hard: false, ip: '66.6.6.6' });
    // owner asked «هل هذا أنت؟», admins told
    expect(emitted.some((e) => e[1] === 'auth:login-alert')).toBe(true);
    expect(audits.some((a) => a.violationType === 'login_source_locked')).toBe(true);
  });

  it('a trusted device is not stopped by its IP being locked', async () => {
    const { secret } = await totp.generateSetup(await id('boss'));
    await totp.confirmSetup(await id('boss'), speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) - 30 }));
    const ch = (await login('boss', 'right-pass', '41.1.1.1')).challenge;
    const done: any = await verify.verifyCode(ch, 'totp', speakeasy.totp({ secret, encoding: 'base32' }), true, { ...pc, ipAddress: '41.1.1.1' } as any);
    await wrong('boss', 5, '41.1.1.1');
    expect(await err(login('boss', 'right-pass', '41.1.1.1'))).toMatchObject({ code: 'LOGIN_LOCKED' });
    expect((await login('boss', 'right-pass', '41.1.1.1', { deviceToken: done.deviceToken })).accessToken).toBeTruthy();
  });

  it('a repeated lock lasts longer (15 → 30); 10 failures in a day block the source until lifted', async () => {
    await wrong('sara', 5);
    await connection.collection('loginguard').updateOne({ _id: 'src:sara|ip:41.1.1.1' as any }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await wrong('sara', 4)).toMatchObject({ code: 'BAD_CREDENTIALS' }); // 9 in the day
    expect(await wrong('sara', 1)).toMatchObject({ code: 'LOGIN_BLOCKED' }); // the 10th
    expect(await err(login('sara', 'right-pass'))).toMatchObject({ code: 'LOGIN_BLOCKED' });
    // admin lifts it
    const admin = await users.unlockAccount(await id('sara'), 'admin');
    expect(admin).toBeTruthy();
    // the IP keeps its own recent count, so the robot check is still asked — then it signs in
    const r: any = await err(login('sara', 'right-pass'));
    expect(r).toMatchObject({ code: 'POW_REQUIRED' });
    expect((await login('sara', 'right-pass', '41.1.1.1', { pow: { challenge: r.pow.challenge, nonce: solve(r.pow.challenge, r.pow.difficulty) } })).accessToken).toBeTruthy();
  });

  it('lock steps: second lock in a day is 30 minutes', async () => {
    await wrong('sara', 5, '1.1.1.1');
    // forget the day count so only the lock level matters
    await connection.collection('loginguard').updateOne({ _id: 'src:sara|ip:1.1.1.1' as any }, { $set: { lockedUntil: new Date(Date.now() - 1000), times: [] } });
    expect(await wrong('sara', 5, '1.1.1.1')).toMatchObject({ code: 'LOGIN_LOCKED', minutes: 30 });
  });

  it('the owner unlocks a locked IP with a code; the password is still needed', async () => {
    const { secret } = await totp.generateSetup(await id('boss'));
    await totp.confirmSetup(await id('boss'), speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) - 30 }));
    await wrong('boss', 5, '5.5.5.5');
    const un: any = await verify.unlockStart('boss', { ...pc, ipAddress: '5.5.5.5' } as any, '5.5.5.5');
    expect(un.methods).toMatchObject({ totp: true });
    expect(await verify.verifyCode(un.challenge, 'totp', speakeasy.totp({ secret, encoding: 'base32' }), false)).toMatchObject({ unlocked: true });
    expect(await err(login('boss', 'wrong', '5.5.5.5'))).toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect((await login('boss', 'right-pass', '5.5.5.5')).challenge).toBeTruthy();
    // an account with no second factor cannot unlock this way
    expect(await err(verify.unlockStart('sara', pc as any, '5.5.5.5'))).toMatchObject({ code: 'UNLOCK_UNAVAILABLE' });
  });

  it('«هذا أنا» lifts the lock; «لست أنا» blocks the source and makes trusted devices verify', async () => {
    const { secret } = await totp.generateSetup(await id('boss'));
    await totp.confirmSetup(await id('boss'), speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) - 30 }));
    const ch = (await login('boss', 'right-pass', '41.1.1.1')).challenge;
    const done: any = await verify.verifyCode(ch, 'totp', speakeasy.totp({ secret, encoding: 'base32' }), true, { ...pc, ipAddress: '41.1.1.1' } as any);
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' };

    await wrong('boss', 5, '7.7.7.7');
    let alerts = (await verify.pendingLoginAlerts(actor)).alerts;
    expect(alerts[0]).toMatchObject({ ip: '7.7.7.7', kind: 'locked' });
    await verify.decideLoginAlert(actor, alerts[0].id, 'me');
    expect((await login('boss', 'right-pass', '7.7.7.7')).challenge).toBeTruthy();

    await wrong('boss', 5, '8.8.4.4');
    alerts = (await verify.pendingLoginAlerts(actor)).alerts;
    await verify.decideLoginAlert(actor, alerts[0].id, 'not-me');
    expect(await err(login('boss', 'right-pass', '8.8.4.4'))).toMatchObject({ code: 'LOGIN_BLOCKED' });
    // under attack: the trusted device still needs the second step
    expect((await login('boss', 'right-pass', '41.1.1.1', { deviceToken: done.deviceToken })).challenge).toBeTruthy();
  });

  it('every attempt is logged, success included', async () => {
    await err(login('sara', 'nope'));
    await login('sara', 'right-pass');
    const rows = await connection.collection('loginattempts').find({ userKey: 'sara' }).toArray();
    expect(rows.map((r: any) => r.result).sort()).toEqual(['bad-credentials', 'password-ok']);
    expect(rows[0]).toMatchObject({ ip: '41.1.1.1', browser: 'Chrome' });
  });

  it('a disabled account is named only after the right password', async () => {
    await model.updateOne({ username: 'sara' }, { $set: { isActive: false, lockReason: 'معطّل' } });
    expect(await err(login('sara', 'nope'))).toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect((await err(login('sara', 'right-pass')) as any).message).toMatch(/🔒/);
  });

  it('with Turnstile keys the robot check is Cloudflare Turnstile; an unreachable Cloudflare falls back to the proof of work', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site-key-1';
    process.env.TURNSTILE_SECRET_KEY = 'secret-key-1';
    const calls: any[] = [];
    let answer: 'yes' | 'no' | 'down' = 'no';
    const spy = jest.spyOn(global as any, 'fetch').mockImplementation(async (_url: any, init: any) => {
      calls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      if (answer === 'down') throw new Error('network');
      return { ok: true, json: async () => (answer === 'yes' ? { success: true, action: 'login' } : { success: false }) } as any;
    });
    try {
      for (let i = 0; i < 3; i++) await err(login('sara', 'bad-' + i));
      const r: any = await err(login('sara', 'right-pass'));
      expect(r).toMatchObject({ status: 428, code: 'CAPTCHA_REQUIRED', captcha: { provider: 'turnstile', siteKey: 'site-key-1' } });
      expect(calls).toHaveLength(0); // no token: Cloudflare is not asked
      expect(await err(login('sara', 'right-pass', '41.1.1.1', { captcha: 'tok-bad' }))).toMatchObject({ code: 'CAPTCHA_REQUIRED' });
      expect(calls[0]).toMatchObject({ secret: 'secret-key-1', response: 'tok-bad', remoteip: '41.1.1.1' });
      // a proof of work is not accepted in place of the Turnstile token
      expect(await err(login('sara', 'right-pass', '41.1.1.1', { pow: { challenge: 'x', nonce: '1' } }))).toMatchObject({ code: 'CAPTCHA_REQUIRED' });
      answer = 'yes';
      expect((await login('sara', 'right-pass', '41.1.1.1', { captcha: 'tok-good' })).accessToken).toBeTruthy();
      await err(login('sara', 'bad-x')); await err(login('sara', 'bad-y')); await err(login('sara', 'bad-z', '41.1.1.1', { captcha: 'tok-good' }));
      answer = 'down';
      expect(await err(login('sara', 'right-pass', '41.1.1.1', { captcha: 'tok-any' }))).toMatchObject({ status: 428, code: 'POW_REQUIRED' });
      const results = (await connection.collection('loginattempts').find({ userKey: 'sara' }).toArray()).map((x: any) => x.result);
      expect(results).toEqual(expect.arrayContaining(['captcha-required', 'captcha-failed', 'pow-required']));
    } finally {
      spy.mockRestore();
      delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
    }
  });

  it('the attempts screen: prefix search on username or IP, result groups, and the last 24 hours', async () => {
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' } as any;
    await err(login('sara', 'nope', '41.1.1.1'));
    await login('sara', 'right-pass', '41.1.1.1');
    await err(login('boss', 'nope', '52.2.2.2'));
    await err(login('ghost', 'nope', '52.2.9.9'));
    const all = await verify.loginAttempts(actor, {});
    expect(all.total).toBe(4);
    expect(all.last24h).toMatchObject({ total: 4, ok: 1, failed: 3, stopped: 0, failedIps: 3 });
    expect(all.captcha).toBe('pow');
    expect((await verify.loginAttempts(actor, { q: 'SA' })).rows.map((r: any) => r.userKey)).toEqual(['sara', 'sara']);
    expect((await verify.loginAttempts(actor, { q: '52.2.' })).total).toBe(2);
    expect((await verify.loginAttempts(actor, { q: '52.2.', result: 'failed' })).total).toBe(2);
    expect((await verify.loginAttempts(actor, { result: 'ok' })).rows[0]).toMatchObject({ userKey: 'sara', result: 'password-ok' });
    // a regex typed in the search is taken literally
    expect((await verify.loginAttempts(actor, { q: '.*' })).total).toBe(0);
    await expect(verify.loginAttempts({ ...actor, role: 'staff' }, {})).rejects.toThrow();
  });
});
