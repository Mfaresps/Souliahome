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
    
    if (result.modifiedCount > 0) {
      this.emit('product:changed', { action: 'bulk-updated', ids, count: result.modifiedCount });
      this.emit('inventory:changed', { reason: 'product:bulk-updated', ids, count: result.modifiedCount });
    }
    
    return result.modifiedCount;
  }

  async bulkDelete(ids: string[]): Promise<number> {
    const result = await this.productModel
      .deleteMany({ _id: { $in: ids } })
      .exec();
    
    if (result.deletedCount > 0) {
      this.emit('product:changed', { action: 'bulk-deleted', ids, count: result.deletedCount });
      this.emit('inventory:changed', { reason: 'product:bulk-deleted', ids, count: result.deletedCount });
    }
    
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
    // #region agent log
    fetch('http://127.0.0.1:7285/ingest/76d98979-170a-4e37-ae45-7d75cc90954a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a36edf'},body:JSON.stringify({sessionId:'a36edf',location:'products.service.ts:145',message:'importProducts called',data:{itemCount:items.length,items:items.slice(0,3)},timestamp:Date.now(),hypothesisId:'A,B,C,D,E'})}).catch(()=>{});
    // #endregion
    let created = 0;
    let updated = 0;
    for (const item of items) {
      // #region agent log
      fetch('http://127.0.0.1:7285/ingest/76d98979-170a-4e37-ae45-7d75cc90954a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a36edf'},body:JSON.stringify({sessionId:'a36edf',location:'products.service.ts:159',message:'Processing item - BEFORE trim',data:{rawCode:item.code,rawCodeType:typeof item.code,rawName:item.name,rawNameType:typeof item.name,codeIsNull:item.code===null,codeIsUndefined:item.code===undefined,nameIsNull:item.name===null,nameIsUndefined:item.name===undefined},timestamp:Date.now(),hypothesisId:'A,C,D'})}).catch(()=>{});
      // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7285/ingest/76d98979-170a-4e37-ae45-7d75cc90954a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a36edf'},body:JSON.stringify({sessionId:'a36edf',location:'products.service.ts:170',message:'Row prepared - AFTER trim',data:{finalCode:row.code,finalCodeLength:row.code.length,finalName:row.name,finalNameLength:row.name.length,codeEmpty:row.code==='',nameEmpty:row.name===''},timestamp:Date.now(),hypothesisId:'A,C'})}).catch(()=>{});
      // #endregion
      const existing = await this.findByCode(code);
      if (existing) {
        await this.productModel.findByIdAndUpdate(existing._id, row).exec();
        updated++;
      } else {
        // #region agent log
        fetch('http://127.0.0.1:7285/ingest/76d98979-170a-4e37-ae45-7d75cc90954a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a36edf'},body:JSON.stringify({sessionId:'a36edf',location:'products.service.ts:176',message:'Creating new product',data:{rowToCreate:row},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        await this.productModel.create(row);
        created++;
      }
    }
    
    if (created > 0 || updated > 0) {
      this.emit('product:changed', { action: 'imported', created, updated });
      this.emit('inventory:changed', { reason: 'product:imported', created, updated });
    }
    
    return { created, updated };
  }
}
