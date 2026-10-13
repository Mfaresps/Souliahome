import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection, Types } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceGateway } from '../auth/presence.gateway';
import {
  ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_DEFAULT_MAX, ANNOUNCEMENT_HARD_MAX, ANNOUNCEMENT_MAX_RECIPIENTS,
  ANNOUNCEMENT_MIN_MAX, ANNOUNCEMENT_ROLES, ANNOUNCEMENT_SCHEDULE_MAX_DAYS, ANNOUNCEMENT_SCHEDULE_MIN_LEAD_MS,
} from './announcement.constants';

export interface AnnouncementActor { userId: string; username?: string; name?: string; role?: string }
type Recipient = { userId: string; name: string; ackAt: Date | null };

const ID_RE = /^[a-f0-9]{24}$/;
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A delivery claimed this long ago and never finished is retried (the process died mid-send). */
const STALE_CLAIM_MS = 10 * 60 * 1000;

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

/**
 * Lifecycle: `scheduled` → `sending` (claimed by one worker) → `sent`, or `cancelled` /
 * `failed`. A row with no `status` predates scheduling and is treated as `sent`.
 *
 * ⚠ A scheduled row carries NO `recipients` — they are resolved at delivery, so someone
 * deactivated in between is not told, and «كل الموظفين» includes whoever was added since.
 * `mine()` therefore cannot leak a scheduled message: it matches on `recipients.userId`.
 */
@Injectable()
export class AnnouncementsService implements OnModuleInit {
  private readonly logger = new Logger(AnnouncementsService.name);
  private running = false;
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
      await this.announcements.createIndex({ status: 1, sendAt: 1 });
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
    return {
      maxLength, minMaxLength: ANNOUNCEMENT_MIN_MAX, hardMaxLength: ANNOUNCEMENT_HARD_MAX, categories: ANNOUNCEMENT_CATEGORIES,
      scheduleMaxDays: ANNOUNCEMENT_SCHEDULE_MAX_DAYS, scheduleMinLeadMinutes: Math.ceil(ANNOUNCEMENT_SCHEDULE_MIN_LEAD_MS / 60000),
    };
  }

  async setConfig(body: any) {
    const maxLength = Number(body?.maxLength);
    if (!Number.isInteger(maxLength) || maxLength < ANNOUNCEMENT_MIN_MAX || maxLength > ANNOUNCEMENT_HARD_MAX) {
      throw new BadRequestException(`الحد الأقصى يجب أن يكون رقماً صحيحاً بين ${ANNOUNCEMENT_MIN_MAX} و ${ANNOUNCEMENT_HARD_MAX}`);
    }
    await this.config.updateOne({ _id: 'config' as any }, { $set: { maxLength, updatedAt: new Date() } }, { upsert: true });
    return this.getConfig();
  }

  /**
   * `strict` (at submission): a named recipient who is inactive or unknown is an error the
   * author can fix on screen. Not strict (at a scheduled delivery): nobody is on screen, so
   * that person is skipped and counted in `skippedCount` instead.
   */
  private async resolveRecipients(authorId: string, audience: string, ids: unknown, strict: boolean): Promise<{ recipients: Recipient[]; skipped: number }> {
    const users = this.connection.collection('users');
    const base = { role: { $in: ANNOUNCEMENT_ROLES }, isActive: { $ne: false } };
    let rows: any[];
    let skipped = 0;
    if (audience === 'all') {
      // The author wrote it; addressing it back to them would pop it up on their own screen.
      rows = await users.find({ ...base, _id: { $ne: ID_RE.test(authorId) ? new Types.ObjectId(authorId) : (authorId as any) } },
        { projection: { name: 1, username: 1 } }).toArray();
    } else if (audience === 'selected') {
      if (!Array.isArray(ids) || !ids.length) throw new BadRequestException('اختر موظفاً واحداً على الأقل');
      const unique = [...new Set(ids.map(v => String(v)))];
      if (unique.some(id => !ID_RE.test(id))) throw new BadRequestException('معرّف موظف غير صالح');
      if (unique.length > ANNOUNCEMENT_MAX_RECIPIENTS) throw new BadRequestException('عدد المستلمين أكبر من المسموح');
      rows = await users.find({ ...base, _id: { $in: unique.map(id => new Types.ObjectId(id)) } }, { projection: { name: 1, username: 1 } }).toArray();
      // Never silently drop a named recipient — the author would believe they were told.
      if (strict && rows.length !== unique.length) throw new BadRequestException('بعض الموظفين المختارين غير موجودين أو حساباتهم معطلة');
      skipped = unique.length - rows.length;
    } else {
      throw new BadRequestException('حدد المستلمين: كل الموظفين أو موظفين محددين');
    }
    if (!rows.length) throw new BadRequestException('لا يوجد موظفون نشطون لإرسال الإعلان إليهم');
    if (rows.length > ANNOUNCEMENT_MAX_RECIPIENTS) throw new BadRequestException('عدد المستلمين أكبر من المسموح');
    return { recipients: rows.map(u => ({ userId: String(u._id), name: String(u.name || u.username || ''), ackAt: null })), skipped };
  }

  /** null = send now. Otherwise a validated future Date within the allowed horizon. */
  private parseSendAt(value: unknown): Date | null {
    if (value == null || value === '') return null;
    const at = new Date(String(value));
    if (isNaN(at.getTime())) throw new BadRequestException('موعد الإرسال غير صالح');
    const now = Date.now();
    if (at.getTime() < now + ANNOUNCEMENT_SCHEDULE_MIN_LEAD_MS) throw new BadRequestException('موعد الإرسال يجب أن يكون بعد دقيقتين على الأقل من الآن');
    if (at.getTime() > now + ANNOUNCEMENT_SCHEDULE_MAX_DAYS * 86400000) throw new BadRequestException(`لا يمكن الجدولة لأكثر من ${ANNOUNCEMENT_SCHEDULE_MAX_DAYS} يوماً`);
    return at;
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
    const sendAt = this.parseSendAt(body?.sendAt);

    if (requestKey) {
      const existing: any = await this.announcements.findOne({ createdById: actor.userId, requestKey });
      if (existing) return { ...this.toAdminRow(existing), duplicate: true };
    }

    const audience = String(body?.audience || '');
    // Validated now even when scheduled, so a bad selection fails while the author is here.
    const { recipients } = await this.resolveRecipients(actor.userId, audience, body?.recipientIds, true);
    const doc: any = {
      category, message, audience,
      createdById: actor.userId, createdByName: String(actor.name || actor.username || ''),
      createdAt: new Date(),
      ...(audience === 'selected' ? { recipientIds: recipients.map(r => r.userId) } : {}),
      ...(requestKey ? { requestKey } : {}),
      ...(sendAt
        ? { status: 'scheduled', sendAt, recipients: [], recipientCount: recipients.length }
        : { status: 'sending', claimedAt: new Date(), recipients: [], recipientCount: recipients.length }),
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
    if (sendAt) return this.toAdminRow(doc);
    return this.toAdminRow(await this.deliver(doc, recipients, 0));
  }

  /**
   * Writes the recipients, flips the row to `sent`, then notifies. Delivery is best-effort
   * and runs after the record is committed: the announcement stays in each inbox even if
   * the socket or the push provider fails. Push is deduplicated by `announcement:<id>`.
   */
  private async deliver(doc: any, recipients: Recipient[], skipped: number, scheduled = false) {
    const sentAt = new Date();
    await this.announcements.updateOne({ _id: doc._id }, {
      $set: { status: 'sent', sentAt, recipients, recipientCount: recipients.length, ...(skipped ? { skippedCount: skipped } : {}) },
      $unset: { claimedAt: '' },
    });
    Object.assign(doc, { status: 'sent', sentAt, recipients, recipientCount: recipients.length, skippedCount: skipped || undefined });
    delete doc.claimedAt;
    const id = String(doc._id);
    for (const r of recipients) {
      try { this.presence?.emitToUser(r.userId, 'announcement:new', { id }); } catch { /* offline */ }
    }
    await this.notifications.enqueue('announcement', 'announcement:' + id, '', 'announcement:' + id,
      recipients.map(r => r.userId), undefined,
      { announcementText: doc.message, announcementCategory: doc.category, actorName: doc.createdByName });
    // A scheduled one goes out with nobody watching: refresh the author's list if it is open.
    if (scheduled) { try { this.presence?.emitToUser(String(doc.createdById), 'announcement:read', { id }); } catch { /* offline */ } }
    return doc;
  }

  /** Delivers due scheduled announcements. One worker per row via an atomic claim. */
  @Cron('*/20 * * * * *')
  async deliverDue() {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 20; i++) {
        const now = new Date();
        const doc: any = await this.announcements.findOneAndUpdate(
          { $or: [
            { status: 'scheduled', sendAt: { $lte: now } },
            { status: 'sending', claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
          ] },
          { $set: { status: 'sending', claimedAt: now } },
          { returnDocument: 'after', sort: { sendAt: 1 } },
        );
        if (!doc) break;
        try {
          const { recipients, skipped } = await this.resolveRecipients(String(doc.createdById), doc.audience, doc.recipientIds, false);
          await this.deliver(doc, recipients, skipped, true);
        } catch (error: any) {
          // Nobody left to receive it (everyone deactivated). Record why instead of retrying forever.
          await this.announcements.updateOne({ _id: doc._id }, { $set: { status: 'failed', failReason: String(error?.message || 'delivery failed').slice(0, 200) }, $unset: { claimedAt: '' } });
          try { this.presence?.emitToUser(String(doc.createdById), 'announcement:read', { id: String(doc._id) }); } catch { /* offline */ }
        }
      }
    } catch { this.logger.warn('Scheduled announcement worker failed'); }
    finally { this.running = false; }
  }

  async cancel(id: string) {
    if (!ID_RE.test(String(id))) throw new NotFoundException('الإعلان غير موجود');
    const _id = new Types.ObjectId(id);
    // Atomic: a row the worker has already claimed can no longer be cancelled.
    const res = await this.announcements.updateOne({ _id, status: 'scheduled' }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
    if (!res.modifiedCount) {
      const doc: any = await this.announcements.findOne({ _id }, { projection: { status: 1 } });
      if (!doc) throw new NotFoundException('الإعلان غير موجود');
      throw new BadRequestException(doc.status === 'cancelled' ? 'تم إلغاء هذا الإعلان بالفعل' : 'لا يمكن إلغاء إعلان تم إرساله');
    }
    return this.toAdminRow(await this.announcements.findOne({ _id }));
  }

  private toAdminRow(doc: any) {
    const recipients = (doc.recipients || []).map((r: any) => ({ userId: r.userId, name: r.name, ackAt: r.ackAt || null }));
    const status = doc.status || 'sent';
    return {
      id: String(doc._id), category: doc.category, message: doc.message, audience: doc.audience, status,
      createdById: doc.createdById, createdByName: doc.createdByName, createdAt: doc.createdAt,
      sendAt: doc.sendAt || null, sentAt: doc.sentAt || (status === 'sent' ? doc.createdAt : null),
      cancelledAt: doc.cancelledAt || null, failReason: doc.failReason || null, skippedCount: doc.skippedCount || 0,
      recipientCount: status === 'sent' ? recipients.length : (doc.recipientCount || 0),
      ackCount: recipients.filter((r: any) => r.ackAt).length, recipients,
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
      { 'recipients.userId': userId, status: { $nin: ['scheduled', 'sending', 'cancelled', 'failed'] } },
      { projection: { category: 1, message: 1, createdByName: 1, createdById: 1, createdAt: 1, sentAt: 1, recipients: { $elemMatch: { userId } } } },
    ).sort({ createdAt: -1 }).limit(50).toArray();
    return rows.map((r: any) => ({
      id: String(r._id), category: r.category, message: r.message,
      // A scheduled one reaches people when it is sent, so that is the time they see.
      createdByName: r.createdByName, createdById: r.createdById, createdAt: r.sentAt || r.createdAt,
      ackAt: r.recipients?.[0]?.ackAt || null,
    })).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
