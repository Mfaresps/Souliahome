/* Tampering protection (Nov 25, 2026): strict rules suspend, the others only alert. */
import { HttpException } from '@nestjs/common';
import { AbuseGuardService, suspensionPayload } from '../../src/abuse-guard/abuse-guard.service';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';

function setup() {
  const state: any = { suspendedAt: null, suspensionLevel: 0 };
  const users = {
    findById: () => ({ select: () => ({ lean: () => ({ exec: async () => ({ ...state }) }) }) }),
    updateOne: (_f: any, u: any) => ({ exec: async () => { Object.assign(state, u.$set); } }),
  };
  const mentions = { createMany: jest.fn(async (rows: any[]) => rows.map((r, i) => ({ ...r, _id: 'm' + i }))) };
  const usersService = { findAll: jest.fn(async () => [{ _id: 'a1', role: 'admin', username: 'admin' }]) };
  const audit = { log: jest.fn(async () => ({})) };
  const presence = { emitToUser: jest.fn() };
  const svc = new AbuseGuardService(users as any, mentions as any, usersService as any, audit as any, presence as any);
  return { svc, state, mentions, presence, audit };
}
const staff = { userId: 'u1', role: 'staff', name: 'Mona', username: 'mona' };
const req = (path: string, body: any = {}, method = 'POST', user: any = staff) => ({ method, path, body, user });
const code = (e: any) => (e instanceof HttpException ? (e.getResponse() as any).code : String(e));
const NOON_CAIRO = new Date('2026-11-25T10:00:00Z'); // 12:00 in Cairo — the night rule stays quiet
const fakeClock = (at: Date) => jest.useFakeTimers({ now: at, doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'queueMicrotask'] });
beforeEach(() => fakeClock(NOON_CAIRO));
afterEach(() => jest.useRealTimers());

describe('strict rules', () => {
  it('the same click 6× in 10 s is refused; refused 3× → suspended 30 min', async () => {
    const { svc, state, presence } = setup();
    const body = { collectMethod: 'كاش', amount: 100 };
    for (let i = 0; i < 5; i++) await svc.beforeWrite(req('/api/transactions/t1/collect', body));
    expect(code(await svc.beforeWrite(req('/api/transactions/t1/collect', body)).catch(e => e))).toBe('ACTION_REPEATED');
    expect(presence.emitToUser).toHaveBeenCalledWith('u1', 'abuse:warning', expect.anything());
    expect(code(await svc.beforeWrite(req('/api/transactions/t1/collect', body)).catch(e => e))).toBe('ACTION_REPEATED');
    expect(code(await svc.beforeWrite(req('/api/transactions/t1/collect', body)).catch(e => e))).toBe('ACCOUNT_SUSPENDED');
    expect(state.suspensionLevel).toBe(1);
    expect(new Date(state.suspendedUntil).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(presence.emitToUser).toHaveBeenCalledWith('u1', 'account:suspended', expect.objectContaining({ code: 'ACCOUNT_SUSPENDED' }));
  });

  it('different bodies (e.g. scanning several pieces) are never "repeats"', async () => {
    const { svc } = setup();
    for (let i = 0; i < 20; i++) await svc.beforeWrite(req('/api/transactions/t1/tags', { tags: ['x' + i] }));
  });

  it('10 refusals in 10 min suspend; escalation 30 min → 2 h → until lifted', async () => {
    const { svc, state } = setup();
    for (let i = 0; i < 30; i++) svc.onHttpError(req('/api/vault', {}, 'GET'), 403); // reads never count
    expect(state.suspensionLevel).toBe(0);
    for (let i = 0; i < 10; i++) svc.onHttpError(req('/api/vault/entries'), 403);
    await new Promise(r => setTimeout(r, 20));
    expect(state.suspensionLevel).toBe(1);
    await svc.suspend(staff, 'flood', 'x').catch(() => undefined);
    expect(state.suspensionLevel).toBe(2);
    expect(new Date(state.suspendedUntil).getTime() - Date.now()).toBeGreaterThan(119 * 60_000);
    await svc.suspend(staff, 'flood', 'x').catch(() => undefined);
    expect(new Date(state.suspendedUntil).getFullYear()).toBeGreaterThanOrEqual(2100);
    expect(suspensionPayload(state).untilLifted).toBe(true);
  });

  it('150 writes in a minute suspend', async () => {
    const { svc, state } = setup();
    let last: any;
    for (let i = 0; i < 150; i++) last = await svc.beforeWrite(req('/api/transactions/t' + i + '/tags', { tags: [i] })).catch(e => e);
    expect(code(last)).toBe('ACCOUNT_SUSPENDED');
    expect(state.suspensionReason).toContain('عدد كبير');
  });

  it('forged permission fields: alert at once, 3rd time suspends', async () => {
    const { svc, mentions } = setup();
    await svc.beforeWrite(req('/api/users/me', { name: 'x', perms: ['vault'] }, 'PUT'));
    expect(mentions.createMany).toHaveBeenCalledTimes(1);
    await svc.beforeWrite(req('/api/users/me', { roleId: 'admin' }, 'PUT'));
    expect(code(await svc.beforeWrite(req('/api/users/me', { isAdmin: true }, 'PUT')).catch(e => e))).toBe('ACCOUNT_SUSPENDED');
  });

  it('uploads: the 21st in 10 min is refused, the 41st suspends', async () => {
    const { svc } = setup();
    for (let i = 0; i < 20; i++) await svc.beforeWrite(req('/api/invoice-images', { n: i }));
    expect(code(await svc.beforeWrite(req('/api/invoice-images', { n: 21 })).catch(e => e))).toBe('UPLOAD_LIMIT');
    let last: any;
    for (let i = 0; i < 20; i++) last = await svc.beforeWrite(req('/api/invoice-images', { n: 100 + i })).catch(e => e);
    expect(code(last)).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('comments', () => {
  const list = (n: number, last = 'note') => ({ comments: Array.from({ length: n }, (_, i) => ({ id: i, text: i === n - 1 ? last : 'old ' + i })) });

  it('the same comment twice within 2 minutes is refused', async () => {
    const { svc } = setup();
    await svc.beforeWrite(req('/api/followups/f1/comments', { text: 'اتصلت بالعميل' }));
    expect(code(await svc.beforeWrite(req('/api/followups/f2/comments', { text: '  اتصلت   بالعميل ' })).catch(e => e))).toBe('COMMENT_DUPLICATE');
  });

  it('more than 5 comments on one record in 10 minutes are refused', async () => {
    const { svc } = setup();
    for (let i = 1; i <= 5; i++) await svc.beforeWrite(req('/api/transactions/t1/comments', list(i, 'c' + i)));
    expect(code(await svc.beforeWrite(req('/api/transactions/t1/comments', list(6, 'c6'))).catch(e => e))).toBe('COMMENT_DENSITY');
  });

  it('more than 8 comments in 5 minutes are refused and the admins told once', async () => {
    const { svc, mentions } = setup();
    for (let i = 1; i <= 8; i++) await svc.beforeWrite(req('/api/followups/f' + i + '/comments', { text: 'msg ' + i }));
    expect(code(await svc.beforeWrite(req('/api/followups/f9/comments', { text: 'msg 9' })).catch(e => e))).toBe('COMMENT_LIMIT');
    expect(mentions.createMany.mock.calls.some((c: any) => c[0][0].commentText.includes('تعليقات مكررة أو كثيفة'))).toBe(true);
  });

  it('editing a comment (the list does not grow) is never counted', async () => {
    const { svc } = setup();
    await svc.beforeWrite(req('/api/transactions/t1/comments', list(3)));
    for (let i = 0; i < 10; i++) await svc.beforeWrite(req('/api/transactions/t1/comments', list(3, 'edit ' + i)));
  });

  it('insisting after 5 refusals suspends', async () => {
    const { svc, state } = setup();
    await svc.beforeWrite(req('/api/followups/f1/comments', { text: 'same' }));
    let last: any;
    for (let i = 0; i < 5; i++) last = await svc.beforeWrite(req('/api/followups/f1/comments', { text: 'same', n: i })).catch(e => e);
    expect(code(last)).toBe('ACCOUNT_SUSPENDED');
    expect(state.suspensionReason).toBe('تعليقات مكررة أو كثيفة');
  });
});

describe('alert-only rules', () => {
  it('mass cancellations alert the admins and warn the employee, but never block', async () => {
    const { svc, mentions, presence } = setup();
    for (let i = 0; i < 8; i++) await svc.beforeWrite(req('/api/transactions/t' + i + '/cancel', { reason: 'x' + i }));
    expect(mentions.createMany).toHaveBeenCalledTimes(1); // throttled: one alert per 10 min
    expect(mentions.createMany.mock.calls[0][0][0].commentText).toContain('حذف أو إلغاء جماعي');
    expect(presence.emitToUser).toHaveBeenCalledWith('u1', 'abuse:warning', expect.anything());
  });

  it('rejecting a deposit receipt alerts at once', async () => {
    const { svc, mentions } = setup();
    await svc.beforeWrite(req('/api/shopify/orders/o1/deposit-receipts/r1/reject', {}));
    expect(mentions.createMany.mock.calls[0][0][0].commentText).toContain('حذف أو رفض عربون');
  });

  it('a write between midnight and 7 a.m. Cairo alerts once a day', async () => {
    fakeClock(new Date('2026-11-25T00:30:00Z')); // 02:30 in Cairo
    const { svc, mentions } = setup();
    await svc.beforeWrite(req('/api/transactions/t1/tags', { tags: ['a'] }));
    await svc.beforeWrite(req('/api/transactions/t1/tags', { tags: ['b'] }));
    expect(mentions.createMany).toHaveBeenCalledTimes(1);
    expect(mentions.createMany.mock.calls[0][0][0].commentText).toContain('خارج ساعات العمل');
  });

  it('admins are never counted; exempt paths are ignored', async () => {
    const { svc, mentions } = setup();
    const admin = { userId: 'a1', role: 'admin' };
    for (let i = 0; i < 200; i++) await svc.beforeWrite(req('/api/transactions/t/cancel', {}, 'POST', admin));
    for (let i = 0; i < 200; i++) await svc.beforeWrite(req('/api/drafts/d1', { same: 1 }));
    expect(mentions.createMany).not.toHaveBeenCalled();
  });
});

describe('enforcement', () => {
  it('a suspended account is stopped on every request (423); admins never', async () => {
    const until = new Date(Date.now() + 600_000);
    const strategy = Object.create(JwtStrategy.prototype);
    strategy.usersService = { findById: async () => ({ role: 'staff', isActive: true, suspendedUntil: until, suspensionReason: 'ضغط متكرر' }) };
    const err = await strategy.validate({ sub: 'u1', username: 'mona' }).catch((e: any) => e);
    expect(err.getStatus()).toBe(423);
    expect(err.getResponse().code).toBe('ACCOUNT_SUSPENDED');
    strategy.usersService = { findById: async () => ({ role: 'admin', isActive: true, suspendedUntil: until }) };
    await expect(strategy.validate({ sub: 'a1', username: 'admin' })).resolves.toBeTruthy();
  });
});
