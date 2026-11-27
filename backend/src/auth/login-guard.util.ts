import * as crypto from 'crypto';

/**
 * Password-guessing protection («الحماية من تخمين كلمة المرور», Nov 27, 2026) — pure rules.
 *
 * ⚠ Owner's rule: a lock falls on the SOURCE that is guessing (account + IP, or account + trusted
 * device), never on the account itself — otherwise anyone typing wrong passwords on «admin» would
 * shut the real admin out. The owner keeps signing in from a trusted device, unlocks a locked
 * source with a code (email / Google / backup), or an admin lifts it.
 */

/** Failures from one source before the «not a robot» check (proof of work) is required. */
export const POW_AFTER = 3;
/** Failures from one source before it is locked. */
export const LOCK_AFTER = 5;
/** Lock lengths, doubling on repeat within 24 hours. */
export const LOCK_STEPS_MIN = [15, 30, 60];
/** Failures from one source in 24 hours before it is blocked until an admin or the owner lifts it. */
export const HARD_BLOCK_PER_DAY = 10;
/** One IP, any accounts. */
export const IP_FAIL_LIMIT = 20;
export const IP_FAIL_WINDOW_MS = 15 * 60_000;
export const IP_BLOCK_MS = 15 * 60_000;
/** Every login request from one IP, whatever the result. */
export const IP_REQUESTS_PER_MIN = 30;
/** One account, all sources: «under attack» — robot check for everyone, trusted devices verify too. */
export const ACCOUNT_ATTACK_FAILS = 20;
export const ACCOUNT_ATTACK_WINDOW_MS = 60 * 60_000;
export const ACCOUNT_ATTACK_MS = 60 * 60_000;
/** «لست أنا» on an alert: that source is blocked and the account stays under attack this long. */
export const NOT_ME_ATTACK_MS = 24 * 3_600_000;
/** Proof of work: leading zero bits of SHA-256(challenge:nonce). 15 bits ≈ 33k hashes ≈ 0.3–1 s. */
export const POW_DIFFICULTY = 15;
export const POW_TTL_MS = 5 * 60_000;

/** The one message for a wrong username OR a wrong password — it reveals neither, nor attempts left. */
export const GENERIC_LOGIN_ERROR = 'بيانات الدخول غير صحيحة.';

export function userKeyOf(username: unknown): string {
  return String(username ?? '').trim().toLowerCase().slice(0, 100);
}

/** Level 1..3 → 15 / 30 / 60 minutes. */
export function lockMinutesForLevel(level: number): number {
  const i = Math.max(1, Math.min(LOCK_STEPS_MIN.length, Math.floor(level || 1))) - 1;
  return LOCK_STEPS_MIN[i];
}

/** A lock within 24 hours of the previous one goes one step longer; after that it starts again. */
export function nextLockLevel(prevLevel: number | null | undefined, lastLockAt: Date | string | null | undefined, now: Date): number {
  const last = lastLockAt ? new Date(lastLockAt).getTime() : 0;
  if (!prevLevel || !last || now.getTime() - last > 24 * 3_600_000) return 1;
  return Math.min(LOCK_STEPS_MIN.length, prevLevel + 1);
}

export function countSince(times: (Date | string)[] | null | undefined, windowMs: number, now: Date): number {
  const from = now.getTime() - windowMs;
  return (times || []).filter((t) => new Date(t).getTime() > from).length;
}

export function minutesUntil(until: Date | string | null | undefined, now: Date): number {
  if (!until) return 0;
  const ms = new Date(until).getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export function lockedMessage(minutes: number): string {
  return `تم إيقاف محاولات تسجيل الدخول من هذا الجهاز مؤقتًا. حاول مرة أخرى بعد ${minutes} دقيقة.`;
}
export const BLOCKED_MESSAGE = 'تم حظر محاولات تسجيل الدخول من هذا الجهاز بعد محاولات غير صحيحة متكررة. تواصل مع مدير النظام أو افتح القفل برمز التحقق.';

// ── proof of work («لست برنامجًا آليًا») ────────────────────────────────────

export function leadingZeroBits(buf: Buffer | Uint8Array): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    let b = byte;
    while ((b & 0x80) === 0) { bits++; b <<= 1; }
    break;
  }
  return bits;
}

/** A signed, short-lived challenge bound to who is signing in and from where. */
export function powIssue(secret: string, bind: string, now = Date.now(), difficulty = POW_DIFFICULTY) {
  const body = Buffer.from(JSON.stringify({ b: crypto.createHash('sha256').update(bind).digest('hex').slice(0, 24), e: now + POW_TTL_MS, r: crypto.randomBytes(8).toString('hex'), d: difficulty })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { challenge: `${body}.${sig}`, difficulty };
}

/** Valid signature, same binding, not expired, and enough work. (Single use is the caller's job.) */
export function powCheck(secret: string, bind: string, challenge: unknown, nonce: unknown, now = Date.now()): boolean {
  const c = String(challenge || ''), n = String(nonce ?? '');
  if (!c || !n || n.length > 20) return false;
  const [body, sig] = c.split('.');
  if (!body || !sig) return false;
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return false;
  let p: { b: string; e: number; d: number };
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return false; }
  if (!p || p.b !== crypto.createHash('sha256').update(bind).digest('hex').slice(0, 24) || !(p.e > now)) return false;
  return leadingZeroBits(crypto.createHash('sha256').update(`${c}:${n}`).digest()) >= Math.max(1, Number(p.d) || POW_DIFFICULTY);
}
