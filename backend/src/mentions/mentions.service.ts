import { Injectable, Inject, Optional } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { createHash } from 'crypto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Mention, MentionDocument } from './schemas/mention.schema';

@Injectable()
export class MentionsService {
  @Optional() @Inject(NotificationsService) private readonly notifications?: NotificationsService;
  constructor(
    @InjectModel(Mention.name) private readonly mentionModel: Model<MentionDocument>,
  ) {}

  async create(data: Partial<Mention>): Promise<MentionDocument> {
    return this.mentionModel.create(data);
  }

  async createMany(rows: Partial<Mention>[], notifyPush = false): Promise<MentionDocument[]> {
    if (!rows.length) return [];
    const saved = await this.mentionModel.insertMany(rows) as unknown as MentionDocument[];
    if (notifyPush) for (const mention of saved) {
      if (!mention.targetUserId || mention.targetUserId === mention.fromUserId || mention.fromUserId === 'system' || !mention.commentId) continue;
      const event = createHash('sha256').update(JSON.stringify([mention.targetUserId, mention.fromUserId, mention.txId, mention.commentId])).digest('hex');
      await this.notifications?.enqueue('mention', 'mention:' + event, mention.txRef || '', 'mention:' + mention._id, mention.targetUserId, undefined, { actorName: mention.fromName });
    }
    return saved;
  }

  async findForUser(userId: string, username?: string): Promise<MentionDocument[]> {
    const or: Record<string, unknown>[] = [{ targetUserId: userId }];
    if (username) or.push({ targetUsername: username.toLowerCase() });
    return this.mentionModel.find({ $or: or }).sort({ createdAt: -1 }).limit(200).lean().exec() as unknown as MentionDocument[];
  }

  async markRead(id: string): Promise<void> {
    await this.mentionModel.findByIdAndUpdate(id, { read: true }).exec();
  }

  async markAllRead(userId: string, username?: string): Promise<void> {
    const or: Record<string, unknown>[] = [{ targetUserId: userId }];
    if (username) or.push({ targetUsername: username.toLowerCase() });
    await this.mentionModel.updateMany({ $or: or, read: false }, { read: true }).exec();
  }

  async clearForUser(userId: string, username?: string): Promise<void> {
    const or: Record<string, unknown>[] = [{ targetUserId: userId }];
    if (username) or.push({ targetUsername: username.toLowerCase() });
    await this.mentionModel.deleteMany({ $or: or }).exec();
  }
}
