import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SecurityAuditLog,
  SecurityAuditLogDocument,
  ViolationType,
} from './schemas/security-audit-log.schema';
import { ClientContext } from '../shared/client-context.util';
import { fetchGeo, formatGeoLabel } from '../shared/geo-lookup.util';

@Injectable()
export class SecurityAuditService {
  constructor(
    @InjectModel(SecurityAuditLog.name)
    private readonly logModel: Model<SecurityAuditLogDocument>,
  ) {}

  /**
   * Write one audit row.
   *
   * `client` carries the request fingerprint (IP / browser / OS / device). It
   * is optional so that every pre-existing caller keeps compiling and keeps
   * working — those rows simply store empty strings and render as «غير معروف»,
   * exactly like the rows written before these fields existed. No backfill.
   *
   * ⚠ The row is written FIRST and the geo lookup patches it afterwards. The
   * lookup is a network call to a third party with a 3s timeout; awaiting it
   * inline would stall the login response — and on a failed-login path it
   * would hand an attacker a timing signal. If it never comes back, the row is
   * already safely stored without a location.
   */
  async log(entry: {
    userId: string;
    username: string;
    violationType: ViolationType;
    action: string;
    detail?: string;
    ipAddress?: string;
    client?: Partial<ClientContext>;
  }): Promise<SecurityAuditLogDocument> {
    const client = entry.client ?? {};
    const ipAddress = entry.ipAddress || client.ipAddress || '';

    const doc = await this.logModel.create({
      userId: entry.userId,
      username: entry.username,
      violationType: entry.violationType,
      action: entry.action,
      detail: entry.detail ?? '',
      ipAddress,
      userAgent: client.userAgent ?? '',
      device: client.device ?? '',
      browser: client.browser ?? '',
      os: client.os ?? '',
      location: '',
      isp: '',
    });

    this.resolveLocation(doc._id.toString(), ipAddress);
    return doc;
  }

  /**
   * Fire-and-forget geo enrichment for an already-persisted row.
   *
   * Never awaited by a request path, and never rejects — a failure here means
   * the row keeps an empty location, which the UI already renders correctly.
   */
  private resolveLocation(logId: string, ip: string): void {
    if (!ip) return;
    fetchGeo(ip)
      .then((loc) => {
        const label = formatGeoLabel(loc);
        if (!label && !loc?.isp) return;
        return this.logModel
          .findByIdAndUpdate(logId, { location: label, isp: loc?.isp || '' })
          .exec();
      })
      .catch(() => {
        /* forensic metadata only — never surface as a request failure */
      });
  }

  async markResolved(logId: string, adminId: string): Promise<void> {
    await this.logModel
      .findByIdAndUpdate(logId, { resolvedBy: adminId, resolvedAt: new Date() })
      .exec();
  }

  async findForUser(userId: string, limit = 50): Promise<SecurityAuditLogDocument[]> {
    return this.logModel
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec() as unknown as SecurityAuditLogDocument[];
  }

  async findAll(limit = 200): Promise<SecurityAuditLogDocument[]> {
    return this.logModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec() as unknown as SecurityAuditLogDocument[];
  }

  /**
   * The failed attempts that led to a lockout, newest first.
   *
   * Scoped to rows at or before `lockedAt` so a *later* attempt on the now
   * locked account (which is logged as `failed_login` too) is not presented as
   * one of the attempts that caused the lock — those are a different event and
   * would inflate the count the admin is reading.
   */
  async findLockoutAttempts(
    userId: string,
    lockedAt: Date | null,
    limit = 6,
  ): Promise<SecurityAuditLogDocument[]> {
    const q: Record<string, unknown> = {
      userId,
      violationType: { $in: ['failed_login', 'account_locked'] },
    };
    if (lockedAt) q.createdAt = { $lte: lockedAt };
    return this.logModel
      .find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec() as unknown as SecurityAuditLogDocument[];
  }

  async findUnresolved(): Promise<SecurityAuditLogDocument[]> {
    return this.logModel
      .find({ resolvedAt: null, violationType: 'account_locked' })
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as SecurityAuditLogDocument[];
  }
}
