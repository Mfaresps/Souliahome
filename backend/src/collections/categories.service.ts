import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Category, CategoryDocument } from './schemas/category.schema';
import { Collection, CollectionDocument } from './schemas/collection.schema';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(Collection.name)
    private readonly collectionModel: Model<CollectionDocument>,
  ) {}

  async findAll(): Promise<(Category & { collectionCount: number })[]> {
    const list = await this.categoryModel.find().sort({ name: 1 }).exec();
    const counts = await this.collectionModel.aggregate([
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));
    return list.map((c) => {
      const obj = c.toObject();
      return { ...obj, collectionCount: countMap.get(c._id.toString()) || 0 };
    });
  }

  async findById(id: string): Promise<Category & { collectionCount: number }> {
    const category = await this.categoryModel.findById(id).exec();
    if (!category) throw new NotFoundException('التصنيف غير موجود');
    const collectionCount = await this.collectionModel
      .countDocuments({ categoryId: id })
      .exec();
    return { ...category.toObject(), collectionCount };
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    const existing = await this.categoryModel
      .findOne({ name: dto.name })
      .exec();
    if (existing) throw new ConflictException('يوجد تصنيف بنفس الاسم بالفعل');

    if (dto.parentId) {
      await this.findById(dto.parentId);
    }

    return this.categoryModel.create(dto);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    if (dto.name) {
      const existing = await this.categoryModel
        .findOne({ name: dto.name, _id: { $ne: id } })
        .exec();
      if (existing)
        throw new ConflictException('يوجد تصنيف بنفس الاسم بالفعل');
    }
    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('لا يمكن أن يكون التصنيف أب لنفسه');
      }
      await this.findById(dto.parentId);
    }

    const updated = await this.categoryModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('التصنيف غير موجود');
    return updated;
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    await this.findById(id);

    const childCount = await this.categoryModel
      .countDocuments({ parentId: id })
      .exec();
    if (childCount > 0) {
      throw new BadRequestException(
        `هذا التصنيف يحتوي على ${childCount} تصنيف فرعي — لا يمكن حذفه`,
      );
    }

    const collectionCount = await this.collectionModel
      .countDocuments({ categoryId: id })
      .exec();
    if (collectionCount > 0) {
      throw new BadRequestException(
        `هذا التصنيف مستخدم في ${collectionCount} مجموعة — لا يمكن حذفه`,
      );
    }

    await this.categoryModel.findByIdAndDelete(id).exec();
    return { deleted: true };
  }
}
