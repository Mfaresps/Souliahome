/**
 * Failed sign-ins pause NEW sign-ins to the account for a while; they never disable it.
 *
 * Disabling after 4 wrong passwords let anyone who typed a username (e.g. «admin») shut that
 * person out — current sessions included, since a disabled account is refused on every
 * request — until another admin re-enabled it. A pause cannot be turned into that: open
 * sessions keep working, it ends by itself, and an admin can lift it early.
 */
export const MAX_LOGIN_ATTEMPTS = 4;

/** 15 → 30 → 60 minutes, then 60 for every further pause. */
const LOCK_MINUTES = [15, 30, 60];

/** A pause older than this no longer counts towards a longer one. */
const LEVEL_MEMORY_MS = 24 * 60 * 60 * 1000;

export function lockMinutesFor(level: number): number {
  return LOCK_MINUTES[Math.min(Math.max(0, level), LOCK_MINUTES.length - 1)];
}

/** The level of the pause about to start, given the previous one. */
export function nextLockLevel(prevLevel: number | undefined, prevStartedAt: Date | null | undefined, now: Date): number {
  const started = prevStartedAt ? new Date(prevStartedAt).getTime() : 0;
  if (!started || now.getTime() - started > LEVEL_MEMORY_MS) return 0;
  return Math.max(0, Number(prevLevel) || 0) + 1;
}

/** Minutes left on an active pause (rounded up), or 0 when the account is not paused. */
export function minutesLeft(lockedUntil: Date | null | undefined, now: Date): number {
  const until = lockedUntil ? new Date(lockedUntil).getTime() : 0;
  if (!until || until <= now.getTime()) return 0;
  return Math.ceil((until - now.getTime()) / 60000);
}
