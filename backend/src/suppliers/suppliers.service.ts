import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Supplier, SupplierDocument, SupplierActivityEntry } from './schemas/supplier.schema';
import { CreateSupplierDto, UpdateSupplierDto, AddSupplierLogDto } from './dto/supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(
    @InjectModel(Supplier.name)
    private readonly supplierModel: Model<SupplierDocument>,
  ) {}

  /**
   * Keeps `phones` and `phone` consistent on the way in, so no read site has to reconcile them.
   * Trims, drops blanks, de-duplicates, and mirrors the first number into `phone`. Accepts either
   * field alone: a client that only sends `phone` (older callers, imports) gets a one-item
   * `phones`, and a client that only sends `phones` gets `phone` derived from it.
   * Returns the fields to write, or nothing when neither was supplied — so an update that touches
   * only e.g. `notes` never blanks out the phone list.
   */
  private normalizePhones(dto: { phone?: string; phones?: string[] }): { phone: string; phones: string[] } | null {
    if (dto.phones === undefined && dto.phone === undefined) return null;
    const source = dto.phones !== undefined ? dto.phones : [dto.phone as string];
    const phones = (source || [])
      .map(p => String(p ?? '').trim())
      .filter(Boolean)
      .filter((p, i, arr) => arr.indexOf(p) === i);
    return { phones, phone: phones[0] || '' };
  }

  async findAll(): Promise<SupplierDocument[]> {
    return this.supplierModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<SupplierDocument> {
    const supplier = await this.supplierModel.findById(id).exec();
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    return supplier;
  }

  async create(dto: CreateSupplierDto): Promise<SupplierDocument> {
    const normalizedName = dto.name.trim();
    const existing = await this.supplierModel
      .findOne({ name: { $regex: `^${normalizedName}$`, $options: 'i' } })
      .exec();
    if (existing) {
      throw new ConflictException('المورد موجود بالفعل. يرجى تحديث السجل الموجود.');
    }
    const entry: SupplierActivityEntry = {
      action: 'إنشاء مورد',
      detail: `تم إنشاء المورد "${normalizedName}"`,
      by: dto.by || 'النظام',
      at: new Date().toISOString(),
    };
    return this.supplierModel.create({
      ...dto,
      ...(this.normalizePhones(dto) || {}),
      name: normalizedName,
      activityLog: [entry],
    });
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierDocument> {
    const updateData: Record<string, unknown> = { ...dto };
    delete updateData['by'];

    if (updateData['name']) {
      const normalizedName = String(updateData['name']).trim();
      const existing = await this.supplierModel
        .findOne({ name: { $regex: `^${normalizedName}$`, $options: 'i' }, _id: { $ne: id } })
        .exec();
      if (existing) throw new ConflictException('يوجد مورد آخر بهذا الاسم بالفعل.');
      updateData['name'] = normalizedName;
    }

    const normalized = this.normalizePhones(dto);
    if (normalized) Object.assign(updateData, normalized);

    const entry: SupplierActivityEntry = {
      action: 'تعديل بيانات المورد',
      detail: Object.keys(dto)
        .filter(k => k !== 'by' && (dto as any)[k] !== undefined)
        .map(k => k)
        .join('، '),
      by: dto.by || 'النظام',
      at: new Date().toISOString(),
    };

    const supplier = await this.supplierModel
      .findByIdAndUpdate(
        id,
        { ...updateData, $push: { activityLog: entry } },
        { new: true },
      )
      .exec();
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    return supplier;
  }

  async remove(id: string, by?: string): Promise<void> {
    const result = await this.supplierModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('المورد غير موجود');
  }

  async addLog(id: string, dto: AddSupplierLogDto): Promise<SupplierDocument> {
    const entry: SupplierActivityEntry = {
      action: dto.action,
      detail: dto.detail || '',
      by: dto.by || 'النظام',
      at: new Date().toISOString(),
    };
    const supplier = await this.supplierModel
      .findByIdAndUpdate(id, { $push: { activityLog: entry } }, { new: true })
      .exec();
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    return supplier;
  }
}
