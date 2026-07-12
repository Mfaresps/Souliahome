import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Draft, DraftDocument } from './schemas/draft.schema';

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class DraftsService {
  constructor(@InjectModel(Draft.name) private draftModel: Model<DraftDocument>) {}

  async findAll(): Promise<Draft[]> {
    return this.draftModel.find().sort({ updatedAt: -1 }).lean();
  }

  async upsert(
    draftId: string,
    snap: Record<string, any>,
    by: string,
    byUsername: string,
    now: number,
    isNew: boolean,
  ): Promise<Draft> {
    const existing = await this.draftModel.findOne({ draftId }).lean();
    if (existing && !isNew) {
      return this.draftModel
        .findOneAndUpdate({ draftId }, { snap, updatedAt: now }, { new: true })
        .lean() as Promise<Draft>;
    }
    const created = new this.draftModel({
      draftId,
      snap,
      by,
      byUsername,
      createdAt: now,
      updatedAt: now,
    });
    return created.save();
  }

  async acquireLock(draftId: string, by: string, byUsername: string): Promise<{ ok: boolean; lockedBy?: string }> {
    const draft = await this.draftModel.findOne({ draftId }).lean();
    if (!draft) throw new NotFoundException('المسودة غير موجودة');
    const now = Date.now();
    const isExpired = !draft.lockedAt || now - draft.lockedAt > LOCK_TTL_MS;
    const isMine = draft.lockedByUsername === byUsername;
    if (!isExpired && !isMine && draft.lockedBy) {
      return { ok: false, lockedBy: draft.lockedBy };
    }
    await this.draftModel.updateOne({ draftId }, { lockedBy: by, lockedByUsername: byUsername, lockedAt: now });
    return { ok: true };
  }

  async releaseLock(draftId: string, byUsername: string, isAdmin: boolean): Promise<void> {
    const draft = await this.draftModel.findOne({ draftId }).lean();
    if (!draft) return;
    if (!isAdmin && draft.lockedByUsername !== byUsername) return;
    await this.draftModel.updateOne({ draftId }, { lockedBy: '', lockedByUsername: '', lockedAt: 0 });
  }

  async delete(draftId: string, callerUsername: string, isAdmin: boolean): Promise<void> {
    const draft = await this.draftModel.findOne({ draftId }).lean();
    if (!draft) return;
    if (!isAdmin && draft.byUsername !== callerUsername) {
      throw new ForbiddenException('لا يمكنك حذف مسودة شخص آخر');
    }
    await this.draftModel.deleteOne({ draftId });
  }

  async deleteAll(): Promise<void> {
    await this.draftModel.deleteMany({});
  }
}
