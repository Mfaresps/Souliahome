import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tag, TagDocument } from './schemas/tag.schema';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

@Injectable()
export class TagsService {
  constructor(
    @InjectModel(Tag.name) private readonly tagModel: Model<TagDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
  ) {}

  async findAll(): Promise<Tag[]> {
    return this.tagModel.find().sort({ name: 1 }).exec();
  }

  async create(dto: CreateTagDto): Promise<Tag> {
    // Check if tag exists (idempotent: return existing on duplicate)
    const existing = await this.tagModel.findOne({ name: dto.name }).exec();
    if (existing) return existing;

    // Try to create
    try {
      const created = await this.tagModel.create(dto);
      return created;
    } catch (err: any) {
      // Handle duplicate key error (E11000)
      if (err.code === 11000) {
        const existing = await this.tagModel.findOne({ name: dto.name }).exec();
        if (existing) return existing;
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateTagDto): Promise<Tag> {
    const updated = await this.tagModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('TAG not found');
    return updated;
  }

  async remove(id: string): Promise<{ deleted: boolean; message?: string }> {
    const tag = await this.tagModel.findById(id).exec();
    if (!tag) throw new NotFoundException('TAG not found');

    // Check if tag is linked to any transaction
    const count = await this.transactionModel
      .countDocuments({ tags: tag.name })
      .exec();

    if (count > 0) {
      throw new BadRequestException(
        `هذا TAG مستخدم في ${count} حركة — لا يمكن حذفه`,
      );
    }

    await this.tagModel.findByIdAndDelete(id).exec();
    return { deleted: true };
  }
}
