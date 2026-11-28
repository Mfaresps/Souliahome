import { of, lastValueFrom } from 'rxjs';
import { needsSecondStep } from '../../src/auth/auth-security.util';
import { accountEmailGateAllows } from '../../src/auth/account-email.util';
import { AccountEmailGateInterceptor } from '../../src/auth/account-email-gate.interceptor';

// Owner's rules (Nov 28, 2026): an employee with a confirmed email verifies every new device by an
// emailed code; one without a confirmed email is held by the server until they confirm one.
describe('employee sign-in by email + the mandatory email hold', () => {
  it('who must verify a device that is not trusted', () => {
    const staff = { role: 'staff', totpEnabled: false };
    expect(needsSecondStep({ role: 'admin' }, false)).toBe(true);
    expect(needsSecondStep(staff, false)).toBe(false);
    expect(needsSecondStep(staff, false, { emailVerified: true, mailConfigured: true })).toBe(true);
    // the code could not arrive → not asked (no lock-out)
    expect(needsSecondStep(staff, false, { emailVerified: true, mailConfigured: false })).toBe(false);
    expect(needsSecondStep(staff, false, { emailVerified: false, mailConfigured: true })).toBe(false);
    expect(needsSecondStep({ role: 'viewer', totpEnabled: true }, true)).toBe(true);
  });

  it('a held employee reaches only sign-in, account-email, their own /users/me and the settings read', () => {
    expect(accountEmailGateAllows('GET', '/api/auth/security/account-email')).toBe(true);
    expect(accountEmailGateAllows('POST', '/api/auth/security/account-email/confirm')).toBe(true);
    expect(accountEmailGateAllows('POST', '/api/auth/logout')).toBe(true);
    expect(accountEmailGateAllows('GET', '/api/auth/me?x=1')).toBe(true);
    expect(accountEmailGateAllows('POST', '/api/users/me/onboarding-done')).toBe(true);
    expect(accountEmailGateAllows('GET', '/api/settings')).toBe(true);
    expect(accountEmailGateAllows('PUT', '/api/settings')).toBe(false);
    expect(accountEmailGateAllows('GET', '/api/transactions/startup-overview')).toBe(false);
    expect(accountEmailGateAllows('GET', '/api/users')).toBe(false);
    expect(accountEmailGateAllows('GET', '/api/users/meta')).toBe(false);
    expect(accountEmailGateAllows('GET', '/api/authx')).toBe(false);
  });

  const ctx = (user: any, method = 'GET', url = '/api/transactions') => {
    const req: any = { user, method, originalUrl: url };
    return { req, context: { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as any };
  };
  const run = (gate: AccountEmailGateInterceptor, c: any) => {
    try { return lastValueFrom(gate.intercept(c.context, { handle: () => of('ok') })); } catch (e) { return Promise.reject(e); }
  };

  it('refuses a held employee with ACCOUNT_EMAIL_REQUIRED and marks the request for the abuse counter', async () => {
    const gate = new AccountEmailGateInterceptor({ configured: () => true } as any);
    const held = ctx({ role: 'staff', emailVerified: false }, 'POST', '/api/transactions');
    await expect(run(gate, held)).rejects.toMatchObject({ response: { code: 'ACCOUNT_EMAIL_REQUIRED' } });
    expect(held.req._accountEmailHeld).toBe(true);
    await expect(run(gate, ctx({ role: 'staff', emailVerified: false }, 'POST', '/api/auth/security/account-email/send'))).resolves.toBe('ok');
    await expect(run(gate, ctx({ role: 'staff', emailVerified: true }))).resolves.toBe('ok');
    await expect(run(gate, ctx({ role: 'admin', emailVerified: false }))).resolves.toBe('ok');
    await expect(run(gate, ctx(undefined))).resolves.toBe('ok');
    // without mail nothing can be confirmed, so nobody is held
    await expect(run(new AccountEmailGateInterceptor({ configured: () => false } as any), ctx({ role: 'staff', emailVerified: false }))).resolves.toBe('ok');
  });
});
