import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  KnowledgeFolder,
  KnowledgeFolderDocument,
} from './schemas/knowledge-folder.schema';
import { KnowledgeCard, KnowledgeCardDocument } from './schemas/knowledge-card.schema';
import {
  KnowledgeAuditLog,
  KnowledgeAuditLogDocument,
  KnowledgeEntityType,
} from './schemas/knowledge-audit-log.schema';
import { CreateFolderDto, UpdateFolderDto } from './dto/folder.dto';
import { CreateCardDto, UpdateCardDto } from './dto/card.dto';

interface Actor {
  userId?: string;
  username?: string;
  name?: string;
}

@Injectable()
export class CustomerServicePlaybookService {
  constructor(
    @InjectModel(KnowledgeFolder.name)
    private readonly folderModel: Model<KnowledgeFolderDocument>,
    @InjectModel(KnowledgeCard.name)
    private readonly cardModel: Model<KnowledgeCardDocument>,
    @InjectModel(KnowledgeAuditLog.name)
    private readonly auditModel: Model<KnowledgeAuditLogDocument>,
  ) {}

  private async logAudit(
    entityType: KnowledgeEntityType,
    entityId: string,
    action: 'created' | 'updated' | 'deleted',
    actor: Actor,
    summary: string,
  ): Promise<void> {
    await this.auditModel.create({
      entityType,
      entityId,
      action,
      userId: actor.userId || '',
      username: actor.name || actor.username || '',
      summary,
    });
  }

  // ── Folders ──

  async findAllFolders(includeInactive = false): Promise<KnowledgeFolderDocument[]> {
    const filter = includeInactive ? {} : { isActive: true };
    return this.folderModel.find(filter).sort({ order: 1, createdAt: 1 }).exec();
  }

  async findFolderById(id: string): Promise<KnowledgeFolderDocument> {
    const folder = await this.folderModel.findById(id).exec();
    if (!folder) throw new NotFoundException('الفولدر غير موجود');
    return folder;
  }

  async createFolder(dto: CreateFolderDto, actor: Actor): Promise<KnowledgeFolderDocument> {
    const actorName = actor.name || actor.username || '';
    const folder = await this.folderModel.create({
      ...dto,
      createdBy: actorName,
      updatedBy: actorName,
    });
    await this.logAudit('folder', String(folder._id), 'created', actor, `أنشأ فولدر: ${folder.name}`);
    return folder;
  }

  async updateFolder(
    id: string,
    dto: UpdateFolderDto,
    actor: Actor,
  ): Promise<KnowledgeFolderDocument> {
    const folder = await this.folderModel.findById(id).exec();
    if (!folder) throw new NotFoundException('الفولدر غير موجود');
    Object.assign(folder, dto, { updatedBy: actor.name || actor.username || '' });
    const saved = await folder.save();
    await this.logAudit('folder', String(folder._id), 'updated', actor, `عدّل فولدر: ${folder.name}`);
    return saved;
  }

  async removeFolder(id: string, actor: Actor): Promise<void> {
    const folder = await this.folderModel.findById(id).exec();
    if (!folder) throw new NotFoundException('الفولدر غير موجود');
    const cardCount = await this.cardModel.countDocuments({ folderId: id }).exec();
    if (cardCount > 0) {
      throw new BadRequestException(
        `هذا الفولدر يحتوي على ${cardCount} بطاقة — يجب نقلها أو حذفها أولاً`,
      );
    }
    await this.folderModel.findByIdAndDelete(id).exec();
    await this.logAudit('folder', id, 'deleted', actor, `حذف فولدر: ${folder.name}`);
  }

  // ── Cards ──

  async findCards(folderId?: string, q?: string): Promise<KnowledgeCardDocument[]> {
    const filter: Record<string, unknown> = { isActive: true };
    if (folderId) filter.folderId = folderId;
    if (q && q.trim()) {
      filter.$text = { $search: q.trim() };
    }
    return this.cardModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findCardById(id: string): Promise<KnowledgeCardDocument> {
    const card = await this.cardModel.findById(id).exec();
    if (!card) throw new NotFoundException('البطاقة غير موجودة');
    return card;
  }

  async createCard(dto: CreateCardDto, actor: Actor): Promise<KnowledgeCardDocument> {
    const folder = await this.folderModel.findById(dto.folderId).exec();
    if (!folder) throw new BadRequestException('الفولدر المحدد غير موجود');
    const actorName = actor.name || actor.username || '';
    const card = await this.cardModel.create({
      ...dto,
      createdBy: actorName,
      updatedBy: actorName,
    });
    await this.logAudit('card', String(card._id), 'created', actor, `أنشأ بطاقة: ${card.title}`);
    return card;
  }

  async updateCard(id: string, dto: UpdateCardDto, actor: Actor): Promise<KnowledgeCardDocument> {
    const card = await this.cardModel.findById(id).exec();
    if (!card) throw new NotFoundException('البطاقة غير موجودة');
    if (dto.folderId) {
      const folder = await this.folderModel.findById(dto.folderId).exec();
      if (!folder) throw new BadRequestException('الفولدر المحدد غير موجود');
    }
    Object.assign(card, dto, { updatedBy: actor.name || actor.username || '' });
    const saved = await card.save();
    await this.logAudit('card', String(card._id), 'updated', actor, `عدّل بطاقة: ${card.title}`);
    return saved;
  }

  async removeCard(id: string, actor: Actor): Promise<void> {
    const card = await this.cardModel.findById(id).exec();
    if (!card) throw new NotFoundException('البطاقة غير موجودة');
    await this.cardModel.findByIdAndDelete(id).exec();
    await this.logAudit('card', id, 'deleted', actor, `حذف بطاقة: ${card.title}`);
  }

  async trackCopy(id: string): Promise<{ copyCount: number }> {
    const card = await this.cardModel
      .findByIdAndUpdate(id, { $inc: { copyCount: 1 } }, { new: true })
      .exec();
    if (!card) throw new NotFoundException('البطاقة غير موجودة');
    return { copyCount: card.copyCount };
  }

  // ── Analytics ──

  async getAnalytics() {
    const cards = await this.cardModel
      .find({ isActive: true })
      .sort({ copyCount: -1 })
      .limit(10)
      .lean()
      .exec();

    const allCards = await this.cardModel.find({ isActive: true }).lean().exec();
    const grandTotalCopies = allCards.reduce((sum, c) => sum + (c.copyCount || 0), 0);

    const folderBreakdownMap = new Map<string, { folderId: string; copyCount: number; cardCount: number }>();
    for (const c of allCards) {
      const key = String(c.folderId);
      const entry = folderBreakdownMap.get(key) || { folderId: key, copyCount: 0, cardCount: 0 };
      entry.copyCount += c.copyCount || 0;
      entry.cardCount += 1;
      folderBreakdownMap.set(key, entry);
    }
    const folders = await this.folderModel.find().lean().exec();
    const folderNameMap = new Map(folders.map((f) => [String(f._id), f.name]));
    const folderBreakdown = Array.from(folderBreakdownMap.values())
      .map((e) => ({ ...e, folderName: folderNameMap.get(e.folderId) || '' }))
      .sort((a, b) => b.copyCount - a.copyCount);

    return {
      topCards: cards.map((c) => ({
        id: String(c._id),
        title: c.title,
        cardType: c.cardType,
        copyCount: c.copyCount || 0,
      })),
      totalCopies: grandTotalCopies,
      totalCards: allCards.length,
      folderBreakdown,
    };
  }
}
