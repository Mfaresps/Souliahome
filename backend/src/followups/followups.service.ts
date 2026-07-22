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
