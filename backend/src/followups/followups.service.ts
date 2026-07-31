import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { FollowUp, FollowUpDocument } from './schemas/followup.schema';
import { CreateFollowUpDto, UpdateFollowUpDto } from './dto/followup.dto';
import { MentionsService } from '../mentions/mentions.service';
import { PresenceGateway } from '../auth/presence.gateway';

const DONE_STATUSES = ['تمت المتابعة', 'تم حل المشكلة'];

// Escalation thresholds in hours: 12h, then 24h, 48h, 72h, ... (one per day after the first day)
const ESCALATION_HOURS = [12, 24, 48, 72, 96, 120, 144, 168];

@Injectable()
export class FollowUpsService implements OnModuleInit {
  private readonly logger = new Logger(FollowUpsService.name);

  constructor(
    @InjectModel(FollowUp.name) private model: Model<FollowUpDocument>,
    private readonly mentionsService: MentionsService,
    private readonly presence: PresenceGateway,
  ) {}

  findAll() {
    return this.model.find().sort({ createdAt: -1 }).lean();
  }

  findById(id: string) {
    return this.model.findById(id).lean();
  }

  /**
   * Builds the human-facing ticket id: FU-YYMMDD-{orderRef}, adding a -2/-3
   * suffix when the same order already has a follow-up opened the same day.
   * Deliberately mirrors ComplaintsService.generateComplaintNo so a follow-up
   * ticket and a complaint number read identically apart from the prefix.
   */
  private async generateTicketNo(orderRef?: string, when: Date = new Date()): Promise<string> {
    const yy = String(when.getFullYear()).slice(-2);
    const mm = String(when.getMonth() + 1).padStart(2, '0');
    const dd = String(when.getDate()).padStart(2, '0');
    const ref = (orderRef || '').replace(/^#+/, '').trim();
    const datePart = `${yy}${mm}${dd}`;

    if (ref) {
      // Escape the ref before interpolating it into a regex — order refs can
      // carry dashes and other literal characters (e.g. "2254-RET").
      const safeRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const base = `FU-${datePart}-${ref}`;
      const existing = await this.model
        .find({ ticketNo: { $regex: `^FU-${datePart}-${safeRef}(-\\d+)?$` } })
        .select('ticketNo')
        .lean()
        .exec();
      if (!existing.length) return base;
      let maxSuffix = 1;
      for (const e of existing) {
        const m = (e as any).ticketNo?.match(/-(\d+)$/);
        const n = m && (e as any).ticketNo !== base ? parseInt(m[1], 10) : 1;
        if (n > maxSuffix) maxSuffix = n;
      }
      return `${base}-${maxSuffix + 1}`;
    }

    // No linked order — fall back to a daily sequence so the id stays unique.
    const sameDay = await this.model
      .find({ ticketNo: { $regex: `^FU-${datePart}-N\\d+$` } })
      .select('ticketNo')
      .lean()
      .exec();
    let seq = 1;
    for (const e of sameDay) {
      const m = (e as any).ticketNo?.match(/-N(\d+)$/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (n >= seq) seq = n + 1;
    }
    return `FU-${datePart}-N${String(seq).padStart(3, '0')}`;
  }

  async create(dto: CreateFollowUpDto) {
    const ticketNo = await this.generateTicketNo(dto.orderRef);
    return this.model.create({ ...dto, ticketNo });
  }

  /**
   * Backfills ticketNo on records created before the field existed. Runs once
   * on boot; each ticket is derived from that record's own createdAt so the
   * date embedded in the id stays truthful rather than reflecting migration
   * day. Sequential (not Promise.all) because generateTicketNo reads back the
   * rows it just wrote to resolve same-day suffixes.
   */
  async onModuleInit(): Promise<void> {
    try {
      const missing = await this.model
        .find({ $or: [{ ticketNo: { $exists: false } }, { ticketNo: '' }, { ticketNo: null }] })
        .select('_id orderRef createdAt')
        .sort({ createdAt: 1 })
        .lean()
        .exec();
      if (!missing.length) return;
      for (const f of missing as any[]) {
        const when = f.createdAt ? new Date(f.createdAt) : new Date();
        const ticketNo = await this.generateTicketNo(f.orderRef, when);
        await this.model.updateOne({ _id: f._id }, { ticketNo }).exec();
      }
      this.logger.log(`Backfilled ticketNo on ${missing.length} follow-up(s)`);
    } catch (err: any) {
      this.logger.error(`ticketNo backfill failed: ${err.message}`);
    }
  }

  async update(id: string, dto: UpdateFollowUpDto) {
    const existing = await this.model.findById(id).lean();
    const patch: Record<string, unknown> = { ...dto };
    const statusChanged = dto.status !== undefined && existing && dto.status !== existing.status;
    const reasonChanged = dto.reason !== undefined && existing && dto.reason !== existing.reason;
    if (statusChanged || reasonChanged) {
      patch.escalationBaseline = new Date();
      patch.escalationLevel = 0;
    }
    return this.model.findByIdAndUpdate(id, patch, { new: true }).lean();
  }

  markNotified(id: string) {
    return this.model.findByIdAndUpdate(id, { notified: true }, { new: true }).lean();
  }

  remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }

  cancel(id: string, cancelReason: string, userId: string, userName: string) {
    return this.model
      .findByIdAndUpdate(
        id,
        {
          cancelled: true,
          cancelReason,
          cancelledAt: new Date(),
          cancelledById: userId,
          cancelledByName: userName,
        },
        { new: true },
      )
      .lean();
  }

  async addComment(id: string, authorId: string, authorName: string, text: string) {
    const before = await this.model.findById(id).lean();
    if (!before) return null;
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        { $push: { comments: { authorId, authorName, text, edited: false } } },
        { new: true },
      )
      .lean();
    // Notify everyone already involved in this thread (responsible user +
    // anyone who has commented before) except whoever just wrote this one —
    // computed from the pre-push snapshot so the author's own new entry
    // never counts as a "prior participant" of itself.
    const participantIds = new Set<string>();
    if (before.responsibleId) participantIds.add(String(before.responsibleId));
    ((before.comments as any[]) || []).forEach((c) => participantIds.add(String(c.authorId)));
    participantIds.delete(String(authorId));

    // $push guarantees the new entry lands last — its _id is what the
    // notification needs so the client can scroll to/highlight this exact
    // comment instead of just opening the thread at the top.
    const newComments = (doc?.comments as any[]) || [];
    const newCommentId = newComments.length ? String(newComments[newComments.length - 1]._id) : '';

    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const commentText = `تعليق جديد على متابعة #${before.orderRef}: ${preview}`;
    for (const targetUserId of participantIds) {
      try {
        const created = await this.mentionsService.create({
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
        });
        this.presence.emitToUser(targetUserId, 'mention:new', {
          id: String(created._id),
          _id: String(created._id),
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
          read: false,
          ts: new Date().toISOString(),
        });
      } catch (err: any) {
        this.logger.warn(`Failed to notify ${targetUserId} of new followup comment: ${err.message}`);
      }
    }
    return doc;
  }

  async addCallAttempt(id: string, authorId: string, authorName: string, outcome: 'answered' | 'no_answer') {
    const before = await this.model.findById(id).lean();
    if (!before) return null;
    const existingAttempts = ((before.comments as any[]) || []).filter((c) => c.kind === 'call').length;
    if (existingAttempts >= 3) throw new Error('CALL_LIMIT_REACHED');
    const attemptNo = existingAttempts + 1;
    const outcomeLabel = outcome === 'answered' ? 'تم الرد' : 'لم يتم الرد';
    const text = `محاولة اتصال رقم ${attemptNo} بالعميل — ${outcomeLabel}`;
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        { $push: { comments: { authorId, authorName, text, edited: false, kind: 'call', callAttemptNo: attemptNo, callOutcome: outcome } } },
        { new: true },
      )
      .lean();

    const participantIds = new Set<string>();
    if (before.responsibleId) participantIds.add(String(before.responsibleId));
    ((before.comments as any[]) || []).forEach((c) => participantIds.add(String(c.authorId)));
    participantIds.delete(String(authorId));

    const newComments = (doc?.comments as any[]) || [];
    const newCommentId = newComments.length ? String(newComments[newComments.length - 1]._id) : '';
    const commentText = `تعليق جديد على متابعة #${before.orderRef}: ${text}`;
    for (const targetUserId of participantIds) {
      try {
        const created = await this.mentionsService.create({
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
        });
        this.presence.emitToUser(targetUserId, 'mention:new', {
          id: String(created._id),
          _id: String(created._id),
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
          read: false,
          ts: new Date().toISOString(),
        });
      } catch (err: any) {
        this.logger.warn(`Failed to notify ${targetUserId} of new call attempt: ${err.message}`);
      }
    }
    return doc;
  }

  async editComment(id: string, commentId: string, authorId: string, text: string, isAdmin = false) {
    const doc = await this.model.findById(id);
    if (!doc) return null;
    const entry = (doc.comments as any[]).find((c) => String(c._id) === String(commentId));
    if (!entry) return null;
    if (!isAdmin && String(entry.authorId) !== String(authorId)) {
      throw new Error('FORBIDDEN');
    }
    entry.text = text;
    entry.edited = true;
    await doc.save();
    return doc.toObject();
  }

  async deleteComment(id: string, commentId: string, authorId: string, isAdmin = false) {
    const doc = await this.model.findById(id);
    if (!doc) return null;
    const entry = (doc.comments as any[]).find((c) => String(c._id) === String(commentId));
    if (!entry) return null;
    if (!isAdmin && String(entry.authorId) !== String(authorId)) {
      throw new Error('FORBIDDEN');
    }
    (doc.comments as any[]).splice((doc.comments as any[]).indexOf(entry), 1);
    await doc.save();
    return doc.toObject();
  }

  /**
   * Re-pings the responsible employee when an open follow-up has sat past a
   * reminder threshold (12h, then every 24h) since its last status/reason
   * change. Runs as a backstop cron rather than a client timer so the
   * reminder still fires even if nobody has the app open.
   */
  @Cron('0 */15 * * * *')
  async scheduledEscalationScan(): Promise<void> {
    try {
      const open = await this.model.find({ status: { $nin: DONE_STATUSES }, cancelled: { $ne: true } }).lean();
      const now = Date.now();
      for (const f of open as any[]) {
        const baseline = f.escalationBaseline ? new Date(f.escalationBaseline).getTime() : new Date(f.createdAt).getTime();
        const hoursElapsed = (now - baseline) / 3_600_000;
        const currentLevel = f.escalationLevel || 0;
        let newLevel = currentLevel;
        for (let i = currentLevel; i < ESCALATION_HOURS.length; i++) {
          if (hoursElapsed >= ESCALATION_HOURS[i]) newLevel = i + 1;
          else break;
        }
        if (newLevel > currentLevel) {
          await this.model.updateOne({ _id: f._id }, { escalationLevel: newLevel }).exec();
          const thresholdHours = ESCALATION_HOURS[newLevel - 1];
          const label = thresholdHours < 24 ? `${thresholdHours} ساعة` : `${thresholdHours / 24} يوم`;
          const reminderText = `تذكير متابعة: طلب #${f.orderRef} بدون تحديث منذ ${label}${f.reason ? ` — ${f.reason}` : ''}`;
          try {
            const created = await this.mentionsService.create({
              targetUserId: f.responsibleId,
              targetName: f.responsibleName,
              fromUserId: 'system',
              fromName: 'تذكير المتابعة',
              txId: String(f._id),
              txRef: f.orderRef,
              commentId: 0,
              commentText: reminderText,
            });
            this.presence.emitToUser(String(f.responsibleId), 'mention:new', {
              id: String(created._id),
              _id: String(created._id),
              targetUserId: f.responsibleId,
              targetName: f.responsibleName,
              fromUserId: 'system',
              fromName: 'تذكير المتابعة',
              txId: String(f._id),
              txRef: f.orderRef,
              commentId: 0,
              commentText: reminderText,
              read: false,
              ts: new Date().toISOString(),
            });
          } catch (err: any) {
            this.logger.warn(`Failed to send escalation reminder for followup ${f._id}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Escalation scan failed: ${err.message}`);
    }
  }
}
