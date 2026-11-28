import mongoose, { Connection, Model } from 'mongoose';
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

jest.mock('../../src/shared/geo-lookup.util', () => ({ fetchGeo: jest.fn(async () => null) }));

// Sign-in verification (Nov 27, 2026): a password creates a challenge; only a challenge reaches
// the second step. Before this, POST /auth/totp/verify signed in with userId + Google code only.
describe('sign-in verification — challenge, trusted devices, email, approval, reset', () => {
  const dbName = `soulia_test_signin_verify_${Date.now()}`;
  let connection: Connection;
  let model: Model<UserDocument>;
  let users: UsersService;
  let totp: TotpService;
  let challenges: AuthChallengeService;
  let devices: TrustedDevicesService;
  let mailer: SecurityMailerService;
  let sessions: UserSessionsService;
  let verify: SignInVerificationService;
  let auth: AuthService;
  let jwt: JwtService;
  const mails: { to: string; subject: string; text: string }[] = [];
  const audits: any[] = [];
  const emitted: any[] = [];
  const chrome = { ipAddress: '41.1.1.1', userAgent: 'x', device: 'كمبيوتر', browser: 'Chrome', os: 'Windows' };
  const phone = { ipAddress: '41.2.2.2', userAgent: 'y', device: 'موبايل', browser: 'Safari', os: 'iOS' };

  const login = (username: string, password = 'right-pass', deviceToken?: string, client = chrome) =>
    auth.login({ username, password, deviceToken } as any, client.ipAddress, client as any) as Promise<any>;
  const code = (secret: string, offsetSteps = 0) => speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + offsetSteps * 30 });
  const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e.getResponse?.() ?? e; } };
  const lastMailCode = () => (/الرمز: (\d{6})/.exec(mails[mails.length - 1].text) || [])[1];
  const id = async (u: string) => String((await users.findByUsername(u))!._id);

  async function enableTotp(username: string) {
    const uid = await id(username);
    const { secret } = await totp.generateSetup(uid);
    // confirm with a code one step back so the next login code (current step) is still fresh
    const { backupCodes } = await totp.confirmSetup(uid, code(secret, -1));
    return { secret, backupCodes, uid };
  }
  async function verifiedEmail(username: string, email: string) {
    await model.updateOne({ username }, { $set: { securityEmail: email, securityEmailVerifiedAt: new Date() } });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-signin-verify-0123456789';
    connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    model = connection.model<UserDocument>('User', UserSchema as any) as any;
    const settingsModel = connection.model('Settings', SettingsSchema as any) as any;
    await settingsModel.create({ vaultPass: '1234', global2faEnabled: false });
    users = new UsersService(model);
    totp = new TotpService(model as any, settingsModel);
    challenges = new AuthChallengeService(connection);
    devices = new TrustedDevicesService(connection);
    await challenges.onModuleInit();
    await devices.onModuleInit();
    mailer = new SecurityMailerService();
    mailer.useTransport({ send: async (m) => { mails.push(m); } });
    sessions = new UserSessionsService(connection);
    jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '24h' } });
    const audit = { log: async (row: any) => { audits.push(row); } } as any;
    const mentions = { createMany: async () => undefined } as any;
    const presence = { emitToUser: (...a: any[]) => { emitted.push(a); return true; }, disconnectSessions: () => 0 } as any;
    const guard = new LoginGuardService(connection);
    await guard.onModuleInit();
    // The guessing protection has its own suite (login-guard); here every attempt starts clean.
    (guard as any).overIpRate = () => false;
    verify = new SignInVerificationService(users, totp, challenges, devices, mailer, new TokenIssuerService(jwt, sessions), audit, mentions, presence, settingsModel, guard, undefined, sessions);
    auth = new AuthService(users, mentions, audit, verify, guard, devices);
  });

  beforeEach(async () => {
    await model.deleteMany({});
    await connection.collection('authchallenges').deleteMany({});
    await connection.collection('trusteddevices').deleteMany({});
    await connection.collection('usersessions').deleteMany({});
    await connection.collection('loginguard').deleteMany({});
    await connection.collection('settings').updateMany({}, { $set: { vaultPass: '1234', global2faEnabled: false } });
    mails.length = 0; audits.length = 0; emitted.length = 0;
    await users.createUser({ username: 'boss', password: 'right-pass', name: 'Boss', role: 'admin' });
    await users.createUser({ username: 'sara', password: 'right-pass', name: 'Sara', role: 'staff' });
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('staff with 2FA off finishes on the password; an admin always gets a challenge, never a token', async () => {
    expect((await login('sara')).accessToken).toBeTruthy();
    await enableTotp('boss');
    const res = await login('boss');
    expect(res.accessToken).toBeUndefined();
    expect(res.challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(res.methods).toMatchObject({ totp: true, email: null, approval: false, backup: true });
    // the challenge is stored only as a hash
    expect(await connection.collection('authchallenges').findOne({ _id: res.challenge })).toBeNull();
  });

  it('a Google code without a password-made challenge signs nobody in', async () => {
    const { secret } = await enableTotp('boss');
    expect(await err(verify.verifyCode('f'.repeat(64), 'totp', code(secret), false))).toMatchObject({ code: 'CHALLENGE_INVALID' });
    expect(await err(verify.verifyCode(await id('boss'), 'totp', code(secret), false))).toMatchObject({ code: 'CHALLENGE_INVALID' });
  });

  it('a right code signs in once; the same code cannot be replayed; an old code is refused', async () => {
    const { secret } = await enableTotp('boss');
    const c = code(secret);
    const first: any = await verify.verifyCode((await login('boss')).challenge, 'totp', c, false, chrome as any);
    expect(first.accessToken).toBeTruthy();
    expect((jwt.decode(first.accessToken) as any).sid).toBeTruthy();
    expect(await err(verify.verifyCode((await login('boss')).challenge, 'totp', c, false))).toMatchObject({ code: 'CODE_WRONG' });
    expect(await err(verify.verifyCode((await login('boss')).challenge, 'totp', code(secret, -3), false))).toMatchObject({ code: 'CODE_WRONG' });
  });

  it('five wrong codes close the challenge; even the right code is then refused', async () => {
    const { secret } = await enableTotp('boss');
    const ch = (await login('boss')).challenge;
    for (let i = 0; i < 4; i++) expect(await err(verify.verifyCode(ch, 'totp', '000000', false))).toMatchObject({ code: 'CODE_WRONG' });
    expect(await err(verify.verifyCode(ch, 'totp', '000001', false))).toMatchObject({ code: 'CHALLENGE_LOCKED' });
    expect(await err(verify.verifyCode(ch, 'totp', code(secret), false))).toMatchObject({ code: 'CHALLENGE_LOCKED' });
  });

  it('a trusted device skips the second step for 30 days; expired, revoked or another account\'s token does not', async () => {
    const { secret } = await enableTotp('boss');
    const done: any = await verify.verifyCode((await login('boss')).challenge, 'totp', code(secret), true, chrome as any);
    expect(done.deviceToken).toMatch(/^[a-f0-9]{64}$/);
    const days = (new Date(done.trustedUntil).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1);
    const row: any = await connection.collection('trusteddevices').findOne({});
    expect(row.tokenHash).not.toBe(done.deviceToken);

    const again = await login('boss', 'right-pass', done.deviceToken);
    expect(again.accessToken).toBeTruthy();
    expect((await connection.collection('usersessions').findOne({ _id: (jwt.decode(again.accessToken) as any).sid }))!.method).toBe('trusted-device');
    // wrong password still refused on a trusted device
    expect(await err(login('boss', 'nope', done.deviceToken))).toBeTruthy();
    // another account presenting this token
    await enableTotp('sara');
    await connection.collection('settings').updateOne({}, { $set: { global2faEnabled: true } });
    expect((await login('sara', 'right-pass', done.deviceToken)).challenge).toBeTruthy();
    await connection.collection('settings').updateOne({}, { $set: { global2faEnabled: false } });
    // expired
    await connection.collection('trusteddevices').updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await login('boss', 'right-pass', done.deviceToken)).challenge).toBeTruthy();
    // revoked
    await connection.collection('trusteddevices').updateOne({}, { $set: { expiresAt: new Date(Date.now() + 86_400_000) } });
    await devices.revokeAll(await id('boss'), null, 'test');
    expect((await login('boss', 'right-pass', done.deviceToken)).challenge).toBeTruthy();
  });

  it('a device trusted before Nov 27 (raw token on the user) is moved to the new store once', async () => {
    await enableTotp('boss');
    await model.updateOne({ username: 'boss' }, { $set: { trustedDevices: ['legacy-token-1'] } });
    const res = await login('boss', 'right-pass', 'legacy-token-1');
    expect(res.accessToken).toBeTruthy();
    expect(res.deviceToken).toMatch(/^[a-f0-9]{64}$/);
    expect((await model.collection.findOne({ username: 'boss' }) as any).trustedDevices).toEqual([]);
    expect((await login('boss', 'right-pass', 'legacy-token-1')).challenge).toBeTruthy();
    expect((await login('boss', 'right-pass', res.deviceToken)).accessToken).toBeTruthy();
  });

  it('email code: sent to the verified address, hashed, one minute between sends, wrong then right', async () => {
    await verifiedEmail('boss', 'boss@example.com');
    const res = await login('boss');
    expect(res.methods.email).toBe('bo*****s@example.com');
    const sent: any = await verify.sendEmailCode(res.challenge);
    expect(sent.sentTo).toBe('bo*****s@example.com');
    expect(mails[0].to).toBe('boss@example.com');
    const c = lastMailCode();
    expect(c).toMatch(/^\d{6}$/);
    expect(JSON.stringify(await connection.collection('authchallenges').findOne({}))).not.toContain(c);
    expect(await err(verify.sendEmailCode(res.challenge))).toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
    expect(await err(verify.verifyCode(res.challenge, 'email', c === '111111' ? '222222' : '111111', false))).toMatchObject({ code: 'CODE_WRONG' });
    const ok: any = await verify.verifyCode(res.challenge, 'email', c, false, chrome as any);
    expect(ok.accessToken).toBeTruthy();
    // the code is spent
    expect(await err(verify.verifyCode(res.challenge, 'email', c, false))).toMatchObject({ code: 'CHALLENGE_USED' });
  });

  it('employee with a confirmed email: a new device needs the emailed code; «trust» skips it next time', async () => {
    // an address typed but never confirmed does not count
    await model.updateOne({ username: 'sara' }, { $set: { email: 'sara@example.com' } });
    expect((await login('sara')).accessToken).toBeTruthy();
    await model.updateOne({ username: 'sara' }, { $set: { emailVerifiedAt: new Date() } });
    const res = await login('sara');
    expect(res.accessToken).toBeUndefined();
    expect(res.setupRequired).toBe(false);
    expect(res.methods).toMatchObject({ totp: false, email: 'sa*****a@example.com', approval: false, backup: false });
    await verify.sendEmailCode(res.challenge);
    expect(mails[mails.length - 1].to).toBe('sara@example.com');
    const ok: any = await verify.verifyCode(res.challenge, 'email', lastMailCode(), true, chrome as any);
    expect(ok.accessToken).toBeTruthy();
    expect(ok.deviceToken).toMatch(/^[a-f0-9]{64}$/);
    // the trusted device signs in on the password; another device is asked again
    expect((await login('sara', 'right-pass', ok.deviceToken)).accessToken).toBeTruthy();
    const other = await login('sara', 'right-pass', undefined, phone);
    expect(other.challenge).toBeTruthy();
    expect(other.methods.approval).toBe(true);
    // the employee address is used for the sign-in code only — never for an admin-only purpose
    await model.updateOne({ username: 'sara' }, { $set: { securityEmail: 'x@example.com' } });
    expect((await login('sara', 'right-pass', undefined, phone)).methods.email).toBe('sa*****a@example.com');
  });

  it('approval: only a trusted device of the same account decides; a wrong number denies; the right number signs in', async () => {
    const { secret } = await enableTotp('boss');
    const first: any = await verify.verifyCode((await login('boss')).challenge, 'totp', code(secret), true, chrome as any);
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: 's1' };

    const a = await login('boss', 'right-pass', undefined, phone);
    expect(a.methods.approval).toBe(true);
    const req: any = await verify.requestApproval(a.challenge);
    expect(req.number).toMatch(/^\d{2}$/);
    expect(emitted[0][1]).toBe('auth:login-approval');
    const pub = emitted[0][2].id;
    // without the trusted device
    expect(await err(verify.decideApproval(actor, pub, 'approve', req.number, ''))).toMatchObject({ code: 'NOT_TRUSTED_DEVICE' });
    // the list never carries the number itself, only three choices
    const list: any = await verify.pendingApprovals(actor, first.deviceToken);
    expect(list.requests[0].choices).toContain(req.number);
    expect(JSON.stringify(list)).not.toContain('"number"');
    // wrong number = denied
    const wrong = list.requests[0].choices.find((n: string) => n !== req.number);
    expect(await err(verify.decideApproval(actor, pub, 'approve', wrong, first.deviceToken))).toMatchObject({ code: 'NUMBER_MISMATCH' });
    expect(await verify.approvalStatus(a.challenge, false)).toMatchObject({ status: 'denied' });

    const b = await login('boss', 'right-pass', undefined, phone);
    const req2: any = await verify.requestApproval(b.challenge);
    expect(await verify.approvalStatus(b.challenge, false)).toMatchObject({ status: 'pending' });
    const pub2 = emitted[emitted.length - 1][2].id;
    await verify.decideApproval(actor, pub2, 'approve', req2.number, first.deviceToken);
    const st: any = await verify.approvalStatus(b.challenge, true, phone as any);
    expect(st.status).toBe('approved');
    expect(st.accessToken).toBeTruthy();
    expect(st.deviceToken).toBeTruthy();
  });

  it('an admin with no method sets up Google Authenticator inside the challenge and gets backup codes that work once', async () => {
    const res = await login('boss');
    expect(res.setupRequired).toBe(true);
    expect(await err(verify.verifyCode(res.challenge, 'totp', '123456', false))).toMatchObject({ code: 'SETUP_REQUIRED' });
    const { secret } = await verify.setupInit(res.challenge);
    const done: any = await verify.setupConfirm(res.challenge, code(secret), false, chrome as any);
    expect(done.accessToken).toBeTruthy();
    expect(done.backupCodes).toHaveLength(10);
    const b = done.backupCodes[0];
    expect((await login('boss')).methods.backup).toBe(true);
    expect((await verify.verifyCode((await login('boss')).challenge, 'backup', b.toUpperCase(), false) as any).accessToken).toBeTruthy();
    expect(await err(verify.verifyCode((await login('boss')).challenge, 'backup', b, false))).toMatchObject({ code: 'CODE_WRONG' });
  });

  it('forgot password: email AND Google both required, then sessions and trusted devices end', async () => {
    const { secret } = await enableTotp('boss');
    await verifiedEmail('boss', 'boss@example.com');
    const t: any = await verify.verifyCode((await login('boss')).challenge, 'totp', code(secret, 0), true, chrome as any);
    expect(await err(verify.forgotStart('sara'))).toBeTruthy(); // staff: admin resets them

    const fp: any = await verify.forgotStart('boss');
    expect(fp.requirement).toEqual([['email'], ['totp', 'backup']]);
    expect(await err(verify.resetPassword(fp.challenge, 'new-pass-123'))).toMatchObject({ code: 'VERIFY_FIRST' });
    await verify.sendEmailCode(fp.challenge);
    const step1: any = await verify.verifyCode(fp.challenge, 'email', lastMailCode(), false);
    expect(step1).toMatchObject({ done: false, remaining: [['totp', 'backup']] });
    expect(await err(verify.resetPassword(fp.challenge, 'new-pass-123'))).toMatchObject({ code: 'VERIFY_FIRST' });
    const step2: any = await verify.verifyCode(fp.challenge, 'totp', code(secret, 1), false);
    expect(step2).toMatchObject({ done: true, resetReady: true });
    expect(await err(verify.resetPassword(fp.challenge, 'short'))).toBeTruthy();
    expect(await verify.resetPassword(fp.challenge, 'new-pass-123')).toEqual({ success: true });

    expect(await err(login('boss'))).toBeTruthy(); // old password
    expect((await login('boss', 'new-pass-123', t.deviceToken)).challenge).toBeTruthy(); // device revoked
    const open = await connection.collection('usersessions').countDocuments({ endedAt: null });
    expect(open).toBe(0);
    expect(mails.some((m) => m.subject === 'تغيير كلمة المرور')).toBe(true);
    // the spent challenge cannot reset twice
    expect(await err(verify.resetPassword(fp.challenge, 'another-pass-1'))).toMatchObject({ code: 'CHALLENGE_USED' });
  });

  it('security email: needs the current password, is confirmed by a code, and is admin-only', async () => {
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' };
    expect(await err(verify.emailRequest(actor, 'boss@example.com', 'wrong'))).toMatchObject({ code: 'PASSWORD_WRONG' });
    await verify.emailRequest(actor, 'Boss@Example.com', 'right-pass');
    const c = lastMailCode();
    expect(mails[0].to).toBe('boss@example.com');
    expect((await verify.methodsFor(await users.findById(actor.id))).email).toBe(false); // not yet confirmed
    expect(await err(verify.emailConfirm(actor, c === '000000' ? '111111' : '000000'))).toBeTruthy();
    expect(await verify.emailConfirm(actor, c)).toMatchObject({ success: true, securityEmail: 'boss@example.com' });
    expect((await verify.methodsFor(await users.findById(actor.id))).email).toBe(true);
    const staff = { id: await id('sara'), name: 'Sara', role: 'staff', sid: '' };
    expect(await err(verify.emailRequest(staff, 'sara@example.com', 'right-pass'))).toBeTruthy();
  });

  it('the system PIN changes only after a confirmation code meant for that change, once', async () => {
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' };
    const pin = async () => ((await connection.collection('settings').findOne({})) as any).vaultPass;
    // no factor at all → told to set one up first
    expect(await err(verify.stepUpStart(actor, 'system-pin'))).toMatchObject({ code: 'STEP_UP_UNAVAILABLE' });
    const { secret } = await enableTotp('boss');
    expect(await err(verify.changeSystemPin(actor, '5678', '', undefined, '1234'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // a confirmation started but not finished
    const open: any = await verify.stepUpStart(actor, 'system-pin');
    expect(await err(verify.changeSystemPin(actor, '5678', open.challenge, undefined, '1234'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // a confirmation for another setting cannot be spent here
    const other: any = await verify.stepUpStart(actor, 'security-email');
    expect(await verify.verifyCode(other.challenge, 'totp', code(secret), false)).toMatchObject({ stepUpReady: true });
    expect(await err(verify.changeSystemPin(actor, '5678', other.challenge, undefined, '1234'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // another admin cannot use this admin's confirmation
    expect(await verify.verifyCode(open.challenge, 'totp', code(secret, 1), false)).toMatchObject({ stepUpReady: true });
    const staffAdmin = { id: await id('sara'), name: 'Sara', role: 'admin', sid: '' };
    expect(await err(verify.changeSystemPin(staffAdmin, '5678', open.challenge, undefined, '1234'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await pin()).toBe('1234');
    expect(await verify.changeSystemPin(actor, '5678', open.challenge, undefined, '1234')).toEqual({ success: true });
    expect(await pin()).toBe('5678');
    // single use
    expect(await err(verify.changeSystemPin(actor, '9999', open.challenge, undefined, '5678'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await pin()).toBe('5678');
  });

  it('changing or removing a verified email needs a code from the current factor first', async () => {
    await verifiedEmail('boss', 'old@example.com');
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' };
    expect(await err(verify.emailRequest(actor, 'new@example.com', 'right-pass'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await err(verify.emailRemove(actor, 'right-pass'))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const su: any = await verify.stepUpStart(actor, 'security-email');
    expect(su.methods.email).toBe('o*****@example.com');
    await verify.sendEmailCode(su.challenge);
    expect(mails[mails.length - 1].to).toBe('old@example.com'); // the code goes to the CURRENT address
    await verify.verifyCode(su.challenge, 'email', lastMailCode(), false);
    await verify.emailRequest(actor, 'new@example.com', 'right-pass', su.challenge);
    expect(mails[mails.length - 1].to).toBe('new@example.com');
    await verify.emailConfirm(actor, lastMailCode());
    expect((await users.findById(actor.id) as any).securityEmail).toBe('new@example.com');
    expect(mails.some((m) => m.to === 'old@example.com' && m.subject === 'تغيير البريد الإلكتروني')).toBe(true);
  });

  it('turning Google Authenticator off: password always, plus an email code when an email is linked', async () => {
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' };
    const { secret } = await enableTotp('boss');
    await verifiedEmail('boss', 'boss@example.com');
    expect(await err(verify.totpDisable(actor, 'wrong', ''))).toMatchObject({ code: 'PASSWORD_WRONG' });
    expect(await err(verify.totpDisable(actor, 'right-pass', ''))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // the confirmation is by email only — a Google code cannot be used to turn Google off
    const su: any = await verify.stepUpStart(actor, 'totp-disable');
    expect(su.requirement).toEqual([['email']]);
    expect(await err(verify.verifyCode(su.challenge, 'totp', code(secret), false))).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    await verify.sendEmailCode(su.challenge);
    expect(mails[mails.length - 1]).toMatchObject({ to: 'boss@example.com' });
    expect(mails[mails.length - 1].subject).toBe('رمز تأكيد الهوية');
    expect(mails[mails.length - 1].text).toMatch(/الغرض: .*Google Authenticator/);
    await verify.verifyCode(su.challenge, 'email', lastMailCode(), false);
    expect(await verify.totpDisable(actor, 'right-pass', '', su.challenge)).toEqual({ success: true });
    expect((await users.findById(actor.id))!.totpEnabled).toBe(false);
    // no email linked: the password is enough (as before)
    await enableTotp('sara');
    const staff = { id: await id('sara'), name: 'Sara', role: 'staff', sid: '' };
    expect(await verify.totpDisable(staff, 'right-pass', '')).toEqual({ success: true });
  });

  it('another admin resets an account\'s 2FA only with the system PIN', async () => {
    await enableTotp('sara');
    const actor = { id: await id('boss'), name: 'Boss', role: 'admin', sid: '' };
    expect(await err(verify.adminReset2fa(actor, await id('sara'), '0000'))).toMatchObject({ code: 'PIN_WRONG' });
    expect(await verify.adminReset2fa(actor, await id('sara'), '1234')).toEqual({ success: true });
    expect((await users.findByUsername('sara'))!.totpEnabled).toBe(false);
  });
});
