import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PurchaseOrder,
  PurchaseOrderDocument,
} from './schemas/purchase-order.schema';
import {
  CreatePurchaseOrderDto,
  UpdatePoStatusDto,
  UpdatePoDto,
  ConvertPoToInvoiceDto,
} from './dto/purchase-order.dto';
import { TransactionsService } from '../transactions/transactions.service';
import { PurchaseReceivingService } from './purchase-receiving.service';
import { TrackingActor } from '../inventory-units/inventory-units.service';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    @InjectModel(PurchaseOrder.name)
    private readonly poModel: Model<PurchaseOrderDocument>,
    private readonly transactionsService: TransactionsService,
    @Optional() private readonly receiving?: PurchaseReceivingService,
  ) {}

  private async generatePoNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;
    const existing = await this.poModel
      .find({ poNumber: { $regex: `^${prefix}\\d+$` } }, { poNumber: 1 })
      .lean().exec();
    // Deletions leave gaps; count+1 can permanently collide with an existing number.
    // Compare numerically so PO-...-1000 comes after PO-...-999.
    const highest = existing.reduce((max, po) => Math.max(max, Number(po.poNumber.slice(prefix.length))), 0);
    return `${prefix}${String(highest + 1).padStart(3, '0')}`;
  }

  async create(dto: CreatePurchaseOrderDto): Promise<PurchaseOrderDocument> {
    const createdDate = new Date().toISOString().split('T')[0];
    const items = (dto.items || []).map((item) => ({
      productCode: item.productCode,
      productName: item.productName,
      productImage: item.productImage || '',
      qty: item.qty,
      unitPrice: item.unitPrice ?? 0,
      total: (item.qty || 0) * (item.unitPrice ?? 0),
    }));
    const data = {
      ...dto,
      createdDate,
      status: 'معلق',
      items,
      linkedTransactionId: '',
      statusHistory: [
        {
          status: 'معلق',
          changedBy: dto.createdBy,
          changedAt: new Date().toISOString(),
        },
      ],
    };
    // The unique index arbitrates across users and server processes. Only retry
    // a poNumber collision; unrelated database/validation failures must propagate.
    for (let attempt = 0; attempt < 50; attempt++) {
      const poNumber = await this.generatePoNumber();
      try {
        return await this.poModel.create({ ...data, poNumber });
      } catch (error) {
        const duplicate = error as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
        if (duplicate.code !== 11000 || !(duplicate.keyPattern?.poNumber || duplicate.keyValue?.poNumber)) throw error;
      }
    }
    throw new ConflictException('تعذر تخصيص رقم أمر الشراء بسبب طلبات متزامنة كثيرة — حاول مرة أخرى');
  }

  async findAll(): Promise<PurchaseOrderDocument[]> {
    return this.poModel.find().sort({ createdAt: -1 }).exec();
  }

  async findBySupplier(supplierId: string): Promise<PurchaseOrderDocument[]> {
    return this.poModel
      .find({ supplierId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<PurchaseOrderDocument> {
    const po = await this.poModel.findById(id).exec();
    if (!po) throw new NotFoundException('أمر الشراء غير موجود');
    return po;
  }

  async updateStatus(
    id: string,
    dto: UpdatePoStatusDto,
  ): Promise<PurchaseOrderDocument> {
    const po = await this.findById(id);
    if (po.linkedTransactionId) {
      throw new BadRequestException(
        'لا يمكن تغيير حالة أمر شراء محوّل إلى فاتورة بالفعل',
      );
    }

    const update: Record<string, unknown> = {
      status: dto.status,
      $push: {
        statusHistory: {
          status: dto.status,
          changedBy: dto.changedBy,
          changedAt: new Date().toISOString(),
          note: dto.note,
        },
      },
    };

    if (dto.status === 'مستلم' && dto.items?.length) {
      update.items = dto.items.map((item) => ({
        productCode: item.productCode,
        productName: item.productName,
        productImage: item.productImage || '',
        qty: item.qty,
        unitPrice: item.unitPrice ?? 0,
        total: (item.qty || 0) * (item.unitPrice ?? 0),
      }));
    }

    const updated = await this.poModel
      .findOneAndUpdate({ _id: id, linkedTransactionId: { $in: ['', null] } }, update, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('أمر الشراء غير موجود');
    return updated;
  }

  async update(
    id: string,
    dto: UpdatePoDto,
  ): Promise<PurchaseOrderDocument> {
    const po = await this.findById(id);
    if (po.linkedTransactionId) {
      throw new BadRequestException(
        'لا يمكن تعديل أمر شراء محوّل إلى فاتورة بالفعل',
      );
    }
    const patch: Record<string, unknown> = {};
    if (dto.expectedDeliveryDate !== undefined) patch.expectedDeliveryDate = dto.expectedDeliveryDate;
    if (dto.notes !== undefined) patch.notes = dto.notes;
    if (dto.items?.length) {
      patch.items = dto.items.map((item) => ({
        productCode: item.productCode || item.code || '',
        productName: item.productName || item.name || '',
        productImage: item.productImage || '',
        qty: item.qty,
        unitPrice: item.unitPrice ?? item.price ?? 0,
        total: (item.qty || 0) * (item.unitPrice ?? item.price ?? 0),
      }));
    }
    const updated = await this.poModel
      .findOneAndUpdate({ _id: id, linkedTransactionId: { $in: ['', null] } }, patch, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('أمر الشراء غير موجود');
    return updated;
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const po = await this.findById(id);
    if (po.linkedTransactionId) {
      throw new BadRequestException(
        'لا يمكن حذف أمر شراء محوّل إلى فاتورة بالفعل',
      );
    }
    const removed = await this.poModel.findOneAndDelete({ _id: id, linkedTransactionId: { $in: ['', null] } }).exec();
    if (!removed) throw new ConflictException('أمر الشراء تغيّر أثناء الحذف؛ أعد التحميل');
    return { deleted: true };
  }

  async convertToInvoice(
    id: string,
    dto: ConvertPoToInvoiceDto,
    callerRole?: string,
    actor?: TrackingActor,
  ): Promise<any> {
    if (!this.receiving || !actor) throw new ServiceUnavailableException('Authenticated atomic purchase receiving service is required');
    return this.receiving.convert(id, dto, actor);
  }
}
