import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import type { ClientContext } from '../shared/client-context.util';
import { TRUST_DAYS, deviceLabel, randomToken, sha256 } from './auth-security.util';

export const TRUSTED_DEVICES_COLLECTION = 'trusteddevices';

export interface TrustedDeviceRow {
  _id: string;
  userId: string;
  tokenHash: string;
  label: string;
  browser: string;
  os: string;
  device: string;
  ip: string;
  method: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: { id: string; name: string } | null;
  revokeReason: string;
  purgeAt: Date;
}

/**
 * Trusted devices («الأجهزة الموثوقة», Nov 27, 2026). A device passes the second step once and is
 * trusted for TRUST_DAYS from that moment (fixed, not extended by use). ⚠ The browser holds a
 * random token; only its SHA-256 is stored, so a copy of the database cannot sign anyone in.
 * A password reset, a 2FA reset or «إلغاء كل الأجهزة» revokes them.
 */
@Injectable()
export class TrustedDevicesService implements OnModuleInit {
  private readonly logger = new Logger(TrustedDevicesService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get col() {
    return this.connection.collection<TrustedDeviceRow>(TRUSTED_DEVICES_COLLECTION);
  }

  async onModuleInit() {
    try {
      await this.col.createIndex({ tokenHash: 1 }, { unique: true });
      await this.col.createIndex({ userId: 1, expiresAt: -1 });
      await this.col.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    } catch (e) {
      this.logger.warn(`trusted device indexes: ${(e as Error).message}`);
    }
  }

  async create(userId: string, client: ClientContext | undefined, method: string, now = new Date()): Promise<{ token: string; row: TrustedDeviceRow }> {
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + TRUST_DAYS * 86_400_000);
    const row: TrustedDeviceRow = {
      _id: randomToken(12),
      userId: String(userId),
      tokenHash: sha256(token),
      label: deviceLabel(client),
      browser: client?.browser || '',
      os: client?.os || '',
      device: client?.device || '',
      ip: client?.ipAddress || '',
      method,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      revokedAt: null,
      revokedBy: null,
      revokeReason: '',
      purgeAt: new Date(expiresAt.getTime() + 30 * 86_400_000),
    };
    await this.col.insertOne(row);
    return { token, row };
  }

  /** The active trusted device of `userId` that holds `token`, or null. Touches lastUsedAt. */
  async findValid(userId: string, token: string, now = new Date()): Promise<TrustedDeviceRow | null> {
    const t = String(token || '');
    if (!/^[a-f0-9]{64}$/.test(t) || !userId) return null;
    const row = await this.col.findOne({ tokenHash: sha256(t), userId: String(userId), revokedAt: null, expiresAt: { $gt: now } });
    if (row) this.col.updateOne({ _id: row._id }, { $set: { lastUsedAt: now } }).catch(() => undefined);
    return row;
  }

  async hasActive(userId: string, now = new Date()): Promise<boolean> {
    return (await this.col.countDocuments({ userId: String(userId), revokedAt: null, expiresAt: { $gt: now } }, { limit: 1 })) > 0;
  }

  async list(userId: string, now = new Date()) {
    const rows = await this.col.find({ userId: String(userId), revokedAt: null, expiresAt: { $gt: now } }).sort({ lastUsedAt: -1 }).toArray();
    return rows.map((r) => presentDevice(r));
  }

  async revoke(id: string, userId: string, by: { id: string; name: string } | null, reason = 'revoked'): Promise<boolean> {
    const res = await this.col.updateOne(
      { _id: String(id), userId: String(userId), revokedAt: null },
      { $set: { revokedAt: new Date(), revokedBy: by, revokeReason: reason } },
    );
    return res.modifiedCount > 0;
  }

  async revokeAll(userId: string, by: { id: string; name: string } | null, reason: string, exceptId?: string): Promise<number> {
    const filter: Record<string, unknown> = { userId: String(userId), revokedAt: null };
    if (exceptId) filter._id = { $ne: exceptId };
    const res = await this.col.updateMany(filter, { $set: { revokedAt: new Date(), revokedBy: by, revokeReason: reason } });
    // The pre-Nov-27 list on the user record is cleared too.
    if (Types.ObjectId.isValid(userId)) {
      await this.connection.collection('users').updateOne({ _id: new Types.ObjectId(userId) }, { $set: { trustedDevices: [] } });
    }
    return res.modifiedCount;
  }

  /**
   * A device trusted before Nov 27 holds a raw token from `user.trustedDevices` (never checked
   * because of a DTO bug). If it presents it, it becomes a normal trusted device for 30 days and
   * the old copy is removed. Returns the new browser token, or null.
   */
  async migrateLegacy(user: { _id: unknown; trustedDevices?: string[] }, token: string, client?: ClientContext): Promise<{ token: string; row: TrustedDeviceRow } | null> {
    const t = String(token || '');
    if (!t || !Array.isArray(user?.trustedDevices) || !user.trustedDevices.includes(t)) return null;
    const userId = String(user._id);
    const pulled = await this.connection.collection('users').updateOne(
      { _id: new Types.ObjectId(userId), trustedDevices: t },
      { $pull: { trustedDevices: t } } as any,
    );
    if (!pulled.modifiedCount) return null;
    return this.create(userId, client, 'legacy');
  }
}

export function presentDevice(r: TrustedDeviceRow) {
  return {
    id: r._id,
    label: r.label,
    browser: r.browser,
    os: r.os,
    device: r.device,
    ip: r.ip,
    method: r.method,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
  };
}
