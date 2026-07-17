import {
  Injectable,
  NotFoundException,
  BadRequestException,
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
import { CreateTransactionDto } from '../transactions/dto/transaction.dto';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    @InjectModel(PurchaseOrder.name)
    private readonly poModel: Model<PurchaseOrderDocument>,
    private readonly transactionsService: TransactionsService,
  ) {}

  private async generatePoNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;
    const count = await this.poModel
      .countDocuments({ poNumber: { $regex: `^${prefix}` } })
      .exec();
    return `${prefix}${String(count + 1).padStart(3, '0')}`;
  }

  async create(dto: CreatePurchaseOrderDto): Promise<PurchaseOrderDocument> {
    const poNumber = await this.generatePoNumber();
    const createdDate = new Date().toISOString().split('T')[0];
    const items = (dto.items || []).map((item) => ({
      productCode: item.productCode,
      productName: item.productName,
      productImage: item.productImage || '',
      qty: item.qty,
      unitPrice: item.unitPrice ?? 0,
      total: (item.qty || 0) * (item.unitPrice ?? 0),
    }));
    return this.poModel.create({
      ...dto,
      poNumber,
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
    });
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
      .findByIdAndUpdate(id, update, { new: true })
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
      .findByIdAndUpdate(id, patch, { new: true })
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
    await this.poModel.findByIdAndDelete(id).exec();
    return { deleted: true };
  }

  async convertToInvoice(
    id: string,
    dto: ConvertPoToInvoiceDto,
    callerRole?: string,
  ): Promise<{ po: PurchaseOrderDocument; transaction: any }> {
    const po = await this.findById(id);

    if (po.status !== 'مستلم') {
      throw new BadRequestException(
        'يجب أن يكون أمر الشراء في حالة "مستلم" قبل التحويل إلى فاتورة',
      );
    }
    if (po.linkedTransactionId) {
      throw new BadRequestException(
        'تم تحويل هذا الأمر إلى فاتورة بالفعل',
      );
    }

    // Items sent from frontend already have {productId, code, name, qty, price, total}
    // Items from PO fallback have {productCode, productName, qty, unitPrice}
    const sourceItems = (dto.items?.length ? dto.items : po.items).map((item: any) => {
      const price = item.price ?? item.unitPrice ?? 0;
      const qty = item.qty || 0;
      return {
        productId: item.productId || '',
        code: item.code || item.productCode || '',
        name: item.name || item.productName || '',
        qty,
        price,
        total: qty * price,
      };
    });

    const itemsTotal = sourceItems.reduce((s, i) => s + i.total, 0);
    const discount = Math.max(0, Math.min(dto.discount ?? 0, itemsTotal));
    const total = itemsTotal - discount;
    const deposit = Math.min(dto.deposit ?? 0, total);
    const account = dto.depMethod || 'كاش';
    const today = new Date().toISOString().split('T')[0];

    const txDto: CreateTransactionDto = {
      date: dto.date || today,
      transactionDate: dto.date || today,
      type: 'مشتريات',
      client: po.supplierName,
      ref: dto.ref,
      notes: dto.notes || `محوّل من أمر شراء ${po.poNumber}`,
      items: sourceItems,
      itemsTotal,
      total,
      discount,
      deposit,
      remaining: Math.max(0, total - deposit),
      payStatus: deposit >= total ? 'مكتمل' : 'معلق',
      depMethod: account,
      payment: account,
      employee: dto.createdBy,
      purchaseOtpId: dto.purchaseOtpId || '',
      invoiceImages: dto.invoiceImages || [],
    } as unknown as CreateTransactionDto;

    const tx = await this.transactionsService.create(txDto, callerRole);

    const updatedPo = await this.poModel
      .findByIdAndUpdate(
        id,
        {
          linkedTransactionId: String(tx._id),
          $push: {
            statusHistory: {
              status: 'محوّل إلى فاتورة',
              changedBy: dto.createdBy,
              changedAt: new Date().toISOString(),
              note: `فاتورة رقم ${dto.ref}`,
            },
          },
        },
        { new: true },
      )
      .exec();

    return { po: updatedPo!, transaction: tx };
  }
}
