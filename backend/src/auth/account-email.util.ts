/**
 * Employee account email — pure rules (Nov 27, 2026).
 *
 * Every non-admin account links one email address. An address counts only once its owner types the
 * 6-digit code sent to it; until then it is a pending request (`emailPending`) and is never used.
 * Admin accounts keep their own «بريد الأمان» (securityEmail, Settings ← الأمان) instead.
 *
 * Two ways a request starts:
 *  - the employee types the address (forced step after sign-in, or «حسابي») — code lives 5 minutes;
 *  - an admin types it (new account, or the user window) — code lives 48 hours, because the employee
 *    enters it at their next sign-in, which may be hours later.
 */
import { EMAIL_CODE_TTL_MS, isValidEmail, normalizeEmail } from './auth-security.util';

export const ACCOUNT_EMAIL_CODE_TTL_MS = EMAIL_CODE_TTL_MS;
export const ACCOUNT_EMAIL_INVITE_TTL_MS = 48 * 60 * 60_000;
export const ACCOUNT_EMAIL_RESEND_GAP_MS = 60_000;
export const ACCOUNT_EMAIL_MAX_PER_HOUR = 5;
export const ACCOUNT_EMAIL_MAX_ATTEMPTS = 5;

export interface AccountEmailPending {
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  sentAt: Date;
  requestedBy: { id: string; name: string } | null; // null = the employee asked
  requestedAt: Date;
}

/** The scope a code hash is bound to: one account, one address. */
export const accountEmailScope = (userId: string) => 'account-email:' + String(userId);

export function cleanAccountEmail(value: unknown): { email: string; problem: string | null } {
  const email = normalizeEmail(value);
  if (!email) return { email, problem: 'اكتب عنوان البريد الإلكتروني.' };
  if (!isValidEmail(email)) return { email, problem: 'عنوان البريد الإلكتروني غير صحيح.' };
  return { email, problem: null };
}

/** A verified address, or '' (an address without `emailVerifiedAt` was typed before verification existed). */
export function verifiedEmailOf(user: { email?: string; emailVerifiedAt?: Date | string | null } | null | undefined): string {
  if (!user?.email || !user?.emailVerifiedAt) return '';
  return normalizeEmail(user.email);
}

/** Must this account add an email before working? Non-admin, active, none verified, mail can be sent. */
export function accountEmailRequired(user: { role?: string; isActive?: boolean; email?: string; emailVerifiedAt?: any } | null | undefined, mailConfigured: boolean): boolean {
  if (!user || !mailConfigured) return false;
  if (user.role === 'admin' || user.isActive === false) return false;
  return !verifiedEmailOf(user);
}

/**
 * Sending limits per account: 60 s between two codes, 5 an hour (across every address, so switching
 * addresses does not reset the count). Returns the sends of the last hour to store back.
 */
export function accountEmailSendCheck(sends: Array<Date | string> | null | undefined, now: Date): { ok: boolean; waitSec: number; recent: Date[] } {
  const t = now.getTime();
  const recent = (Array.isArray(sends) ? sends : [])
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()) && t - d.getTime() < 60 * 60_000)
    .sort((a, b) => a.getTime() - b.getTime());
  const last = recent[recent.length - 1];
  if (last && t - last.getTime() < ACCOUNT_EMAIL_RESEND_GAP_MS) {
    return { ok: false, waitSec: Math.ceil((ACCOUNT_EMAIL_RESEND_GAP_MS - (t - last.getTime())) / 1000), recent };
  }
  if (recent.length >= ACCOUNT_EMAIL_MAX_PER_HOUR) {
    return { ok: false, waitSec: Math.ceil((recent[0].getTime() + 60 * 60_000 - t) / 1000), recent };
  }
  return { ok: true, waitSec: 0, recent };
}

/** What the page may know about an account's email (never the code hash). */
export function accountEmailView(user: any, now: Date = new Date()) {
  const p: AccountEmailPending | null = user?.emailPending?.email ? user.emailPending : null;
  const live = !!p && !!p.codeHash && new Date(p.expiresAt).getTime() > now.getTime();
  const last = Array.isArray(user?.emailCodeSends) && user.emailCodeSends.length ? new Date(user.emailCodeSends[user.emailCodeSends.length - 1]) : null;
  const resendIn = last ? Math.max(0, Math.ceil((ACCOUNT_EMAIL_RESEND_GAP_MS - (now.getTime() - last.getTime())) / 1000)) : 0;
  return {
    email: verifiedEmailOf(user),
    verifiedAt: user?.emailVerifiedAt || null,
    unverifiedEmail: !verifiedEmailOf(user) && user?.email ? normalizeEmail(user.email) : '',
    pending: p ? {
      email: normalizeEmail(p.email),
      sentAt: p.sentAt || null,
      expiresAt: p.expiresAt || null,
      codeLive: live,
      byAdmin: !!p.requestedBy,
      requestedBy: p.requestedBy?.name || '',
    } : null,
    resendIn,
  };
}
