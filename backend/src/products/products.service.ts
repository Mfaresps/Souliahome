import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { PresenceGateway } from '../auth/presence.gateway';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly presence: PresenceGateway,
  ) {}

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  async findAll(): Promise<ProductDocument[]> {
    return this.productModel.find().sort({ code: 1 }).exec();
  }

  async findById(id: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) {
      throw new NotFoundException('الصنف غير موجود');
    }
    return product;
  }

  async findByCode(code: string): Promise<ProductDocument | null> {
    return this.productModel.findOne({ code }).exec();
  }

  async create(dto: CreateProductDto): Promise<ProductDocument> {
    const code = String(dto.code || '').trim();
    const existing = await this.findByCode(code);
    if (existing) {
      throw new ConflictException('الكود موجود بالفعل');
    }
    const openingBalance = Math.max(
      0,
      Math.floor(Number(dto.openingBalance ?? 0)),
    );
    const created = await this.productModel.create({
      ...dto,
      code,
      name: String(dto.name || '').trim(),
      openingBalance,
    });
    this.emit('product:changed', { action: 'created', product: created });
    this.emit('inventory:changed', { reason: 'product:created', code });
    return created;
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductDocument> {
    const patch: Record<string, unknown> = { ...dto };
    if (dto.code !== undefined) {
      patch.code = String(dto.code).trim();
    }
    if (dto.name !== undefined) {
      patch.name = String(dto.name).trim();
    }
    if (dto.openingBalance !== undefined) {
      patch.openingBalance = Math.max(
        0,
        Math.floor(Number(dto.openingBalance)),
      );
    }
    const product = await this.productModel
      .findByIdAndUpdate(id, patch, { new: true })
      .exec();
    if (!product) {
      throw new NotFoundException('الصنف غير موجود');
    }
    this.emit('product:changed', { action: 'updated', product });
    this.emit('inventory:changed', { reason: 'product:updated', code: product.code });
    return product;
  }

  async remove(id: string): Promise<void> {
    const result = await this.productModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('الصنف غير موجود');
    }
    this.emit('product:changed', { action: 'deleted', id });
    this.emit('inventory:changed', { reason: 'product:deleted', id });
  }

  async countProducts(): Promise<number> {
    return this.productModel.countDocuments().exec();
  }

  async bulkUpdate(
    ids: string[],
    fields: {
      sellPrice?: number;
      buyPrice?: number;
      minStock?: number;
      openingBalance?: number;
      supplier?: string;
    },
  ): Promise<number> {
    const update: Record<string, number | string> = {};
    if (fields.sellPrice !== undefined && fields.sellPrice >= 0)
      update.sellPrice = fields.sellPrice;
    if (fields.buyPrice !== undefined && fields.buyPrice >= 0)
      update.buyPrice = fields.buyPrice;
    if (fields.minStock !== undefined && fields.minStock >= 0)
      update.minStock = fields.minStock;
    if (fields.openingBalance !== undefined && fields.openingBalance >= 0) {
      update.openingBalance = Math.max(
        0,
        Math.floor(Number(fields.openingBalance)),
      );
    }
    if (fields.supplier !== undefined) update.supplier = fields.supplier;
    if (!Object.keys(update).length) return 0;
    const result = await this.productModel
      .updateMany({ _id: { $in: ids } }, update)
      .exec();
    return result.modifiedCount;
  }

  async bulkDelete(ids: string[]): Promise<number> {
    const result = await this.productModel
      .deleteMany({ _id: { $in: ids } })
      .exec();
    return result.deletedCount;
  }

  async importProducts(
    items: {
      code: string;
      name: string;
      sellPrice?: number;
      buyPrice?: number;
      minStock?: number;
      openingBalance?: number;
      supplier?: string;
      imageUrl?: string;
    }[],
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const item of items) {
      const code = String(item.code || '').trim();
      const openingBalance = Math.max(
        0,
        Math.floor(Number(item.openingBalance ?? 0)),
      );
      const row = {
        ...item,
        code,
        name: String(item.name || '').trim(),
        openingBalance,
      };
      const existing = await this.findByCode(code);
      if (existing) {
        await this.productModel.findByIdAndUpdate(existing._id, row).exec();
        updated++;
      } else {
        await this.productModel.create(row);
        created++;
      }
    }
    return { created, updated };
  }
}
