import { Injectable, NotFoundException } from '@nestjs/common';
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
    return this.supplierModel.create(dto);
  }

  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierDocument> {
    const supplier = await this.supplierModel
      .findByIdAndUpdate(id, dto, { new: true })
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
