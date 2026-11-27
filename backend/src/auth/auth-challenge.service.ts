import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import type { ClientContext } from '../shared/client-context.util';
import {
  APPROVAL_TTL_MS,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MS,
  ChallengePurpose,
  EMAIL_CODE_TTL_MS,
  EMAIL_MAX_PER_CHALLENGE,
  EMAIL_MAX_PER_HOUR,
  EMAIL_RESEND_GAP_MS,
  VerifyMethod,
  approvalNumbers,
  randomToken,
  sha256,
} from './auth-security.util';

export const AUTH_CHALLENGES_COLLECTION = 'authchallenges';

export interface ChallengeRow {
  _id: string; // sha256 of the browser's challenge token
  publicId: string; // 24 hex — names the request to the approving device; reveals nothing
  userId: string;
  username: string;
  name: string;
  role: string;
  purpose: ChallengePurpose;
  /** stepup only: the setting this confirmation unlocks (it cannot be spent on another). */
  action: string;
  requirement: VerifyMethod[][];
  done: VerifyMethod[];
  /** Forced Google Authenticator setup before the sign-in can finish (admin with no method). */
  setupRequired: boolean;
  client: Partial<ClientContext>;
  createdAt: Date;
  expiresAt: Date;
  purgeAt: Date;
  attempts: number;
  lockedAt: Date | null;
  completedAt: Date | null;
  email: { to: string; codeHash: string; expiresAt: Date | null; sends: Date[] } | null;
  approval: {
    status: 'pending' | 'approved' | 'denied';
    number: string;
    choices: string[];
    requestedAt: Date;
    expiresAt: Date;
    decidedAt: Date | null;
    decidedBy: { sid: string; deviceId: string; label: string } | null;
  } | null;
  resetReadyAt: Date | null;
}

export type ChallengeState = { ok: boolean; reason: '' | 'missing' | 'expired' | 'locked' | 'used'; row: ChallengeRow | null };

/**
 * Stores sign-in / reset challenges (raw collection `authchallenges`, Nov 27, 2026). Every state
 * change is one conditional update, so two tabs or two requests can never both spend one code,
 * pass one challenge twice, or count attempts wrongly.
 */
@Injectable()
export class AuthChallengeService implements OnModuleInit {
  private readonly logger = new Logger(AuthChallengeService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get col() {
    return this.connection.collection<ChallengeRow>(AUTH_CHALLENGES_COLLECTION);
  }

  async onModuleInit() {
    try {
      await this.col.createIndex({ publicId: 1 }, { unique: true });
      await this.col.createIndex({ userId: 1, createdAt: -1 });
      await this.col.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    } catch (e) {
      this.logger.warn(`challenge indexes: ${(e as Error).message}`);
    }
  }

  async create(input: {
    user: { _id: unknown; username?: string; name?: string; role?: string };
    purpose: ChallengePurpose;
    requirement: VerifyMethod[][];
    setupRequired?: boolean;
    action?: string;
    client?: ClientContext;
    now?: Date;
  }): Promise<{ token: string; row: ChallengeRow }> {
    const now = input.now || new Date();
    const token = randomToken(32);
    const row: ChallengeRow = {
      _id: sha256(token),
      publicId: randomToken(12),
      userId: String(input.user._id),
      username: input.user.username || '',
      name: input.user.name || '',
      role: input.user.role || '',
      purpose: input.purpose,
      action: input.action || '',
      requirement: input.requirement,
      done: [],
      setupRequired: !!input.setupRequired,
      client: {
        ipAddress: input.client?.ipAddress || '', browser: input.client?.browser || '',
        os: input.client?.os || '', device: input.client?.device || '',
      },
      createdAt: now,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      purgeAt: new Date(now.getTime() + 24 * 3_600_000),
      attempts: 0,
      lockedAt: null,
      completedAt: null,
      email: null,
      approval: null,
      resetReadyAt: null,
    };
    await this.col.insertOne(row);
    return { token, row };
  }

  /** The live challenge for a browser token. */
  async get(token: string, purpose?: ChallengePurpose, now = new Date()): Promise<ChallengeState> {
    const t = String(token || '');
    if (!/^[a-f0-9]{64}$/.test(t)) return { ok: false, reason: 'missing', row: null };
    const row = await this.col.findOne({ _id: sha256(t) });
    if (!row || (purpose && row.purpose !== purpose)) return { ok: false, reason: 'missing', row: null };
    if (row.completedAt) return { ok: false, reason: 'used', row };
    if (row.lockedAt) return { ok: false, reason: 'locked', row };
    if (new Date(row.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'expired', row };
    return { ok: true, reason: '', row };
  }

  async findByPublicId(publicId: string): Promise<ChallengeRow | null> {
    if (!/^[a-f0-9]{24}$/.test(String(publicId || ''))) return null;
    return this.col.findOne({ publicId: String(publicId) });
  }

  /** One wrong answer. Returns the attempts left; 0 = the challenge is now locked. */
  async fail(id: string): Promise<number> {
    const res: any = await this.col.findOneAndUpdate(
      { _id: id, lockedAt: null, completedAt: null },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    const row: ChallengeRow | null = res && res.value !== undefined ? res.value : res;
    if (!row) return 0;
    if (row.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      await this.col.updateOne({ _id: id, lockedAt: null }, { $set: { lockedAt: new Date() } });
      return 0;
    }
    return CHALLENGE_MAX_ATTEMPTS - row.attempts;
  }

  async markDone(id: string, method: VerifyMethod): Promise<ChallengeRow | null> {
    const res: any = await this.col.findOneAndUpdate(
      { _id: id, lockedAt: null, completedAt: null },
      { $addToSet: { done: method } },
      { returnDocument: 'after' },
    );
    return res && res.value !== undefined ? res.value : res;
  }

  async setDone(id: string, done: VerifyMethod[]): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { done } });
  }

  /** Spends the challenge. Only the first caller gets true. */
  async complete(id: string): Promise<boolean> {
    const res = await this.col.updateOne({ _id: id, completedAt: null, lockedAt: null }, { $set: { completedAt: new Date() } });
    return res.modifiedCount > 0;
  }

  async setSetupDone(id: string): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { setupRequired: false } });
  }

  async markResetReady(id: string): Promise<void> {
    await this.col.updateOne({ _id: id, completedAt: null }, { $set: { resetReadyAt: new Date() } });
  }

  /**
   * Reserves an email send: refused while the last one is under a minute old, after
   * EMAIL_MAX_PER_CHALLENGE on this challenge, or after EMAIL_MAX_PER_HOUR for the account.
   */
  async reserveEmail(row: ChallengeRow, to: string, codeHash: string, now = new Date()): Promise<{ ok: boolean; reason: '' | 'wait' | 'limit' | 'hourly'; waitSec: number }> {
    const sends = (row.email?.sends || []).map((d) => new Date(d).getTime());
    const last = sends.length ? Math.max(...sends) : 0;
    if (last && now.getTime() - last < EMAIL_RESEND_GAP_MS) {
      return { ok: false, reason: 'wait', waitSec: Math.ceil((EMAIL_RESEND_GAP_MS - (now.getTime() - last)) / 1000) };
    }
    if (sends.length >= EMAIL_MAX_PER_CHALLENGE) return { ok: false, reason: 'limit', waitSec: 0 };
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const recent = await this.col.aggregate<{ n: number }>([
      { $match: { userId: row.userId, createdAt: { $gt: new Date(now.getTime() - 2 * 3_600_000) } } },
      { $project: { n: { $size: { $filter: { input: { $ifNull: ['$email.sends', []] }, as: 's', cond: { $gt: ['$$s', hourAgo] } } } } } },
      { $group: { _id: null, n: { $sum: '$n' } } },
    ]).toArray();
    if ((recent[0]?.n || 0) >= EMAIL_MAX_PER_HOUR) return { ok: false, reason: 'hourly', waitSec: 0 };
    // Conditional on the number of sends read: two simultaneous requests send one email.
    const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);
    // ⚠ Mongo cannot $set a path inside a null field — the first send writes the whole object.
    const res = sends.length === 0 && !row.email
      ? await this.col.updateOne(
        { _id: row._id, completedAt: null, lockedAt: null, email: null },
        { $set: { email: { to, codeHash, expiresAt, sends: [now] } } },
      )
      : await this.col.updateOne(
        { _id: row._id, completedAt: null, lockedAt: null, 'email.sends': { $size: sends.length } },
        { $set: { 'email.to': to, 'email.codeHash': codeHash, 'email.expiresAt': expiresAt }, $push: { 'email.sends': now } } as any,
      );
    if (!res.modifiedCount) return { ok: false, reason: 'wait', waitSec: 5 };
    return { ok: true, reason: '', waitSec: Math.ceil(EMAIL_RESEND_GAP_MS / 1000) };
  }

  /** A failed send gives the reservation back (the person can retry at once). */
  async releaseEmail(id: string, sentAt: Date): Promise<void> {
    await this.col.updateOne({ _id: id, email: { $ne: null } }, { $pull: { 'email.sends': sentAt }, $set: { 'email.codeHash': '' } } as any);
  }

  /** Spends the email code (one use). */
  async spendEmailCode(id: string, codeHash: string, now = new Date()): Promise<boolean> {
    const res = await this.col.updateOne(
      { _id: id, completedAt: null, lockedAt: null, 'email.codeHash': codeHash, 'email.expiresAt': { $gt: now } },
      { $set: { 'email.codeHash': '' } },
    );
    return res.modifiedCount > 0;
  }

  async startApproval(row: ChallengeRow, now = new Date()): Promise<ChallengeRow['approval']> {
    const current = row.approval;
    if (current && current.status === 'pending' && new Date(current.expiresAt).getTime() > now.getTime()) return current;
    const { number, choices } = approvalNumbers();
    const approval = { status: 'pending' as const, number, choices, requestedAt: now, expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS), decidedAt: null, decidedBy: null };
    await this.col.updateOne({ _id: row._id, completedAt: null, lockedAt: null }, { $set: { approval } });
    return approval;
  }

  /** The approver's decision. Conditional on a pending, unexpired request of this account. */
  async decideApproval(publicId: string, userId: string, decision: 'approve' | 'deny', by: { sid: string; deviceId: string; label: string }, now = new Date()): Promise<ChallengeRow | null> {
    const res: any = await this.col.findOneAndUpdate(
      { publicId, userId, completedAt: null, lockedAt: null, 'approval.status': 'pending', 'approval.expiresAt': { $gt: now }, expiresAt: { $gt: now } },
      { $set: { 'approval.status': decision === 'approve' ? 'approved' : 'denied', 'approval.decidedAt': now, 'approval.decidedBy': by, ...(decision === 'deny' ? { lockedAt: now } : {}) } },
      { returnDocument: 'after' },
    );
    return res && res.value !== undefined ? res.value : res;
  }

  /** Pending approval requests of one account (for its trusted devices). */
  async pendingApprovals(userId: string, now = new Date()): Promise<ChallengeRow[]> {
    return this.col.find({ userId, completedAt: null, lockedAt: null, 'approval.status': 'pending', 'approval.expiresAt': { $gt: now }, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(5).toArray();
  }

  /** Ends every open challenge of an account (after a password reset). */
  async closeAll(userId: string): Promise<void> {
    await this.col.updateMany({ userId, completedAt: null }, { $set: { lockedAt: new Date() } });
  }

  static maxAttempts() { return CHALLENGE_MAX_ATTEMPTS; }
}
