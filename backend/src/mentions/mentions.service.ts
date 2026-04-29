import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Mention, MentionDocument } from './schemas/mention.schema';

@Injectable()
export class MentionsService {
  constructor(
    @InjectModel(Mention.name) private readonly mentionModel: Model<MentionDocument>,
  ) {}

  async create(data: Partial<Mention>): Promise<MentionDocument> {
    return this.mentionModel.create(data);
  }

  async createMany(rows: Partial<Mention>[]): Promise<MentionDocument[]> {
    if (!rows.length) return [];
    return this.mentionModel.insertMany(rows) as unknown as MentionDocument[];
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
