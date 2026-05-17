import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SecurityAuditLog,
  SecurityAuditLogDocument,
  ViolationType,
} from './schemas/security-audit-log.schema';

@Injectable()
export class SecurityAuditService {
  constructor(
    @InjectModel(SecurityAuditLog.name)
    private readonly logModel: Model<SecurityAuditLogDocument>,
  ) {}

  async log(entry: {
    userId: string;
    username: string;
    violationType: ViolationType;
    action: string;
    detail?: string;
    ipAddress?: string;
  }): Promise<SecurityAuditLogDocument> {
    return this.logModel.create({
      ...entry,
      detail: entry.detail ?? '',
      ipAddress: entry.ipAddress ?? '',
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

  async findUnresolved(): Promise<SecurityAuditLogDocument[]> {
    return this.logModel
      .find({ resolvedAt: null, violationType: 'account_locked' })
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as SecurityAuditLogDocument[];
  }
}
