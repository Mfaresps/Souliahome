import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Supplier, SupplierDocument } from './schemas/supplier.schema';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(
    @InjectModel(Supplier.name)
    private readonly supplierModel: Model<SupplierDocument>,
  ) {}

  async findAll(): Promise<SupplierDocument[]> {
    return this.supplierModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<SupplierDocument> {
    const supplier = await this.supplierModel.findById(id).exec();
    if (!supplier) {
      throw new NotFoundException('المورد غير موجود');
    }
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
    return this.supplierModel.create({ ...dto, name: normalizedName });
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierDocument> {
    const updateData: Record<string, unknown> = { ...dto };
    if (updateData['name']) {
      const normalizedName = String(updateData['name']).trim();
      const existing = await this.supplierModel
        .findOne({ name: { $regex: `^${normalizedName}$`, $options: 'i' }, _id: { $ne: id } })
        .exec();
      if (existing) {
        throw new ConflictException('يوجد مورد آخر بهذا الاسم بالفعل.');
      }
      updateData['name'] = normalizedName;
    }
    const supplier = await this.supplierModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .exec();
    if (!supplier) {
      throw new NotFoundException('المورد غير موجود');
    }
    return supplier;
  }

  async remove(id: string): Promise<void> {
    const result = await this.supplierModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('المورد غير موجود');
    }
  }
}
