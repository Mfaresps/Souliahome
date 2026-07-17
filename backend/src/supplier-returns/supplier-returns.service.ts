import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SupplierReturnOrder,
  SupplierReturnOrderDocument,
  SrStatusEntry,
} from './schemas/supplier-return.schema';
import {
  CreateSupplierReturnDto,
  UpdateSupplierReturnDto,
} from './dto/supplier-return.dto';
import { TransactionsService } from '../transactions/transactions.service';
import { SuppliersService } from '../suppliers/suppliers.service';

const VAULT_AR_LABELS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'] as const;

const VAULT_CODE_TO_AR: Record<string, (typeof VAULT_AR_LABELS)[number]> = {
  cash: 'كاش',
  vodafone: 'فودافون كاش',
  instapay: 'Instapay',
  bank: 'تحويل بنكي',
};

function normalizeVaultAccountLabel(
  v: string | undefined,
): (typeof VAULT_AR_LABELS)[number] | undefined {
  if (!v) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  if ((VAULT_AR_LABELS as readonly string[]).includes(t)) {
    return t as (typeof VAULT_AR_LABELS)[number];
  }
  return VAULT_CODE_TO_AR[t.toLowerCase()];
}

const NON_TERMINAL_STATUSES = ['مسودة', 'معلق', 'معتمد'];

@Injectable()
export class SupplierReturnsService {
  constructor(
    @InjectModel(SupplierReturnOrder.name)
    private readonly srModel: Model<SupplierReturnOrderDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly suppliersService: SuppliersService,
  ) {}

  private async generateReturnNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `SR-${year}-`;
    const last = await this.srModel
      .findOne({ returnNumber: { $regex: `^${prefix}` } })
      .sort({ returnNumber: -1 })
      .exec();
    let seq = 1;
    if (last) {
      const m = /(\d+)$/.exec(last.returnNumber);
      if (m) seq = parseInt(m[1], 10) + 1;
    }
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  private sumItemsTotal(items: { total?: number }[]): number {
    return Math.round(
      (items || []).reduce((s, it) => s + (Number(it.total) || 0), 0),
    );
  }

  /** Prior returned qty per product code, across all non-rejected/non-cancelled supplier returns of this invoice. */
  private async getAlreadyReturnedQtyByCode(
    originalTransactionId: string,
    excludeId?: string,
  ): Promise<Map<string, number>> {
    const query: Record<string, unknown> = {
      originalTransactionId,
      status: { $nin: ['مرفوض', 'ملغي'] },
    };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }
    const prior = await this.srModel.find(query).exec();
    const map = new Map<string, number>();
    for (const r of prior) {
      for (const it of r.items || []) {
        const code = String(it.code || '').trim();
        if (!code) continue;
        map.set(code, (map.get(code) || 0) + (Number(it.qty) || 0));
      }
    }
    return map;
  }

  /** Validates requested items against the original invoice's items and remaining returnable qty/price ceiling. */
  private async validateItemsAgainstOriginal(
    originalTransactionId: string,
    requestedItems: { code: string; name: string; qty: number; price: number; note?: string }[],
    excludeId?: string,
  ): Promise<{ code: string; name: string; qty: number; price: number; total: number; note?: string }[]> {
    if (!requestedItems || !requestedItems.length) {
      throw new BadRequestException('يجب اختيار صنف واحد على الأقل للإرجاع');
    }
    const originalTx = await this.transactionsService.findById(
      originalTransactionId,
    );
    if (originalTx.type !== 'مشتريات') {
      throw new BadRequestException(
        'يمكن إنشاء مرتجع مورد فقط من فاتورة مشتريات',
      );
    }
    if (originalTx.cancelled) {
      throw new BadRequestException('لا يمكن إرجاع أصناف من فاتورة ملغاة');
    }
    const originalByCode = new Map<string, { qty: number; price: number }>();
    for (const it of originalTx.items || []) {
      const code = String(it.code || '').trim();
      if (!code) continue;
      const prev = originalByCode.get(code);
      originalByCode.set(code, {
        qty: (prev?.qty || 0) + (Number(it.qty) || 0),
        price: Number(it.price) || 0,
      });
    }
    const alreadyReturned = await this.getAlreadyReturnedQtyByCode(
      originalTransactionId,
      excludeId,
    );
    const errors: string[] = [];
    const validated = requestedItems.map((it) => {
      const code = String(it.code || '').trim();
      const original = originalByCode.get(code);
      if (!original) {
        errors.push(`الصنف ${code} غير موجود في الفاتورة الأصلية`);
        return null;
      }
      const qty = Number(it.qty) || 0;
      if (qty <= 0) {
        errors.push(`كمية غير صالحة للصنف ${code}`);
        return null;
      }
      const returnedSoFar = alreadyReturned.get(code) || 0;
      const remaining = original.qty - returnedSoFar;
      if (qty > remaining) {
        errors.push(
          `${code}: المطلوب إرجاعه ${qty} — المتاح للإرجاع ${remaining} (تم إرجاع ${returnedSoFar} مسبقاً من أصل ${original.qty})`,
        );
        return null;
      }
      const price = Number(it.price);
      if (!Number.isFinite(price) || price < 0) {
        errors.push(`سعر غير صالح للصنف ${code}`);
        return null;
      }
      if (price > original.price) {
        errors.push(
          `${code}: سعر الإرجاع (${price}) لا يمكن أن يتجاوز سعر الشراء الأصلي (${original.price})`,
        );
        return null;
      }
      return {
        code,
        name: it.name || code,
        qty,
        price,
        total: qty * price,
        note: it.note || '',
      };
    });
    if (errors.length) {
      throw new BadRequestException(errors.join('؛ '));
    }
    return validated as {
      code: string;
      name: string;
      qty: number;
      price: number;
      total: number;
      note?: string;
    }[];
  }

  async findAll(): Promise<SupplierReturnOrderDocument[]> {
    return this.srModel.find().sort({ createdAt: -1 }).exec();
  }

  async findBySupplier(
    supplierId: string,
  ): Promise<SupplierReturnOrderDocument[]> {
    return this.srModel.find({ supplierId }).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<SupplierReturnOrderDocument> {
    const r = await this.srModel.findById(id).exec();
    if (!r) {
      throw new NotFoundException('مرتجع المورد غير موجود');
    }
    return r;
  }

  async create(
    dto: CreateSupplierReturnDto,
    requestedBy: string,
  ): Promise<SupplierReturnOrderDocument> {
    const vaultRefundAccount = normalizeVaultAccountLabel(
      dto.vaultRefundAccount,
    );
    if (!vaultRefundAccount) {
      throw new BadRequestException('حدد قسم الخزنة الذي سيُضاف إليه مبلغ الرد');
    }
    const validatedItems = await this.validateItemsAgainstOriginal(
      dto.originalTransactionId,
      dto.items,
    );
    const originalTx = await this.transactionsService.findById(
      dto.originalTransactionId,
    );
    const itemsTotal = this.sumItemsTotal(validatedItems);
    const status = dto.saveAsDraft ? 'مسودة' : 'معلق';
    const returnNumber = await this.generateReturnNumber();
    const now = new Date().toISOString();
    const statusEntry: SrStatusEntry = {
      status,
      changedBy: requestedBy,
      changedAt: now,
      note: dto.saveAsDraft ? 'إنشاء كمسودة' : 'إنشاء وإرسال للاعتماد',
    };
    const created = await this.srModel.create({
      supplierId: dto.supplierId,
      supplierName: dto.supplierName,
      returnNumber,
      originalTransactionId: dto.originalTransactionId,
      originalRef: dto.originalRef || originalTx.ref || dto.originalTransactionId,
      originalDate: dto.originalDate || originalTx.date,
      returnDate: now.split('T')[0],
      reason: dto.reason,
      reasonDetails: dto.reasonDetails || '',
      items: validatedItems,
      itemsTotal,
      total: itemsTotal,
      status,
      vaultRefundAccount,
      createdBy: requestedBy,
      linkedTransactionId: '',
      statusHistory: [statusEntry],
    });
    await this.suppliersService.addLog(dto.supplierId, {
      action: 'إنشاء مرتجع مورد',
      detail: `مرتجع ${returnNumber} — ${itemsTotal} ج من الفاتورة ${created.originalRef}`,
      by: requestedBy,
    });
    return created;
  }

  /** يسمح بتعديل الأصناف/السبب/قسم الخزنة طالما الطلب لم يُعتمد بعد. */
  async update(
    id: string,
    dto: UpdateSupplierReturnDto,
    by: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (!['مسودة', 'معلق'].includes(r.status)) {
      throw new BadRequestException(
        'لا يمكن تعديل هذا الطلب بعد اعتماده أو إتمامه أو رفضه',
      );
    }
    let vaultRefundAccount = r.vaultRefundAccount;
    if (dto.vaultRefundAccount) {
      const normalized = normalizeVaultAccountLabel(dto.vaultRefundAccount);
      if (!normalized) {
        throw new BadRequestException('قسم الخزنة غير صالح');
      }
      vaultRefundAccount = normalized;
    }
    if (dto.items) {
      const validatedItems = await this.validateItemsAgainstOriginal(
        r.originalTransactionId,
        dto.items,
        String(r._id),
      );
      r.items = validatedItems;
      r.itemsTotal = this.sumItemsTotal(validatedItems);
      r.total = r.itemsTotal;
    }
    if (dto.reason) {
      r.reason = dto.reason;
    }
    if (dto.reasonDetails !== undefined) {
      r.reasonDetails = dto.reasonDetails;
    }
    r.vaultRefundAccount = vaultRefundAccount;
    r.statusHistory.push({
      status: r.status,
      changedBy: by,
      changedAt: new Date().toISOString(),
      note: 'تعديل بيانات المرتجع',
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'تعديل مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — ${r.total} ج`,
      by,
    });
    return saved;
  }

  async submitForApproval(
    id: string,
    by: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'مسودة') {
      throw new BadRequestException('لا يمكن إرسال هذا الطلب — ليس في حالة مسودة');
    }
    r.status = 'معلق';
    r.statusHistory.push({
      status: 'معلق',
      changedBy: by,
      changedAt: new Date().toISOString(),
    });
    return r.save();
  }

  async approve(
    id: string,
    approvedBy: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'معلق') {
      throw new BadRequestException('الطلب ليس معلقاً');
    }
    // إعادة التحقق من الأصناف قبل الاعتماد (دفاع ضد تعديل الفاتورة الأصلية بعد الإنشاء)
    await this.validateItemsAgainstOriginal(
      r.originalTransactionId,
      r.items,
      String(r._id),
    );
    r.status = 'معتمد';
    r.approvedBy = approvedBy;
    r.approvedAt = new Date().toISOString();
    r.statusHistory.push({
      status: 'معتمد',
      changedBy: approvedBy,
      changedAt: r.approvedAt,
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'اعتماد مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — بانتظار الإتمام`,
      by: approvedBy,
    });
    return saved;
  }

  async complete(
    id: string,
    completedBy: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'معتمد') {
      throw new BadRequestException('يجب اعتماد الطلب أولاً قبل إتمامه');
    }
    const refundTotal = Number(r.total);
    if (refundTotal <= 0) {
      throw new BadRequestException('لا يمكن إتمام المرتجع — المبلغ غير صالح');
    }

    const returnDate = new Date().toISOString();
    const txDto = {
      date: returnDate,
      type: 'مرتجع مشتريات' as const,
      client: r.supplierName,
      phone: '',
      ref: r.originalRef + '-SRET',
      notes: `مرتجع مورد معتمد: ${r.reason}${r.reasonDetails ? ' — ' + r.reasonDetails : ''} | مبلغ الرد: ${refundTotal} ج إلى ${r.vaultRefundAccount}`,
      items: r.items,
      total: refundTotal,
      employee: completedBy,
      deposit: 0,
      remaining: 0,
      depMethod: r.vaultRefundAccount,
      payment: r.vaultRefundAccount,
      payStatus: 'مكتمل',
      discount: 0,
      shipCost: 0,
    };
    const tx = await this.transactionsService.create(txDto as never);

    r.status = 'مكتمل';
    r.linkedTransactionId = String(tx._id);
    r.statusHistory.push({
      status: 'مكتمل',
      changedBy: completedBy,
      changedAt: new Date().toISOString(),
      note: `حركة مرتجع رقم ${tx.ref}`,
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'اكتمال مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — تم تسجيله في المخزن والخزنة`,
      by: completedBy,
    });
    return saved;
  }

  async reject(
    id: string,
    by: string,
    rejectedReason = '',
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'معلق') {
      throw new BadRequestException('الطلب ليس معلقاً');
    }
    r.status = 'مرفوض';
    r.approvedBy = by;
    r.approvedAt = new Date().toISOString();
    r.rejectedReason = rejectedReason;
    r.statusHistory.push({
      status: 'مرفوض',
      changedBy: by,
      changedAt: r.approvedAt,
      note: rejectedReason,
    });
    return r.save();
  }

  async cancel(
    id: string,
    by: string,
    reason = '',
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (!NON_TERMINAL_STATUSES.includes(r.status)) {
      throw new BadRequestException(
        'لا يمكن إلغاء هذا الطلب في حالته الحالية',
      );
    }
    r.status = 'ملغي';
    r.statusHistory.push({
      status: 'ملغي',
      changedBy: by,
      changedAt: new Date().toISOString(),
      note: reason,
    });
    return r.save();
  }
}
