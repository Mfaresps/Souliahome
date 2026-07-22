import { Injectable, Logger } from '@nestjs/common';
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
export class FollowUpsService {
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

  create(dto: CreateFollowUpDto) {
    return this.model.create(dto);
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
      const open = await this.model.find({ status: { $nin: DONE_STATUSES } }).lean();
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
