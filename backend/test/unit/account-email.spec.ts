import * as bcrypt from 'bcrypt';
import { AccountEmailService } from '../../src/auth/account-email.service';
import { SecurityMailerService } from '../../src/auth/security-mailer.service';
import {
  accountEmailRequired, accountEmailSendCheck, accountEmailView, cleanAccountEmail, verifiedEmailOf,
} from '../../src/auth/account-email.util';

export {};

/** In-memory stand-in for the UsersService methods the account-email service uses. */
function fakeUsers(rows: any[]) {
  const byId = (id: string) => rows.find((u) => String(u._id) === String(id));
  return {
    rows,
    async findById(id: string) { return byId(id) || null; },
    async setAccountEmailPending(id: string, pending: any, sends?: Date[]) { const u = byId(id); u.emailPending = pending; if (sends) u.emailCodeSends = sends; },
    async bumpAccountEmailAttempts(id: string) { const u = byId(id); if (!u.emailPending) return 99; u.emailPending.attempts += 1; return u.emailPending.attempts; },
    async expireAccountEmailCode(id: string) { const u = byId(id); if (u.emailPending) { u.emailPending.codeHash = ''; u.emailPending.expiresAt = new Date(); } },
    async confirmAccountEmail(id: string, email: string, hash: string) {
      const u = byId(id);
      if (!u.emailPending || u.emailPending.email !== email || u.emailPending.codeHash !== hash) return false;
      u.email = email; u.emailVerifiedAt = new Date(); u.emailPending = null; return true;
    },
    async emailTakenBy(email: string, exceptId: string) {
      const o = rows.find((u) => String(u._id) !== String(exceptId) && ((u.email === email && u.emailVerifiedAt) || (u.securityEmail === email && u.securityEmailVerifiedAt)));
      return o ? { _id: String(o._id), username: o.username } : null;
    },
  };
}

function setup(rows: any[]) {
  const sent: any[] = [];
  const mailer = new SecurityMailerService();
  mailer.useTransport({ async send(m) { sent.push(m); } });
  const users = fakeUsers(rows);
  const emitted: any[] = [];
  const presence: any = { emitToAdmins: (e: string, p: any) => emitted.push([e, p]), emitToUser: () => true };
  const audit: any = { log: async () => undefined };
  const svc = new AccountEmailService(users as any, mailer, audit, presence);
  const lastCode = () => {
    const m = sent[sent.length - 1];
    // The code is in the body only — subjects are fixed phrases (Gmail).
    const hit = /الرمز:\s*(\d{6})/.exec(m.text);
    return hit ? hit[1] : '';
  };
  return { svc, sent, users, emitted, lastCode };
}

const staff = (over: any = {}) => ({ _id: 'u1', username: 'reem', name: 'Reem', role: 'staff', isActive: true, email: '', emailVerifiedAt: null, emailPending: null, emailCodeSends: [], ...over });
const actor = { id: 'u1', name: 'Reem', role: 'staff' };
const admin = { id: 'a1', name: 'Owner', role: 'admin' };

describe('account email — rules', () => {
  it('cleans and validates the address', () => {
    expect(cleanAccountEmail('  Reem@Example.COM ')).toEqual({ email: 'reem@example.com', problem: null });
    expect(cleanAccountEmail('reem@x').problem).toBeTruthy();
    expect(cleanAccountEmail('').problem).toBeTruthy();
  });

  it('counts an address only once it is verified', () => {
    expect(verifiedEmailOf({ email: 'a@b.co', emailVerifiedAt: null })).toBe('');
    expect(verifiedEmailOf({ email: 'a@b.co', emailVerifiedAt: new Date() })).toBe('a@b.co');
  });

  it('requires an email of active non-admin accounts, and only when mail can be sent', () => {
    expect(accountEmailRequired({ role: 'staff', isActive: true }, true)).toBe(true);
    expect(accountEmailRequired({ role: 'viewer', isActive: true, email: 'old@typed.com' }, true)).toBe(true); // typed, never confirmed
    expect(accountEmailRequired({ role: 'staff', isActive: true }, false)).toBe(false);
    expect(accountEmailRequired({ role: 'admin', isActive: true }, true)).toBe(false);
    expect(accountEmailRequired({ role: 'staff', isActive: false }, true)).toBe(false);
    expect(accountEmailRequired({ role: 'staff', isActive: true, email: 'a@b.co', emailVerifiedAt: new Date() }, true)).toBe(false);
  });

  it('limits sending: 60 s apart, 5 an hour across addresses', () => {
    const now = new Date('2026-11-27T10:00:00Z');
    expect(accountEmailSendCheck([], now).ok).toBe(true);
    expect(accountEmailSendCheck([new Date(now.getTime() - 30_000)], now)).toMatchObject({ ok: false, waitSec: 30 });
    const five = [50, 40, 30, 20, 10].map((m) => new Date(now.getTime() - m * 60_000));
    const r = accountEmailSendCheck(five, now);
    expect(r.ok).toBe(false);
    expect(r.waitSec).toBe(10 * 60);
    expect(accountEmailSendCheck([new Date(now.getTime() - 2 * 3600_000)], now).recent).toHaveLength(0);
  });

  it('never shows the code hash', () => {
    const v = accountEmailView(staff({ emailPending: { email: 'x@y.co', codeHash: 'secret', expiresAt: new Date(Date.now() + 60_000), attempts: 0, sentAt: new Date(), requestedBy: null } }));
    expect(JSON.stringify(v)).not.toContain('secret');
    expect(v.pending).toMatchObject({ email: 'x@y.co', codeLive: true, byAdmin: false });
  });
});

describe('account email — service', () => {
  it('links the address only after the right code; a wrong code is counted', async () => {
    const { svc, users, sent, lastCode, emitted } = setup([staff()]);
    const r = await svc.requestOwn(actor, 'Reem@Example.com');
    expect(r.sentTo).toBe('reem@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('reem@example.com');
    expect(users.rows[0].email).toBe(''); // nothing linked yet
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(svc.confirmOwn(actor, wrong)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CODE_WRONG', attemptsLeft: 4 }) });
    const ok = await svc.confirmOwn(actor, code.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])); // Arabic digits accepted
    expect(ok.email).toBe('reem@example.com');
    expect(users.rows[0].email).toBe('reem@example.com');
    expect(users.rows[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(users.rows[0].emailPending).toBeNull();
    expect(emitted.some(([e]) => e === 'users:email-changed')).toBe(true);
  });

  it('stops a code after 5 wrong tries but keeps the address for a new code', async () => {
    const { svc, users, lastCode } = setup([staff()]);
    await svc.requestOwn(actor, 'reem@example.com');
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await expect(svc.confirmOwn(actor, wrong)).rejects.toBeTruthy();
    await expect(svc.confirmOwn(actor, wrong)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CODE_LOCKED' }) });
    expect(users.rows[0].emailPending.email).toBe('reem@example.com');
    await expect(svc.confirmOwn(actor, lastCode())).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CODE_EXPIRED' }) });
  });

  it('changing a confirmed address needs the current password, and the old one is told', async () => {
    const password = await bcrypt.hash('Secret#123', 4);
    const { svc, users, sent, lastCode } = setup([staff({ password, email: 'old@example.com', emailVerifiedAt: new Date() })]);
    await expect(svc.requestOwn(actor, 'new@example.com')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PASSWORD_WRONG' }) });
    await expect(svc.requestOwn(actor, 'new@example.com', 'nope')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PASSWORD_WRONG' }) });
    await svc.requestOwn(actor, 'new@example.com', 'Secret#123');
    expect(users.rows[0].email).toBe('old@example.com'); // still linked until confirmed
    await svc.confirmOwn(actor, lastCode());
    await new Promise((r) => setTimeout(r, 0));
    expect(users.rows[0].email).toBe('new@example.com');
    expect(sent.some((m) => m.to === 'old@example.com' && m.subject === 'تغيير البريد الإلكتروني')).toBe(true);
  });

  it('refuses an address confirmed on another account', async () => {
    const { svc } = setup([staff(), staff({ _id: 'u2', username: 'mona', email: 'reem@example.com', emailVerifiedAt: new Date() })]);
    await expect(svc.requestOwn(actor, 'reem@example.com')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EMAIL_TAKEN' }) });
  });

  it('an admin requests an address for an employee; only the employee confirms it', async () => {
    const { svc, users, sent, lastCode } = setup([staff(), { _id: 'a1', username: 'admin', name: 'Owner', role: 'admin' }]);
    await svc.requestForUser(admin, 'u1', 'reem@example.com');
    expect(sent[0].to).toBe('reem@example.com');
    expect(users.rows[0].emailPending.requestedBy).toEqual({ id: 'a1', name: 'Owner' });
    // 48 hours, not 5 minutes: the employee enters it at their next sign-in.
    expect(users.rows[0].emailPending.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    expect(users.rows[0].email).toBe('');
    await svc.confirmOwn(actor, lastCode());
    expect(users.rows[0].email).toBe('reem@example.com');
    await expect(svc.requestForUser({ ...actor }, 'u1', 'x@y.co')).rejects.toBeTruthy(); // staff cannot
    await expect(svc.requestForUser(admin, 'a1', 'x@y.co')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ADMIN_ACCOUNT' }) });
  });

  it('a new account never fails because of its email', async () => {
    const { svc } = setup([staff()]);
    expect(await svc.inviteNewAccount(admin, 'u1', '')).toEqual({ sent: false });
    expect(await svc.inviteNewAccount(admin, 'u1', 'not-an-email')).toMatchObject({ sent: false, message: expect.any(String) });
    expect(await svc.inviteNewAccount(admin, 'u1', 'reem@example.com')).toEqual({ sent: true, sentTo: 'reem@example.com' });
  });

  it('a second code within a minute is refused', async () => {
    const { svc } = setup([staff()]);
    await svc.requestOwn(actor, 'reem@example.com');
    await expect(svc.resendOwn(actor)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EMAIL_RATE_LIMITED' }) });
  });
});
