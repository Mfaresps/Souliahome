import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Collection, CollectionDocument } from './schemas/collection.schema';
import { Category, CategoryDocument } from './schemas/category.schema';
import {
  CollectionProduct,
  CollectionProductDocument,
} from './schemas/collection-product.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Supplier,
  SupplierDocument,
} from '../suppliers/schemas/supplier.schema';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
} from './dto/collection.dto';

@Injectable()
export class CollectionsService {
  constructor(
    @InjectModel(Collection.name)
    private readonly collectionModel: Model<CollectionDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(CollectionProduct.name)
    private readonly collectionProductModel: Model<CollectionProductDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Supplier.name)
    private readonly supplierModel: Model<SupplierDocument>,
  ) {}

  private async logActivity(
    collectionId: string,
    action: string,
    detail: string,
    by: string,
  ) {
    await this.collectionModel
      .findByIdAndUpdate(collectionId, {
        $push: {
          activityLog: { action, detail, by, at: new Date().toISOString() },
        },
      })
      .exec();
  }

  /**
   * Next sequential code for the current year, derived from the HIGHEST existing
   * number — not from the document count. Counting breaks permanently after any
   * delete (5 collections, delete one, count+1 regenerates an existing code) and
   * `code` is a unique index, so every subsequent create failed with E11000.
   */
  private async generateCode(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `COL-${year}-`;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await this.collectionModel
      .find({ code: { $regex: `^${escaped}` } }, { code: 1 })
      .lean()
      .exec();
    // Numeric max, not a lexicographic sort — codes past 999 lose zero-padding
    // and would otherwise sort "1000" below "999".
    const maxNum = existing.reduce((max, doc) => {
      const n = parseInt(String(doc.code).slice(prefix.length), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    return `${prefix}${String(maxNum + 1).padStart(3, '0')}`;
  }

  async findAll(): Promise<Collection[]> {
    return this.collectionModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<Collection> {
    const collection = await this.collectionModel.findById(id).exec();
    if (!collection) throw new NotFoundException('المجموعة غير موجودة');
    return collection;
  }

  async findByCategory(categoryId: string): Promise<Collection[]> {
    return this.collectionModel
      .find({ categoryId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async create(dto: CreateCollectionDto, actor: string): Promise<Collection> {
    const existing = await this.collectionModel
      .findOne({ name: dto.name })
      .exec();
    if (existing)
      throw new ConflictException('يوجد مجموعة بنفس الاسم بالفعل');

    const category = await this.categoryModel.findById(dto.categoryId).exec();
    if (!category) throw new NotFoundException('التصنيف غير موجود');

    // generateCode() reads-then-writes, so two concurrent creates can pick the same
    // number. Retry on the unique-index violation instead of surfacing it to the user.
    let created: CollectionDocument | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await this.generateCode();
      try {
        created = await this.collectionModel.create({ ...dto, code });
        break;
      } catch (err) {
        const isDupCode =
          (err as { code?: number })?.code === 11000 &&
          'keyPattern' in (err as object) &&
          'code' in ((err as { keyPattern?: object }).keyPattern || {});
        if (!isDupCode || attempt === 4) throw err;
      }
    }
    if (!created)
      throw new ConflictException('تعذّر توليد كود للمجموعة — حاول مرة أخرى');

    await this.logActivity(
      created._id.toString(),
      'إنشاء مجموعة',
      `تم إنشاء المجموعة "${created.name}"`,
      actor,
    );
    return this.findById(created._id.toString());
  }

  async update(
    id: string,
    dto: UpdateCollectionDto,
    actor: string,
  ): Promise<Collection> {
    if (dto.name) {
      const existing = await this.collectionModel
        .findOne({ name: dto.name, _id: { $ne: id } })
        .exec();
      if (existing)
        throw new ConflictException('يوجد مجموعة بنفس الاسم بالفعل');
    }
    if (dto.categoryId) {
      const category = await this.categoryModel
        .findById(dto.categoryId)
        .exec();
      if (!category) throw new NotFoundException('التصنيف غير موجود');
    }

    const before = await this.findById(id);
    const updated = await this.collectionModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('المجموعة غير موجودة');

    const statusChanged = dto.status && dto.status !== before.status;
    await this.logActivity(
      id,
      statusChanged ? 'تغيير حالة المجموعة' : 'تعديل بيانات المجموعة',
      statusChanged
        ? `الحالة: ${before.status} → ${dto.status}`
        : 'تم تحديث بيانات المجموعة',
      actor,
    );
    return updated;
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    await this.findById(id);
    await this.collectionProductModel.deleteMany({ collectionId: id }).exec();
    await this.collectionModel.findByIdAndDelete(id).exec();
    return { deleted: true };
  }

  async getProducts(collectionId: string) {
    await this.findById(collectionId);
    const links = await this.collectionProductModel
      .find({ collectionId })
      .sort({ addedAt: -1 })
      .exec();
    const productIds = links.map((l) => l.productId);
    const products = await this.productModel
      .find({ _id: { $in: productIds } })
      .exec();
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));
    return links
      .map((l) => ({
        product: productMap.get(l.productId) || null,
        addedBy: l.addedBy,
        addedAt: l.addedAt,
      }))
      .filter((l) => l.product);
  }

  async assignProducts(
    collectionId: string,
    productIds: string[],
    actor: string,
  ): Promise<{ added: number; skipped: number }> {
    await this.findById(collectionId);

    const products = await this.productModel
      .find({ _id: { $in: productIds } })
      .exec();
    const validIds = new Set(products.map((p) => p._id.toString()));
    const invalidCount = productIds.length - validIds.size;
    if (invalidCount > 0 && validIds.size === 0) {
      throw new BadRequestException('لم يتم العثور على أي من الأصناف المحددة');
    }

    const existingLinks = await this.collectionProductModel
      .find({ collectionId, productId: { $in: Array.from(validIds) } })
      .exec();
    const alreadyAssigned = new Set(existingLinks.map((l) => l.productId));

    const toAdd = Array.from(validIds).filter(
      (id) => !alreadyAssigned.has(id),
    );
    const now = new Date().toISOString();
    if (toAdd.length > 0) {
      await this.collectionProductModel.insertMany(
        toAdd.map((productId) => ({
          collectionId,
          productId,
          addedBy: actor,
          addedAt: now,
        })),
      );
      await this.logActivity(
        collectionId,
        'إضافة أصناف',
        `تمت إضافة ${toAdd.length} صنف إلى المجموعة`,
        actor,
      );
    }

    return {
      added: toAdd.length,
      skipped: productIds.length - toAdd.length,
    };
  }

  async removeProduct(
    collectionId: string,
    productId: string,
    actor: string,
  ): Promise<{ removed: boolean }> {
    await this.findById(collectionId);
    const product = await this.productModel.findById(productId).exec();
    const result = await this.collectionProductModel
      .findOneAndDelete({ collectionId, productId })
      .exec();
    if (!result) throw new NotFoundException('الصنف غير مرتبط بهذه المجموعة');

    await this.logActivity(
      collectionId,
      'إزالة صنف',
      `تمت إزالة الصنف "${product?.name || productId}" من المجموعة`,
      actor,
    );
    return { removed: true };
  }

  async linkSupplier(
    collectionId: string,
    supplierId: string,
    actor: string,
  ): Promise<Collection> {
    const collection = await this.findById(collectionId);
    const supplier = await this.supplierModel.findById(supplierId).exec();
    if (!supplier) throw new NotFoundException('المورد غير موجود');

    if (collection.supplierIds.includes(supplierId)) {
      return collection;
    }

    const updated = await this.collectionModel
      .findByIdAndUpdate(
        collectionId,
        { $addToSet: { supplierIds: supplierId } },
        { new: true },
      )
      .exec();
    await this.logActivity(
      collectionId,
      'ربط مورد',
      `تم ربط المورد "${supplier.name}" بالمجموعة`,
      actor,
    );
    return updated as Collection;
  }

  async unlinkSupplier(
    collectionId: string,
    supplierId: string,
    actor: string,
  ): Promise<Collection> {
    await this.findById(collectionId);
    const supplier = await this.supplierModel.findById(supplierId).exec();

    const updated = await this.collectionModel
      .findByIdAndUpdate(
        collectionId,
        { $pull: { supplierIds: supplierId } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('المجموعة غير موجودة');

    await this.logActivity(
      collectionId,
      'إلغاء ربط مورد',
      `تم إلغاء ربط المورد "${supplier?.name || supplierId}" بالمجموعة`,
      actor,
    );
    return updated;
  }

  async searchAssignableProducts(partial: string, limit = 20) {
    // Treat the term as a literal substring — an unescaped RegExp here throws a 500 on
    // ordinary input like "(" or "[", and "." (sent by the picker for an empty query)
    // must match everything rather than any single char.
    const term = (partial || '').trim();
    const filter =
      !term || term === '.'
        ? {}
        : (() => {
            const regex = new RegExp(
              term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              'i',
            );
            return { $or: [{ name: regex }, { code: regex }] };
          })();
    return this.productModel.find(filter).limit(limit).exec();
  }

  /**
   * One-call lookup for the Products page: productId -> which collection/category it's
   * assigned to (a product can belong to at most one collection). Avoids N+1 calls.
   */
  async getProductCollectionMap(): Promise<
    Record<
      string,
      {
        collectionId: string;
        collectionName: string;
        categoryId: string | null;
        categoryName: string | null;
      }
    >
  > {
    const [links, collections, categories] = await Promise.all([
      this.collectionProductModel.find().exec(),
      this.collectionModel.find().exec(),
      this.categoryModel.find().exec(),
    ]);
    const collectionMap = new Map(collections.map((c) => [c._id.toString(), c]));
    const categoryMap = new Map(categories.map((c) => [c._id.toString(), c]));

    const result: Record<
      string,
      {
        collectionId: string;
        collectionName: string;
        categoryId: string | null;
        categoryName: string | null;
      }
    > = {};
    for (const link of links) {
      const collection = collectionMap.get(link.collectionId);
      if (!collection) continue;
      const category = collection.categoryId
        ? categoryMap.get(collection.categoryId)
        : null;
      result[link.productId] = {
        collectionId: link.collectionId,
        collectionName: collection.name,
        categoryId: collection.categoryId || null,
        categoryName: category?.name || null,
      };
    }
    return result;
  }
}
