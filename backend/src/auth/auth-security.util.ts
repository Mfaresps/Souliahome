import * as crypto from 'crypto';

/**
 * Sign-in verification rules — pure (Nov 27, 2026).
 *
 * A password alone never finishes the sign-in of an account that needs a second step. The
 * password step creates a CHALLENGE (a random token the browser holds, stored hashed); every
 * second-step route takes that token. A challenge is the only way to reach the second step, so a
 * Google code, an email code or an approval can never stand in for the password.
 */

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
// Owner's rule (Nov 27, 2026): an emailed code lives 5 minutes, is used once, 5 attempts, stored hashed.
export const EMAIL_CODE_TTL_MS = 5 * 60_000;
export const EMAIL_RESEND_GAP_MS = 60_000;
export const EMAIL_MAX_PER_CHALLENGE = 3;
export const EMAIL_MAX_PER_HOUR = 5;
export const APPROVAL_TTL_MS = 2 * 60_000;
export const TRUST_DAYS = 30;
export const BACKUP_CODE_COUNT = 10;
export const MIN_PASSWORD_LENGTH = 8;

export type VerifyMethod = 'totp' | 'email' | 'approval' | 'backup';
export type ChallengePurpose = 'login' | 'reset' | 'stepup' | 'unlock';

/**
 * Sensitive settings a signed-in admin changes only after confirming it is them again with a
 * second factor («تأكيد الهوية»): Google Authenticator or a code to the CURRENT security email.
 */
export type StepUpAction = 'system-pin' | 'security-email' | 'totp-disable' | 'password-change' | 'staff-password';
export const STEP_UP_ACTIONS: StepUpAction[] = ['system-pin', 'security-email', 'totp-disable', 'password-change', 'staff-password'];

/** Step-up: any one factor the account has (never a backup code). Null = it has none. */
export function stepUpRequirement(m: { totp: boolean; email: boolean }): VerifyMethod[][] | null {
  const any: VerifyMethod[] = [];
  if (m.totp) any.push('totp');
  if (m.email) any.push('email');
  return any.length ? [any] : null;
}

export interface AvailableMethods {
  totp: boolean;
  email: boolean;
  approval: boolean;
  backup: boolean;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** A one-time code is stored only as this hash, bound to its challenge. */
export function codeHash(secret: string, challengeId: string, code: string): string {
  return crypto.createHmac('sha256', String(secret || 'soulia')).update(`${challengeId}:${code}`).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomCode6(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Digits only; Arabic-Indic and Persian digits become Latin. */
export function normalizeDigits(value: unknown): string {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

export function isValidEmail(value: unknown): boolean {
  const v = String(value ?? '').trim();
  return v.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * «mf*****s@gmail.com» — enough to recognise the address, not enough to learn it (owner, Nov 27: part of
 * it, the rest stars). ⚠ Same format as `maskMail` in auth-security.js (the Settings card).
 */
export function maskEmail(value: unknown): string {
  const v = normalizeEmail(value);
  const at = v.indexOf('@');
  if (at < 1) return '';
  const name = v.slice(0, at);
  const shown = name.length <= 3 ? name[0] : name.slice(0, 2);
  const tail = name.length > 3 ? name.slice(-1) : '';
  return `${shown}*****${tail}@${v.slice(at + 1)}`;
}

/** Who must pass a second step: admins always; others only when 2FA is on and they set it up. */
export function needsSecondStep(user: { role?: string; totpEnabled?: boolean }, global2fa: boolean): boolean {
  if (user?.role === 'admin') return true;
  return !!global2fa && !!user?.totpEnabled;
}

/** Sign-in: any one available method. */
export function loginRequirement(m: AvailableMethods): VerifyMethod[][] {
  const any: VerifyMethod[] = [];
  if (m.totp) any.push('totp');
  if (m.email) any.push('email');
  if (m.approval) any.push('approval');
  if (m.backup) any.push('backup');
  return any.length ? [any] : [];
}

/**
 * Password reset (admin accounts): both factors the account has. Email + Google → both (a
 * backup code may stand for Google); one of them → that one; none → no reset from the page.
 */
/**
 * Admin password recovery (owner's rule, Nov 27, 2026): a code to the REGISTERED email always comes first,
 * then Google Authenticator (or a backup code) when it is on. No email → no recovery from the sign-in page.
 */
export function resetRequirement(m: { totp: boolean; email: boolean; backup: boolean }): VerifyMethod[][] | null {
  if (!m.email) return null;
  const second: VerifyMethod[] = m.totp ? (m.backup ? ['totp', 'backup'] : ['totp']) : [];
  return second.length ? [['email'], second] : [['email']];
}

/** A random password for a staff account (owner: 12+ characters; shown to the admin once). */
export function generateStrongPassword(length = 14): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%*?-_'];
  const all = sets.join('');
  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  const out = sets.map(pick);
  while (out.length < Math.max(12, length)) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

/** Groups still open after `done`. */
export function openGroups(requirement: string[][], done: string[]): string[][] {
  const d = new Set(done || []);
  return (requirement || []).filter((group) => !group.some((m) => d.has(m)));
}

export function requirementMet(requirement: string[][], done: string[]): boolean {
  return Array.isArray(requirement) && requirement.length > 0 && openGroups(requirement, done).length === 0;
}

/** Is this method allowed by any still-open group? */
export function methodAllowed(requirement: string[][], done: string[], method: string): boolean {
  return openGroups(requirement, done).some((g) => g.includes(method));
}

/** Number matching: the new device shows `number`; the approver picks it among three. */
export function approvalNumbers(): { number: string; choices: string[] } {
  const pick = () => String(crypto.randomInt(10, 100));
  const number = pick();
  const set = new Set([number]);
  while (set.size < 3) set.add(pick());
  const choices = [...set];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { number, choices };
}

/** A TOTP time step may be used once: only a step newer than the last one used is accepted. */
export function totpStepFresh(lastStep: number | null | undefined, step: number): boolean {
  return !(typeof lastStep === 'number' && Number.isFinite(lastStep)) || step > lastStep;
}

const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten codes like «k7pd-3mxa», each usable once. Shown once; only hashes are kept. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const one = () => {
    let s = '';
    for (let i = 0; i < 8; i++) s += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  };
  const set = new Set<string>();
  while (set.size < count) set.add(one());
  return [...set];
}

export function normalizeBackupCode(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashBackupCode(value: unknown): string {
  return sha256('backup:' + normalizeBackupCode(value));
}

export function passwordProblem(pw: unknown): string | null {
  const v = String(pw ?? '');
  if (v.length < MIN_PASSWORD_LENGTH) return `يجب أن تتكون كلمة المرور من ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`;
  if (v.length > 200) return 'كلمة المرور طويلة جدًا';
  return null;
}

/** «Chrome · Windows · Desktop» */
export function deviceLabel(client?: { browser?: string; os?: string; device?: string } | null): string {
  const parts = [client?.browser, client?.os, client?.device].map((v) => String(v || '').trim()).filter(Boolean);
  return parts.join(' · ') || 'جهاز غير معروف';
}
