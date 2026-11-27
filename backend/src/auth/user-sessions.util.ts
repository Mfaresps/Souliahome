/**
 * Sign-in sessions — pure rules (Nov 27, 2026).
 *
 * Every successful sign-in writes one `usersessions` row and puts its id (`sid`) in the token.
 * The row is both the live session (the server refuses a token whose row has ended) and the
 * login history (it is never deleted before `purgeAt`).
 */

export type SessionMethod = 'password' | 'totp' | 'trusted-device' | 'email' | 'approval' | 'backup';
export type SessionEndReason = 'logout' | 'revoked' | 'revoked-all' | 'replaced';
export type SessionStatus = 'active' | 'logged-out' | 'revoked' | 'expired';

export interface SessionRow {
  _id: string;
  userId: string;
  username: string;
  name: string;
  role: string;
  method: SessionMethod;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  purgeAt: Date;
  ip: string;
  userAgent: string;
  device: string;
  browser: string;
  os: string;
  location: { city?: string; region?: string; country?: string } | null;
  newDevice: boolean;
  endedAt?: Date | null;
  endReason?: SessionEndReason | null;
  endedBy?: { id: string; name: string } | null;
}

/** Login history is kept this long (TTL index on `purgeAt`). */
export const SESSION_RETENTION_DAYS = 120;

export function sessionStatus(row: Pick<SessionRow, 'endedAt' | 'endReason' | 'expiresAt'>, now = new Date()): SessionStatus {
  if (row.endedAt) return row.endReason === 'logout' ? 'logged-out' : 'revoked';
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** A device is the same device when its kind, browser and system match. */
export function deviceKey(row: Pick<SessionRow, 'device' | 'browser' | 'os'>): string {
  return [row.device || '', row.browser || '', row.os || ''].map((v) => v.trim().toLowerCase()).join('|');
}

/**
 * Why a token is refused. ⚠ The signed-out page does not print this sentence: user-sessions.js
 * (`endedKind`) reads its kind from «كل الأجهزة» / «تسجيل الخروج من هذه الجلسة» / «إنهاء جلستك»
 * and the name after «بواسطة … —», then writes its own text in the system language.
 * Keep those keywords if this wording changes.
 */
export function endedMessage(row: Pick<SessionRow, 'endReason' | 'endedBy'> | null): string {
  if (!row) return 'انتهت هذه الجلسة — سجّل الدخول مرة أخرى';
  if (row.endReason === 'logout') return 'تم تسجيل الخروج من هذه الجلسة — سجّل الدخول مرة أخرى';
  const by = row.endedBy?.name ? ` بواسطة ${row.endedBy.name}` : '';
  if (row.endReason === 'revoked-all') return `تم تسجيل الخروج من كل الأجهزة${by} — سجّل الدخول مرة أخرى`;
  return `تم إنهاء جلستك على هذا الجهاز${by} — سجّل الدخول مرة أخرى`;
}

/**
 * A token signed before sessions existed carries no `sid`. It keeps working (nobody is signed
 * out by the deploy) until the user's «خروج من كل الأجهزة» sets `legacyTokensValidAfter`.
 * `iat` is in seconds.
 */
export function legacyTokenAllowed(iatSeconds: number | undefined, validAfter: Date | string | null | undefined): boolean {
  if (!validAfter) return true;
  const after = new Date(validAfter).getTime();
  if (!Number.isFinite(after)) return true;
  if (!iatSeconds) return false;
  return iatSeconds * 1000 >= after;
}

/** The public shape of a session row (no user agent string, no purge date). */
export function presentSession(row: SessionRow, now = new Date(), online = false, currentSid = '') {
  return {
    id: row._id,
    userId: row.userId,
    username: row.username,
    name: row.name,
    role: row.role,
    method: row.method,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    ip: row.ip,
    device: row.device,
    browser: row.browser,
    os: row.os,
    location: row.location || null,
    newDevice: !!row.newDevice,
    status: sessionStatus(row, now),
    endedAt: row.endedAt || null,
    endReason: row.endReason || null,
    endedBy: row.endedBy || null,
    online,
    current: !!currentSid && row._id === currentSid,
  };
}
