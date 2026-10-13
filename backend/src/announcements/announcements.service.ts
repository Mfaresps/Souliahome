import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceGateway } from '../auth/presence.gateway';
import {
  ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_DEFAULT_MAX, ANNOUNCEMENT_HARD_MAX, ANNOUNCEMENT_MAX_RECIPIENTS,
  ANNOUNCEMENT_MIN_MAX, ANNOUNCEMENT_ROLES,
} from './announcement.constants';

export interface AnnouncementActor { userId: string; username?: string; name?: string; role?: string }

const ID_RE = /^[a-f0-9]{24}$/;
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Keeps line breaks (a message may be a short list) but removes every other control
 * character and the bidi overrides that could make a stored message display as
 * something other than what was typed.
 */
export function cleanAnnouncementMessage(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

@Injectable()
export class AnnouncementsService implements OnModuleInit {
  private readonly logger = new Logger(AnnouncementsService.name);
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
    @Optional() private readonly presence?: PresenceGateway,
  ) {}

  private get announcements() { return this.connection.collection('announcements'); }
  private get config() { return this.connection.collection('announcementconfig'); }

  async onModuleInit() {
    try {
      await this.announcements.createIndex({ 'recipients.userId': 1, createdAt: -1 });
      await this.announcements.createIndex({ createdAt: -1 });
      // Idempotency: the same submit (double click, retried request) creates one row.
      await this.announcements.createIndex(
        { createdById: 1, requestKey: 1 },
        { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } },
      );
    } catch (e) { this.logger.warn('Announcement indexes could not be ensured'); }
  }

  async getConfig() {
    const doc: any = await this.config.findOne({ _id: 'config' as any });
    const stored = Number(doc?.maxLength);
    const maxLength = Number.isInteger(stored) && stored >= ANNOUNCEMENT_MIN_MAX && stored <= ANNOUNCEMENT_HARD_MAX ? stored : ANNOUNCEMENT_DEFAULT_MAX;
    return { maxLength, minMaxLength: ANNOUNCEMENT_MIN_MAX, hardMaxLength: ANNOUNCEMENT_HARD_MAX, categories: ANNOUNCEMENT_CATEGORIES };
  }

  async setConfig(body: any) {
    const maxLength = Number(body?.maxLength);
    if (!Number.isInteger(maxLength) || maxLength < ANNOUNCEMENT_MIN_MAX || maxLength > ANNOUNCEMENT_HARD_MAX) {
      throw new BadRequestException(`الحد الأقصى يجب أن يكون رقماً صحيحاً بين ${ANNOUNCEMENT_MIN_MAX} و ${ANNOUNCEMENT_HARD_MAX}`);
    }
    await this.config.updateOne({ _id: 'config' as any }, { $set: { maxLength, updatedAt: new Date() } }, { upsert: true });
    return this.getConfig();
  }

  /** Resolves the recipients to a snapshot taken at send time. */
  private async resolveRecipients(actor: AnnouncementActor, audience: string, ids: unknown) {
    const users = this.connection.collection('users');
    const base = { role: { $in: ANNOUNCEMENT_ROLES }, isActive: { $ne: false } };
    let rows: any[];
    if (audience === 'all') {
      // The author wrote it; addressing it back to them would pop it up on their own screen.
      rows = await users.find({ ...base, _id: { $ne: ID_RE.test(actor.userId) ? new Types.ObjectId(actor.userId) : (actor.userId as any) } },
        { projection: { name: 1, username: 1 } }).toArray();
    } else if (audience === 'selected') {
      if (!Array.isArray(ids) || !ids.length) throw new BadRequestException('اختر موظفاً واحداً على الأقل');
      const unique = [...new Set(ids.map(v => String(v)))];
      if (unique.some(id => !ID_RE.test(id))) throw new BadRequestException('معرّف موظف غير صالح');
      if (unique.length > ANNOUNCEMENT_MAX_RECIPIENTS) throw new BadRequestException('عدد المستلمين أكبر من المسموح');
      rows = await users.find({ ...base, _id: { $in: unique.map(id => new Types.ObjectId(id)) } }, { projection: { name: 1, username: 1 } }).toArray();
      // Never silently drop a named recipient — the author would believe they were told.
      if (rows.length !== unique.length) throw new BadRequestException('بعض الموظفين المختارين غير موجودين أو حساباتهم معطلة');
    } else {
      throw new BadRequestException('حدد المستلمين: كل الموظفين أو موظفين محددين');
    }
    if (!rows.length) throw new BadRequestException('لا يوجد موظفون نشطون لإرسال الإعلان إليهم');
    if (rows.length > ANNOUNCEMENT_MAX_RECIPIENTS) throw new BadRequestException('عدد المستلمين أكبر من المسموح');
    return rows.map(u => ({ userId: String(u._id), name: String(u.name || u.username || ''), ackAt: null as Date | null }));
  }

  async create(actor: AnnouncementActor, body: any) {
    if (actor?.role !== 'admin') throw new BadRequestException('Only administrators can send announcements');
    const category = String(body?.category || '');
    if (!ANNOUNCEMENT_CATEGORIES.some(c => c.code === category)) throw new BadRequestException('نوع الإعلان غير معروف');
    const message = cleanAnnouncementMessage(body?.message);
    const { maxLength } = await this.getConfig();
    if (!message) throw new BadRequestException('نص الإعلان مطلوب');
    if (message.length > maxLength) throw new BadRequestException(`نص الإعلان أطول من الحد المسموح (${maxLength} حرفاً)`);
    const requestKey = body?.requestKey == null ? undefined : String(body.requestKey);
    if (requestKey !== undefined && !REQUEST_KEY_RE.test(requestKey)) throw new BadRequestException('Invalid request key');

    if (requestKey) {
      const existing: any = await this.announcements.findOne({ createdById: actor.userId, requestKey });
      if (existing) return { ...this.toAdminRow(existing), duplicate: true };
    }

    const audience = String(body?.audience || '');
    const recipients = await this.resolveRecipients(actor, audience, body?.recipientIds);
    const doc: any = {
      category, message, audience,
      recipients, recipientCount: recipients.length,
      createdById: actor.userId, createdByName: String(actor.name || actor.username || ''),
      createdAt: new Date(),
      ...(requestKey ? { requestKey } : {}),
    };
    try {
      const res = await this.announcements.insertOne(doc);
      doc._id = res.insertedId;
    } catch (error: any) {
      if (error?.code === 11000 && requestKey) {
        const existing: any = await this.announcements.findOne({ createdById: actor.userId, requestKey });
        if (existing) return { ...this.toAdminRow(existing), duplicate: true };
      }
      throw error;
    }
    const id = String(doc._id);
    // Delivery is best-effort and runs after the record is committed: the announcement
    // stays in each recipient's inbox even if the socket or the push provider fails.
    for (const r of recipients) {
      try { this.presence?.emitToUser(r.userId, 'announcement:new', { id }); } catch { /* offline */ }
    }
    await this.notifications.enqueue('announcement', 'announcement:' + id, '', 'announcement:' + id,
      recipients.map(r => r.userId), undefined,
      { announcementText: message, announcementCategory: category, actorName: doc.createdByName });
    return this.toAdminRow(doc);
  }

  private toAdminRow(doc: any) {
    const recipients = (doc.recipients || []).map((r: any) => ({ userId: r.userId, name: r.name, ackAt: r.ackAt || null }));
    return {
      id: String(doc._id), category: doc.category, message: doc.message, audience: doc.audience,
      createdById: doc.createdById, createdByName: doc.createdByName, createdAt: doc.createdAt,
      recipientCount: recipients.length, ackCount: recipients.filter((r: any) => r.ackAt).length, recipients,
    };
  }

  async history(limit = 50) {
    const rows = await this.announcements.find({}, { projection: { requestKey: 0 } }).sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 50, 1), 200)).toArray();
    return rows.map(r => this.toAdminRow(r));
  }

  /** What one recipient may see — never the other recipients or their read state. */
  async mine(actor: AnnouncementActor) {
    const userId = String(actor?.userId || '');
    if (!userId) return [];
    const rows = await this.announcements.find(
      { 'recipients.userId': userId },
      { projection: { category: 1, message: 1, createdByName: 1, createdById: 1, createdAt: 1, recipients: { $elemMatch: { userId } } } },
    ).sort({ createdAt: -1 }).limit(50).toArray();
    return rows.map((r: any) => ({
      id: String(r._id), category: r.category, message: r.message,
      createdByName: r.createdByName, createdById: r.createdById, createdAt: r.createdAt,
      ackAt: r.recipients?.[0]?.ackAt || null,
    }));
  }

  async acknowledge(actor: AnnouncementActor, id: string) {
    const userId = String(actor?.userId || '');
    if (!ID_RE.test(String(id))) throw new NotFoundException('الإعلان غير موجود');
    const _id = new Types.ObjectId(id);
    const doc: any = await this.announcements.findOne({ _id, 'recipients.userId': userId }, { projection: { createdById: 1, recipients: { $elemMatch: { userId } } } });
    if (!doc) throw new NotFoundException('الإعلان غير موجود');
    const already = doc.recipients?.[0]?.ackAt;
    if (already) return { id, ackAt: already };
    const ackAt = new Date();
    await this.announcements.updateOne({ _id }, { $set: { 'recipients.$[r].ackAt': ackAt } },
      { arrayFilters: [{ 'r.userId': userId, 'r.ackAt': null }] });
    try { this.presence?.emitToUser(String(doc.createdById), 'announcement:read', { id }); } catch { /* offline */ }
    return { id, ackAt };
  }
}
