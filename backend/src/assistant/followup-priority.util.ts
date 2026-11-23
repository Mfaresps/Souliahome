/**
 * «مساعد SOULIA» — how urgent an open follow-up is, by how long it has waited. Pure (clock passed in).
 *
 * Waiting starts at `escalationBaseline` (reset whenever the status or reason changes — the same
 * start the follow-up reminders use for their 12h / 24h / 48h steps), else `createdAt`.
 * A follow-up deferred to a time still ahead is not late: it is «مؤجلة», the lowest priority.
 * Once that time passes, it waits from the deferral time.
 */

export type FollowUpLevel = 'urgent' | 'late' | 'due' | 'new' | 'deferred';

/** Higher = more important. */
export const LEVEL_RANK: Record<FollowUpLevel, number> = { urgent: 4, late: 3, due: 2, new: 1, deferred: 0 };

const HOUR = 3600_000;

export interface FollowUpUrgency {
  level: FollowUpLevel;
  /** Hours waited (0 for a deferred follow-up). */
  hours: number;
  /** Deferred until (ms), when level is 'deferred'. */
  until?: number;
}

const ms = (v: unknown): number => {
  const n = v instanceof Date ? v.getTime() : v ? new Date(v as any).getTime() : NaN;
  return Number.isFinite(n) ? n : NaN;
};

export function followUpUrgency(f: { escalationBaseline?: unknown; createdAt?: unknown; deferredUntil?: unknown }, now: number): FollowUpUrgency {
  const deferred = ms(f.deferredUntil);
  if (Number.isFinite(deferred) && deferred > now) return { level: 'deferred', hours: 0, until: deferred };
  let since = ms(f.escalationBaseline);
  if (!Number.isFinite(since)) since = ms(f.createdAt);
  if (!Number.isFinite(since)) since = now;
  if (Number.isFinite(deferred) && deferred > since) since = deferred;
  const hours = Math.max(0, (now - since) / HOUR);
  const level: FollowUpLevel = hours >= 48 ? 'urgent' : hours >= 24 ? 'late' : hours >= 12 ? 'due' : 'new';
  return { level, hours };
}

/** The more urgent of two (same level → the one that waited longer). */
export function moreUrgent(a: FollowUpUrgency | null, b: FollowUpUrgency): FollowUpUrgency {
  if (!a) return b;
  if (LEVEL_RANK[b.level] !== LEVEL_RANK[a.level]) return LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;
  if (a.level === 'deferred') return (b.until || 0) < (a.until || 0) ? b : a; // the one due back sooner
  return b.hours > a.hours ? b : a;
}

/** Most urgent first; same level → longest wait (deferred: due back soonest); then more orders. */
export function compareUrgency(a: { u: FollowUpUrgency; orders: number }, b: { u: FollowUpUrgency; orders: number }): number {
  const r = LEVEL_RANK[b.u.level] - LEVEL_RANK[a.u.level];
  if (r) return r;
  if (a.u.level === 'deferred') return (a.u.until || 0) - (b.u.until || 0) || b.orders - a.orders;
  return b.u.hours - a.u.hours || b.orders - a.orders;
}
