import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Transaction, TransactionDocument } from '../transactions/schemas/transaction.schema';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { PresenceGateway } from '../auth/presence.gateway';
import { MentionsService } from '../mentions/mentions.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    private readonly presence: PresenceGateway,
    private readonly mentionsService: MentionsService,
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

  async findByName(name: string): Promise<ProductDocument | null> {
    return this.productModel.findOne({ name }).exec();
  }

  async create(dto: CreateProductDto): Promise<ProductDocument> {
    const code = String(dto.code || '').trim();
    const name = String(dto.name || '').trim();
    const [codeConflict, nameConflict] = await Promise.all([
      this.findByCode(code),
      this.findByName(name),
    ]);
    if (codeConflict) {
      throw new ConflictException('الكود موجود بالفعل');
    }
    if (nameConflict) {
      throw new ConflictException('الاسم موجود بالفعل');
    }
    const openingBalance = Math.max(
      0,
      Math.floor(Number(dto.openingBalance ?? 0)),
    );
    const created = await this.productModel.create({
      ...dto,
      code,
      name,
      openingBalance,
    });
    this.emit('product:changed', { action: 'created', product: created });
    this.emit('inventory:changed', { reason: 'product:created', code });
    return created;
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductDocument> {
    const patch: Record<string, unknown> = { ...dto };

    const current = await this.productModel.findById(id).exec();
    if (!current) throw new NotFoundException('الصنف غير موجود');

    let oldCode: string | undefined;
    let newCode: string | undefined;
    if (dto.code !== undefined) {
      newCode = String(dto.code).trim();
      const conflict = await this.productModel.findOne({ code: newCode, _id: { $ne: id } }).exec();
      if (conflict) throw new ConflictException('الكود موجود بالفعل');
      if (current.code !== newCode) oldCode = current.code;
      patch.code = newCode;
    }

    let oldName: string | undefined;
    let newName: string | undefined;
    if (dto.name !== undefined) {
      newName = String(dto.name).trim();
      const conflict = await this.productModel.findOne({ name: newName, _id: { $ne: id } }).exec();
      if (conflict) throw new ConflictException('الاسم موجود بالفعل');
      if (current.name !== newName) oldName = current.name;
      patch.name = newName;
    }

    if (dto.openingBalance !== undefined) {
      patch.openingBalance = Math.max(0, Math.floor(Number(dto.openingBalance)));
    }

    const product = await this.productModel.findByIdAndUpdate(id, patch, { new: true }).exec();
    if (!product) throw new NotFoundException('الصنف غير موجود');

    this.emit('product:changed', { action: 'updated', product });
    this.emit('inventory:changed', { reason: 'product:updated', code: product.code });

    // Sync name, code, and productId on all matching transaction items
    if (oldName || oldCode) {
      await this.syncTransactionItemRefs(id, oldName, product.name, oldCode, product.code);
    }

    return product;
  }

  async syncTransactionItemRefs(
    productId: string,
    oldName: string | undefined,
    newName: string,
    oldCode: string | undefined,
    newCode: string,
  ): Promise<number> {
    // Match items by productId, or by old name, or by old code
    const orClauses: object[] = [{ 'items.productId': productId }];
    if (oldName) orClauses.push({ 'items.name': oldName });
    if (oldCode) orClauses.push({ 'items.code': oldCode });

    const txDocs = await this.transactionModel.find({ $or: orClauses }).exec();
    let modifiedCount = 0;

    for (const tx of txDocs) {
      let changed = false;
      for (const item of tx.items as unknown as Array<Record<string, unknown>>) {
        const matchById = item['productId'] === productId;
        const matchByOldName = oldName && item['name'] === oldName;
        const matchByOldCode = oldCode && item['code'] === oldCode;
        if (matchById || matchByOldName || matchByOldCode) {
          if (item['productId'] !== productId) { item['productId'] = productId; changed = true; }
          if (item['name'] !== newName) { item['name'] = newName; changed = true; }
          if (item['code'] !== newCode) { item['code'] = newCode; changed = true; }
        }
      }
      if (changed) {
        tx.markModified('items');
        await tx.save();
        modifiedCount++;
      }
    }

    this.emit('product:name-synced', { oldName, newName, oldCode, newCode, productId, modifiedCount });
    return modifiedCount;
  }

  /** @deprecated Use syncTransactionItemRefs */
  async syncTransactionItemNames(oldName: string, newName: string, code: string): Promise<number> {
    return this.syncTransactionItemRefs('', oldName, newName, undefined, code);
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

  async batchDeleteByCodes(codes: string[]): Promise<number> {
    const result = await this.productModel
      .deleteMany({ code: { $in: codes } })
      .exec();

    if (result.deletedCount > 0) {
      this.emit('product:changed', { action: 'batch-deleted-by-code', codes, count: result.deletedCount });
      this.emit('inventory:changed', { reason: 'product:batch-deleted', codes, count: result.deletedCount });
    }

    return result.deletedCount;
  }

  /**
   * Backfill productId on all transaction items and sync name/code from current product data.
   * Price is intentionally NOT updated to preserve historical accuracy.
   */
  async syncProductRefs(): Promise<{ txUpdated: number; itemsPatched: number }> {
    const products = await this.productModel.find().exec();
    let txUpdated = 0;
    let itemsPatched = 0;

    for (const product of products) {
      const pid = String(product._id);
      const currentCode = product.code;
      const currentName = product.name;

      // Find transactions that have items matching this product by code or name but missing/wrong productId
      const txDocs = await this.transactionModel.find({
        $or: [
          { 'items.code': currentCode },
          { 'items.name': currentName },
          { 'items.productId': pid },
        ],
      }).exec();

      for (const tx of txDocs) {
        let changed = false;
        for (const item of tx.items as unknown as Array<Record<string, unknown>>) {
          if (item['code'] === currentCode || item['name'] === currentName || item['productId'] === pid) {
            if (item['productId'] !== pid) { item['productId'] = pid; changed = true; itemsPatched++; }
            if (item['name'] !== currentName) { item['name'] = currentName; changed = true; }
            if (item['code'] !== currentCode) { item['code'] = currentCode; changed = true; }
          }
        }
        if (changed) {
          tx.markModified('items');
          await tx.save();
          txUpdated++;
        }
      }
    }

    this.emit('product:refs-synced', { txUpdated, itemsPatched });
    return { txUpdated, itemsPatched };
  }

  async requestProductEdit(
    id: string,
    dto: {
      requestedBy: string;
      requestedById?: string;
      requestedByUsername?: string;
      changes: Record<string, unknown>;
    },
  ): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('الصنف غير موجود');
    if (product.editRequest && product.editRequest.status === 'معلق') {
      throw new BadRequestException('يوجد طلب تعديل معلق بالفعل لهذا الصنف');
    }

    const FIELD_LABELS: Record<string, string> = {
      sellPrice: 'سعر البيع',
      buyPrice: 'سعر الشراء',
      minStock: 'الحد الأدنى',
      openingBalance: 'الرصيد الافتتاحي',
      supplier: 'المورد',
      name: 'الاسم',
      code: 'الكود',
      imageUrl: 'رابط الصورة',
    };

    const changes = Object.entries(dto.changes)
      .filter(([field]) => FIELD_LABELS[field] !== undefined)
      .map(([field, newValue]) => ({
        field,
        label: FIELD_LABELS[field] || field,
        oldValue: (product as unknown as Record<string, unknown>)[field],
        newValue,
      }));

    if (!changes.length) throw new BadRequestException('لا توجد تغييرات مطلوبة');

    product.editRequest = {
      requestedBy: dto.requestedBy,
      requestedById: dto.requestedById,
      requestedByUsername: dto.requestedByUsername,
      requestedAt: new Date().toISOString(),
      status: 'معلق',
      changes,
    } as typeof product.editRequest;
    product.markModified('editRequest');
    await product.save();

    this.emit('product:changed', { action: 'edit-requested', id });
    return product;
  }

  async approveProductEdit(id: string, reviewedBy: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('الصنف غير موجود');
    const req = product.editRequest;
    if (!req || req.status !== 'معلق') throw new BadRequestException('لا يوجد طلب تعديل معلق');

    const patch: Record<string, unknown> = {};
    for (const change of req.changes as Array<{ field: string; newValue: unknown }>) {
      patch[change.field] = change.newValue;
    }
    if (patch.openingBalance !== undefined) {
      patch.openingBalance = Math.max(0, Math.floor(Number(patch.openingBalance)));
    }

    req.status = 'معتمد';
    req.reviewedBy = reviewedBy;
    req.reviewedAt = new Date().toISOString();
    product.markModified('editRequest');

    Object.assign(product, patch);
    for (const key of Object.keys(patch)) product.markModified(key);
    await product.save();

    if (req.requestedById || req.requestedByUsername) {
      await this.mentionsService.create({
        targetUserId: req.requestedById || '',
        targetUsername: req.requestedByUsername,
        targetName: req.requestedBy,
        fromUserId: 'system',
        fromName: reviewedBy,
        txId: String(product._id),
        txRef: product.name,
        commentId: 0,
        commentText: `تمت الموافقة على طلب تعديل الصنف "${product.name}"`,
        read: false,
      });
      this.emit('mentions:changed', { targetUserId: req.requestedById });
    }

    this.emit('product:changed', { action: 'edit-approved', id });
    this.emit('inventory:changed', { reason: 'product:edit-approved', code: product.code });
    return product;
  }

  async rejectProductEdit(id: string, reviewedBy: string, rejectedReason?: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('الصنف غير موجود');
    const req = product.editRequest;
    if (!req || req.status !== 'معلق') throw new BadRequestException('لا يوجد طلب تعديل معلق');

    req.status = 'مرفوض';
    req.reviewedBy = reviewedBy;
    req.reviewedAt = new Date().toISOString();
    if (rejectedReason) req.rejectedReason = rejectedReason;
    product.markModified('editRequest');
    await product.save();

    if (req.requestedById || req.requestedByUsername) {
      await this.mentionsService.create({
        targetUserId: req.requestedById || '',
        targetUsername: req.requestedByUsername,
        targetName: req.requestedBy,
        fromUserId: 'system',
        fromName: reviewedBy,
        txId: String(product._id),
        txRef: product.name,
        commentId: 0,
        commentText: `تم رفض طلب تعديل الصنف "${product.name}"${rejectedReason ? ` — السبب: ${rejectedReason}` : ''}`,
        read: false,
      });
      this.emit('mentions:changed', { targetUserId: req.requestedById });
    }

    this.emit('product:changed', { action: 'edit-rejected', id });
    return product;
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
        // On update via import: if name is changing, check it won't collide with another product
        const newNameTrimmed = String(item.name || '').trim();
        if (newNameTrimmed && newNameTrimmed !== existing.name) {
          const nameConflict = await this.productModel.findOne({ name: newNameTrimmed, _id: { $ne: existing._id } }).exec();
          if (nameConflict) {
            throw new ConflictException(`الاسم "${newNameTrimmed}" موجود بالفعل لصنف آخر`);
          }
        }
        await this.productModel.findByIdAndUpdate(existing._id, row).exec();
        updated++;
      } else {
        // On create via import: check name uniqueness
        const nameConflict = await this.findByName(String(item.name || '').trim());
        if (nameConflict) {
          throw new ConflictException(`الاسم "${String(item.name || '').trim()}" موجود بالفعل`);
        }
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
