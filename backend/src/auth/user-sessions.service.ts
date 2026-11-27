import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import * as crypto from 'crypto';
import type { ClientContext } from '../shared/client-context.util';
import { fetchGeo } from '../shared/geo-lookup.util';
import {
  SESSION_RETENTION_DAYS,
  SessionEndReason,
  SessionMethod,
  SessionRow,
  deviceKey,
  endedMessage,
  presentSession,
} from './user-sessions.util';

export const USER_SESSIONS_COLLECTION = 'usersessions';

/** How long a «still valid» answer is trusted before the row is read again. */
const STATE_CACHE_MS = 30_000;
/** `lastSeenAt` is written at most once a minute per session. */
const TOUCH_EVERY_MS = 60_000;

/** ⚠ Not a discriminated union: ts-jest does not narrow it (see memory: ts-jest stricter than build). */
type CheckResult = { ok: boolean; message: string };

interface Actor { id: string; name: string }

/**
 * Sign-in sessions (Nov 27, 2026). One row per successful sign-in, in a raw collection
 * (`usersessions`). ⚠ The token carries the row id (`sid`); JwtStrategy and the socket
 * handshake refuse a token whose row has ended, so ending a row signs that device out at once.
 * One process: the in-memory cache is cleared by every end, so a revoke is immediate.
 */
@Injectable()
export class UserSessionsService implements OnModuleInit {
  private readonly logger = new Logger(UserSessionsService.name);
  private readonly state = new Map<string, { result: CheckResult; userId: string; at: number }>();
  private readonly touched = new Map<string, number>();

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get col() {
    return this.connection.collection<SessionRow & { deviceKey: string }>(USER_SESSIONS_COLLECTION);
  }

  async onModuleInit() {
    try {
      await this.col.createIndex({ userId: 1, createdAt: -1 });
      await this.col.createIndex({ endedAt: 1, expiresAt: 1 });
      await this.col.createIndex({ createdAt: -1 });
      await this.col.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    } catch (e) {
      this.logger.warn(`session indexes: ${(e as Error).message}`);
    }
  }

  newSessionId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  async create(input: {
    sid: string;
    user: { _id: unknown; username?: string; name?: string; role?: string };
    client?: ClientContext;
    method: SessionMethod;
    expiresAt: Date;
  }): Promise<void> {
    const now = new Date();
    const userId = String(input.user._id);
    const base = {
      device: input.client?.device || '',
      browser: input.client?.browser || '',
      os: input.client?.os || '',
    };
    const key = deviceKey(base);
    // «جهاز جديد» = this account never signed in from this kind of device/browser/system before.
    const seen = await this.col.findOne({ userId, deviceKey: key }, { projection: { _id: 1 } });
    const previous = await this.col.countDocuments({ userId }, { limit: 1 });
    const ip = input.client?.ipAddress || '';
    await this.col.insertOne({
      _id: input.sid,
      userId,
      username: input.user.username || '',
      name: input.user.name || '',
      role: input.user.role || '',
      method: input.method,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      purgeAt: new Date(now.getTime() + SESSION_RETENTION_DAYS * 86_400_000),
      ip,
      userAgent: (input.client?.userAgent || '').slice(0, 400),
      ...base,
      deviceKey: key,
      location: null,
      newDevice: !seen && previous > 0,
      endedAt: null,
      endReason: null,
      endedBy: null,
    });
    this.state.set(input.sid, { result: { ok: true, message: '' }, userId, at: Date.now() });
    this.touched.set(input.sid, Date.now());
    fetchGeo(ip)
      .then((loc) => (loc ? this.col.updateOne({ _id: input.sid }, { $set: { location: loc } }) : null))
      .catch(() => undefined);
  }

  /** Is this session still allowed? Called on every authenticated request and socket. */
  async check(sid: string, userId: string): Promise<CheckResult> {
    const cached = this.state.get(sid);
    const now = Date.now();
    if (cached && cached.userId === userId && (!cached.result.ok || now - cached.at < STATE_CACHE_MS)) {
      if (cached.result.ok) this.touch(sid);
      return cached.result;
    }
    const row = await this.col.findOne({ _id: sid });
    let result: CheckResult;
    if (!row || row.userId !== userId) result = { ok: false, message: endedMessage(null) };
    else if (row.endedAt) result = { ok: false, message: endedMessage(row) };
    else if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) result = { ok: false, message: endedMessage(null) };
    else result = { ok: true, message: '' };
    this.state.set(sid, { result, userId, at: now });
    if (result.ok) this.touch(sid);
    return result;
  }

  /** Records activity, at most once a minute. Never throws. */
  touch(sid: string): void {
    if (!sid) return;
    const now = Date.now();
    const last = this.touched.get(sid) || 0;
    if (now - last < TOUCH_EVERY_MS) return;
    this.touched.set(sid, now);
    this.col.updateOne({ _id: sid, endedAt: null }, { $set: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }

  async findOne(sid: string): Promise<SessionRow | null> {
    return this.col.findOne({ _id: sid });
  }

  /** Ends one session. Conditional: an already-ended row is returned unchanged (`changed:false`). */
  async end(sid: string, reason: SessionEndReason, by: Actor | null): Promise<{ changed: boolean; row: SessionRow | null }> {
    const endedAt = new Date();
    const res = await this.col.findOneAndUpdate(
      { _id: sid, endedAt: null },
      { $set: { endedAt, endReason: reason, endedBy: by } },
      { returnDocument: 'after' },
    );
    const row = (res as any)?.value !== undefined ? (res as any).value : res;
    if (row) {
      this.state.set(sid, { result: { ok: false, message: endedMessage(row) }, userId: row.userId, at: Date.now() });
      this.touched.delete(sid);
      return { changed: true, row };
    }
    const existing = await this.col.findOne({ _id: sid });
    return { changed: false, row: existing };
  }

  /**
   * Ends every open session of one account (except `exceptSid`) and, unless `keepLegacy`,
   * refuses tokens signed before sessions existed.
   */
  async endAllForUser(userId: string, by: Actor | null, opts: { exceptSid?: string; keepLegacy?: boolean } = {}): Promise<{ ended: string[] }> {
    const filter: Record<string, unknown> = { userId, endedAt: null, expiresAt: { $gt: new Date() } };
    if (opts.exceptSid) filter._id = { $ne: opts.exceptSid };
    const open = await this.col.find(filter, { projection: { _id: 1 } }).toArray();
    const ids = open.map((r) => r._id);
    if (ids.length) {
      const endedAt = new Date();
      await this.col.updateMany(
        { _id: { $in: ids }, endedAt: null },
        { $set: { endedAt, endReason: 'revoked-all', endedBy: by } },
      );
      const message = endedMessage({ endReason: 'revoked-all', endedBy: by });
      ids.forEach((sid) => {
        this.state.set(sid, { result: { ok: false, message }, userId, at: Date.now() });
        this.touched.delete(sid);
      });
    }
    if (!opts.keepLegacy && Types.ObjectId.isValid(userId)) {
      await this.connection.collection('users').updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { legacyTokensValidAfter: new Date() } },
      );
    }
    return { ended: ids };
  }

  /** Every account with its open sessions, last sign-in and device count. */
  async overview(onlineSids: Set<string>, onlineUserIds: Set<string>, currentSid = '') {
    const now = new Date();
    const users = await this.connection
      .collection('users')
      .find({}, { projection: { username: 1, name: 1, role: 1, avatar: 1, jobTitle: 1, isActive: 1, lastLogin: 1, lastSeen: 1 } })
      .toArray();
    const open = await this.col
      .find({ endedAt: null, expiresAt: { $gt: now } })
      .sort({ lastSeenAt: -1 })
      .toArray();
    const lastRows = await this.col
      .aggregate<{ _id: string; row: SessionRow; total: number; devices: string[] }>([
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', row: { $first: '$$ROOT' }, total: { $sum: 1 }, devices: { $addToSet: '$deviceKey' } } },
      ])
      .toArray();
    const lastBy = new Map(lastRows.map((r) => [r._id, r]));
    const openBy = new Map<string, SessionRow[]>();
    open.forEach((r) => {
      const list = openBy.get(r.userId) || [];
      list.push(r);
      openBy.set(r.userId, list);
    });
    const accounts = users.map((u) => {
      const id = String(u._id);
      const sessions = (openBy.get(id) || []).map((r) => presentSession(r, now, onlineSids.has(r._id), currentSid));
      const last = lastBy.get(id);
      return {
        userId: id,
        username: u.username || '',
        name: u.name || '',
        role: u.role || '',
        avatar: u.avatar || '',
        jobTitle: u.jobTitle || '',
        isActive: u.isActive !== false,
        online: onlineUserIds.has(id),
        lastSeen: u.lastSeen || null,
        activeCount: sessions.length,
        onlineCount: sessions.filter((s) => s.online).length,
        deviceCount: new Set(sessions.map((s) => deviceKey(s))).size,
        knownDevices: last ? last.devices.length : 0,
        loginCount: last ? last.total : 0,
        lastLogin: last ? presentSession(last.row, now, onlineSids.has(last.row._id), currentSid) : null,
        lastLoginAt: (last?.row.createdAt as Date | undefined) || u.lastLogin || null,
        sessions,
      };
    });
    return {
      generatedAt: now,
      retentionDays: SESSION_RETENTION_DAYS,
      totals: {
        activeSessions: open.length,
        signedInUsers: openBy.size,
        onlineSessions: open.filter((r) => onlineSids.has(r._id)).length,
        newDevices24h: await this.col.countDocuments({ newDevice: true, createdAt: { $gt: new Date(now.getTime() - 86_400_000) } }),
      },
      accounts,
    };
  }

  /** Login history (newest first). */
  async history(q: { userId?: string; status?: string; page?: number; limit?: number }, onlineSids: Set<string>, currentSid = '') {
    const now = new Date();
    const filter: Record<string, unknown> = {};
    if (q.userId) filter.userId = String(q.userId);
    if (q.status === 'active') Object.assign(filter, { endedAt: null, expiresAt: { $gt: now } });
    else if (q.status === 'logged-out') filter.endReason = 'logout';
    else if (q.status === 'revoked') filter.endReason = { $in: ['revoked', 'revoked-all', 'replaced'] };
    else if (q.status === 'expired') Object.assign(filter, { endedAt: null, expiresAt: { $lte: now } });
    else if (q.status === 'new-device') filter.newDevice = true;
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const page = Math.max(1, Number(q.page) || 1);
    const [rows, total] = await Promise.all([
      this.col.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      this.col.countDocuments(filter),
    ]);
    return {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      rows: rows.map((r) => presentSession(r, now, onlineSids.has(r._id), currentSid)),
    };
  }
}
