import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as crypto from 'crypto';
import {
  ACCOUNT_ATTACK_FAILS, ACCOUNT_ATTACK_MS, ACCOUNT_ATTACK_WINDOW_MS, HARD_BLOCK_PER_DAY, IP_BLOCK_MS,
  IP_FAIL_LIMIT, IP_FAIL_WINDOW_MS, IP_REQUESTS_PER_MIN, LOCK_AFTER, NOT_ME_ATTACK_MS, POW_AFTER,
  countSince, lockMinutesForLevel, minutesUntil, nextLockLevel, powCheck, powIssue,
} from './login-guard.util';

export const LOGIN_GUARD_COLLECTION = 'loginguard';
export const LOGIN_ATTEMPTS_COLLECTION = 'loginattempts';
export const LOGIN_ALERTS_COLLECTION = 'loginalerts';
const DAY = 86_400_000;

/** Stored attempt results grouped for the admin filter (⚠ mirrored by _LA_GROUP in index.html). */
export const ATTEMPT_RESULT_GROUPS: Record<string, string[]> = {
  ok: ['password-ok'],
  failed: ['bad-credentials', 'disabled'],
  stopped: ['locked', 'blocked', 'rate-limited'],
  robot: ['pow-required', 'pow-failed', 'captcha-required', 'captcha-failed'],
};

interface GuardDoc {
  _id: string;
  kind: 'src' | 'ip' | 'acct';
  userKey?: string;
  sourceId?: string;
  ip?: string;
  device?: string;
  fails?: number;
  times?: Date[];
  lockedUntil?: Date | null;
  lockLevel?: number;
  lastLockAt?: Date | null;
  hard?: boolean;
  hardAt?: Date | null;
  blockedUntil?: Date | null;
  attackUntil?: Date | null;
  updatedAt: Date;
  purgeAt: Date;
}

export interface GuardState {
  lockedMinutes: number;
  hard: boolean;
  ipBlockedMinutes: number;
  powRequired: boolean;
  underAttack: boolean;
}

export interface FailOutcome {
  lockedMinutes: number;
  hard: boolean;
  newlyLocked: boolean;
  newlyHard: boolean;
  attackStarted: boolean;
}

/**
 * Login guard (Nov 27, 2026). Rules: login-guard.util.ts. Raw collections:
 * - `loginguard`  — one doc per source (`src:<user>|<ip:…|dev:…>`), per IP (`ip:<ip>`) and per
 *   account (`acct:<user>`). Each failure is one atomic update; a lock starts once (conditional).
 * - `loginattempts` — every sign-in attempt, success or failure (TTL 180 days).
 * - `loginalerts` — «هل هذا أنت؟» for the owner when a source is locked (TTL 30 days).
 * Keys use the typed username (lower-cased), so an unknown username is handled exactly like a real
 * one — the replies reveal nothing about which accounts exist.
 */
@Injectable()
export class LoginGuardService implements OnModuleInit {
  private readonly logger = new Logger(LoginGuardService.name);
  private readonly ipRequests = new Map<string, number[]>();
  private readonly usedPow = new Map<string, number>();

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get col() { return this.connection.collection<GuardDoc>(LOGIN_GUARD_COLLECTION); }
  private get attempts() { return this.connection.collection(LOGIN_ATTEMPTS_COLLECTION); }
  private get alerts() { return this.connection.collection(LOGIN_ALERTS_COLLECTION); }

  async onModuleInit() {
    try {
      await this.col.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
      await this.col.createIndex({ userKey: 1, kind: 1 });
      await this.attempts.createIndex({ at: -1 });
      await this.attempts.createIndex({ userKey: 1, at: -1 });
      await this.attempts.createIndex({ ip: 1, at: -1 });
      await this.attempts.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
      await this.alerts.createIndex({ userId: 1, createdAt: -1 });
      await this.alerts.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    } catch (e) {
      this.logger.warn(`login guard indexes: ${(e as Error).message}`);
    }
  }

  static srcId(userKey: string, sourceId: string) { return `src:${userKey}|${sourceId}`; }

  /** Every login request from an IP, whatever the result (in memory, one process). */
  overIpRate(ip: string, now = Date.now()): boolean {
    const key = ip || 'unknown';
    const list = (this.ipRequests.get(key) || []).filter((t) => now - t < 60_000);
    list.push(now);
    this.ipRequests.set(key, list);
    if (this.ipRequests.size > 5000) for (const [k, v] of this.ipRequests) if (!v.some((t) => now - t < 60_000)) this.ipRequests.delete(k);
    return list.length > IP_REQUESTS_PER_MIN;
  }

  async state(userKey: string, sourceId: string, ip: string, trusted: boolean, now = new Date()): Promise<GuardState> {
    const ids = [LoginGuardService.srcId(userKey, sourceId), `acct:${userKey}`, ...(trusted ? [] : [`ip:${ip}`])];
    const docs = await this.col.find({ _id: { $in: ids } }).toArray();
    const src = docs.find((d) => d.kind === 'src');
    const acct = docs.find((d) => d.kind === 'acct');
    const ipDoc = docs.find((d) => d.kind === 'ip');
    const underAttack = !!acct?.attackUntil && new Date(acct.attackUntil).getTime() > now.getTime();
    const ipRecent = countSince(ipDoc?.times, IP_FAIL_WINDOW_MS, now);
    return {
      lockedMinutes: minutesUntil(src?.lockedUntil, now),
      hard: !!src?.hard,
      ipBlockedMinutes: trusted ? 0 : minutesUntil(ipDoc?.blockedUntil, now),
      powRequired: !trusted && ((src?.fails || 0) >= POW_AFTER || underAttack || ipRecent >= POW_AFTER * 2),
      underAttack,
    };
  }

  /** One wrong password (or unknown username) from a source. */
  async fail(input: { userKey: string; sourceId: string; ip: string; device: string; trusted: boolean }, now = new Date()): Promise<FailOutcome> {
    const purgeAt = new Date(now.getTime() + 30 * DAY);
    const id = LoginGuardService.srcId(input.userKey, input.sourceId);
    const res: any = await this.col.findOneAndUpdate(
      { _id: id },
      {
        $inc: { fails: 1 },
        $push: { times: { $each: [now], $slice: -40 } },
        $set: { kind: 'src', userKey: input.userKey, sourceId: input.sourceId, ip: input.ip, device: input.device, updatedAt: now, purgeAt },
      } as any,
      { upsert: true, returnDocument: 'after' },
    );
    const doc: GuardDoc = res && res.value !== undefined ? res.value : res;
    const out: FailOutcome = { lockedMinutes: minutesUntil(doc?.lockedUntil, now), hard: !!doc?.hard, newlyLocked: false, newlyHard: false, attackStarted: false };

    if (!doc?.hard && countSince(doc?.times, DAY, now) >= HARD_BLOCK_PER_DAY) {
      const r = await this.col.updateOne({ _id: id, hard: { $ne: true } }, { $set: { hard: true, hardAt: now, lockedUntil: null, fails: 0 } });
      if (r.modifiedCount) { out.hard = true; out.newlyHard = true; out.lockedMinutes = 0; }
    } else if (!doc?.hard && (doc?.fails || 0) >= LOCK_AFTER) {
      const level = nextLockLevel(doc.lockLevel, doc.lastLockAt, now);
      const minutes = lockMinutesForLevel(level);
      // Conditional on the count: simultaneous failures start one lock, not several longer ones.
      const r = await this.col.updateOne(
        { _id: id, fails: { $gte: LOCK_AFTER } },
        { $set: { fails: 0, lockedUntil: new Date(now.getTime() + minutes * 60_000), lockLevel: level, lastLockAt: now } },
      );
      if (r.modifiedCount) { out.newlyLocked = true; out.lockedMinutes = minutes; }
    }

    if (!input.trusted && input.ip) {
      const ipRes: any = await this.col.findOneAndUpdate(
        { _id: `ip:${input.ip}` },
        { $push: { times: { $each: [now], $slice: -60 } }, $set: { kind: 'ip', ip: input.ip, updatedAt: now, purgeAt } } as any,
        { upsert: true, returnDocument: 'after' },
      );
      const ipDoc: GuardDoc = ipRes && ipRes.value !== undefined ? ipRes.value : ipRes;
      if (countSince(ipDoc?.times, IP_FAIL_WINDOW_MS, now) >= IP_FAIL_LIMIT && !minutesUntil(ipDoc?.blockedUntil, now)) {
        await this.col.updateOne({ _id: `ip:${input.ip}` }, { $set: { blockedUntil: new Date(now.getTime() + IP_BLOCK_MS) } });
      }
    }

    const acctRes: any = await this.col.findOneAndUpdate(
      { _id: `acct:${input.userKey}` },
      { $push: { times: { $each: [now], $slice: -80 } }, $set: { kind: 'acct', userKey: input.userKey, updatedAt: now, purgeAt } } as any,
      { upsert: true, returnDocument: 'after' },
    );
    const acct: GuardDoc = acctRes && acctRes.value !== undefined ? acctRes.value : acctRes;
    if (countSince(acct?.times, ACCOUNT_ATTACK_WINDOW_MS, now) >= ACCOUNT_ATTACK_FAILS && !minutesUntil(acct?.attackUntil, now)) {
      const r = await this.col.updateOne(
        { _id: `acct:${input.userKey}`, $or: [{ attackUntil: null }, { attackUntil: { $exists: false } }, { attackUntil: { $lte: now } }] },
        { $set: { attackUntil: new Date(now.getTime() + ACCOUNT_ATTACK_MS) } },
      );
      out.attackStarted = r.modifiedCount > 0;
    }
    return out;
  }

  /** A right password from a source: its failure count starts again (the 24-hour count stays). */
  async success(userKey: string, sourceId: string): Promise<void> {
    await this.col.updateOne({ _id: LoginGuardService.srcId(userKey, sourceId), hard: { $ne: true } }, { $set: { fails: 0, lockedUntil: null } });
  }

  /** The owner proved who they are (code) or said «هذا أنا»: this source and its IP start clean. */
  async clearSource(userKey: string, sourceId: string, ip?: string): Promise<void> {
    await this.col.deleteOne({ _id: LoginGuardService.srcId(userKey, sourceId) });
    if (ip) await this.col.updateOne({ _id: `ip:${ip}` }, { $set: { times: [], blockedUntil: null } });
  }

  /** An admin's «إلغاء الحظر»: every source of the account, and its «under attack» flag. */
  async clearAllForUser(userKey: string): Promise<number> {
    const r = await this.col.deleteMany({ userKey, kind: { $in: ['src', 'acct'] } });
    return r.deletedCount || 0;
  }

  /** «لست أنا»: block the source and keep the account under attack for a day. */
  async markNotMe(userKey: string, sourceId: string, now = new Date()): Promise<void> {
    await this.col.updateOne({ _id: LoginGuardService.srcId(userKey, sourceId) }, { $set: { hard: true, hardAt: now, lockedUntil: null, kind: 'src', userKey, sourceId, updatedAt: now, purgeAt: new Date(now.getTime() + 30 * DAY) } }, { upsert: true });
    await this.col.updateOne({ _id: `acct:${userKey}` }, { $set: { kind: 'acct', userKey, attackUntil: new Date(now.getTime() + NOT_ME_ATTACK_MS), updatedAt: now, purgeAt: new Date(now.getTime() + 30 * DAY) } }, { upsert: true });
  }

  /** Active locks / blocks of an account (admin panel summary). */
  async activeForUser(userKey: string, now = new Date()) {
    const rows = await this.col.find({ userKey, kind: 'src', $or: [{ hard: true }, { lockedUntil: { $gt: now } }] }).toArray();
    return rows.map((r) => ({ sourceId: r.sourceId, ip: r.ip || '', device: r.device || '', hard: !!r.hard, until: r.lockedUntil || null }));
  }

  // ── proof of work ──────────────────────────────────────────────────────────
  private secret() { return String(process.env.JWT_SECRET || 'soulia') + ':pow'; }
  issuePow(bind: string) { return powIssue(this.secret(), bind); }
  /** Valid and never used before (one use per challenge). */
  usePow(bind: string, pow: { challenge?: string; nonce?: string } | null | undefined, now = Date.now()): boolean {
    if (!pow?.challenge) return false;
    for (const [k, exp] of this.usedPow) if (exp < now) this.usedPow.delete(k);
    if (this.usedPow.has(pow.challenge)) return false;
    if (!powCheck(this.secret(), bind, pow.challenge, pow.nonce, now)) return false;
    this.usedPow.set(pow.challenge, now + 10 * 60_000);
    return true;
  }

  // ── Cloudflare Turnstile (optional) ─────────────────────────────────────────
  // With both keys set, the robot check after repeated failures is Turnstile instead of the
  // proof of work. Without them (local copy, LAN) the proof of work stays.
  captchaSiteKey(): string {
    const site = String(process.env.TURNSTILE_SITE_KEY || '').trim();
    const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
    return site && secret ? site : '';
  }

  /**
   * 'ok' · 'bad' (no token, refused, used before — Cloudflare refuses a reused token) ·
   * 'unavailable' (Cloudflare could not be reached: the caller falls back to the proof of work,
   * so an outage there never locks everyone out).
   */
  async verifyCaptcha(token: string | undefined, ip: string, fetchImpl: typeof fetch = fetch): Promise<'ok' | 'bad' | 'unavailable'> {
    if (!token) return 'bad';
    const body = new URLSearchParams({ secret: String(process.env.TURNSTILE_SECRET_KEY || ''), response: token });
    if (ip) body.set('remoteip', ip);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: ctl.signal })
        .finally(() => clearTimeout(timer));
      if (!res.ok) return 'unavailable';
      const data: any = await res.json();
      if (!data?.success) return 'bad';
      if (data.action && data.action !== 'login') return 'bad';
      return 'ok';
    } catch (e) {
      this.logger.warn(`turnstile siteverify: ${(e as Error).message}`);
      return 'unavailable';
    }
  }

  // ── attempt log ─────────────────────────────────────────────────────────────
  async log(row: { username: string; userId?: string; ip: string; device?: string; browser?: string; os?: string; result: string; trusted?: boolean; sourceId?: string }, now = new Date()) {
    try {
      await this.attempts.insertOne({
        at: now, username: String(row.username || '').slice(0, 100), userKey: String(row.username || '').trim().toLowerCase().slice(0, 100),
        userId: row.userId || '', ip: row.ip || '', device: row.device || '', browser: row.browser || '', os: row.os || '',
        result: row.result, trusted: !!row.trusted, sourceId: row.sourceId || '', purgeAt: new Date(now.getTime() + 180 * DAY),
      });
    } catch { /* the log never changes the sign-in result */ }
  }

  /**
   * Admin screen «سجل محاولات الدخول». `q` = a username or IP prefix; `result` = one stored result or
   * a group (ATTEMPT_RESULT_GROUPS). `last24h` counts the last day whatever the filters.
   */
  async listAttempts(q: { q?: string; username?: string; ip?: string; result?: string; page?: number; limit?: number }, now = new Date()) {
    const filter: Record<string, unknown> = {};
    if (q.username) filter.userKey = String(q.username).trim().toLowerCase();
    if (q.ip) filter.ip = String(q.ip);
    const term = String(q.q || '').trim().toLowerCase().slice(0, 64);
    if (term) {
      const rx = new RegExp('^' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      filter.$or = [{ userKey: rx }, { ip: rx }];
    }
    if (q.result) {
      const group = ATTEMPT_RESULT_GROUPS[String(q.result)];
      filter.result = group ? { $in: group } : String(q.result);
    }
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const since = new Date(now.getTime() - DAY);
    const [rows, total, day] = await Promise.all([
      this.attempts.find(filter, { projection: { purgeAt: 0 } }).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      this.attempts.countDocuments(filter),
      this.attempts.aggregate([
        { $match: { at: { $gt: since } } },
        { $group: { _id: '$result', n: { $sum: 1 }, ips: { $addToSet: '$ip' } } },
      ]).toArray(),
    ]);
    const count = (g: string[]) => day.filter((d) => g.includes(String(d._id))).reduce((s, d) => s + d.n, 0);
    const failedIps = new Set(day.filter((d) => d._id !== 'password-ok').flatMap((d) => d.ips || []).filter(Boolean));
    const last24h = {
      total: day.reduce((s, d) => s + d.n, 0),
      ok: count(ATTEMPT_RESULT_GROUPS.ok),
      failed: count(ATTEMPT_RESULT_GROUPS.failed),
      stopped: count(ATTEMPT_RESULT_GROUPS.stopped),
      robot: count(ATTEMPT_RESULT_GROUPS.robot),
      failedIps: failedIps.size,
    };
    return { page, limit, total, rows, last24h, captcha: this.captchaSiteKey() ? 'turnstile' : 'pow' };
  }

  // ── «هل هذا أنت؟» alerts ───────────────────────────────────────────────────
  async createAlert(input: { userId: string; userKey: string; sourceId: string; ip: string; device: string; kind: 'locked' | 'blocked' }, now = new Date()) {
    // One open alert per source and day.
    const existing = await this.alerts.findOne({ userId: input.userId, sourceId: input.sourceId, status: 'pending', createdAt: { $gt: new Date(now.getTime() - DAY) } });
    if (existing) return { id: String(existing._id), created: false };
    const id = crypto.randomBytes(12).toString('hex');
    await this.alerts.insertOne({ _id: id as any, ...input, status: 'pending', createdAt: now, decidedAt: null, purgeAt: new Date(now.getTime() + 30 * DAY) });
    return { id, created: true };
  }

  async pendingAlerts(userId: string, now = new Date()) {
    const rows = await this.alerts.find({ userId, status: 'pending', createdAt: { $gt: new Date(now.getTime() - DAY) } }).sort({ createdAt: -1 }).limit(5).toArray();
    return rows.map((r: any) => ({ id: String(r._id), ip: r.ip, device: r.device, kind: r.kind, createdAt: r.createdAt }));
  }

  async decideAlert(userId: string, id: string, decision: 'me' | 'not-me', now = new Date()) {
    const res: any = await this.alerts.findOneAndUpdate(
      { _id: id as any, userId, status: 'pending' },
      { $set: { status: decision, decidedAt: now } },
      { returnDocument: 'after' },
    );
    return res && res.value !== undefined ? res.value : res;
  }
}
