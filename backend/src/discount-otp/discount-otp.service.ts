import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiscountOtp, DiscountOtpDocument } from './schemas/discount-otp.schema';
import { SettingsService } from '../settings/settings.service';
import { MentionsService } from '../mentions/mentions.service';
import { UsersService } from '../users/users.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';

const MAX_OTP_ATTEMPTS = 4;

interface RequestArgs {
  discountAmount: number;
  itemsTotal: number;
  client: string;
  txType: string;
  txRef: string;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface PurchaseOtpArgs {
  supplier: string;
  itemsTotal: number;
  items: Array<{ name: string; qty: number; price: number; total: number }>;
  txRef: string;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface ImportProductsOtpArgs {
  count: number;
  itemNames?: string[];
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface DeleteProductOtpArgs {
  productName: string; // single name or "،\n"-separated list for bulk
  productCode: string;
  isBulk: boolean;
  count: number;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface DeleteSupplierOtpArgs {
  supplierName: string;
  supplierId: string;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface SupplierPayOtpArgs {
  supplier: string;
  txId: string;
  txRef: string;
  amount: number;
  remaining: number;
  payMethod: string;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface VaultAccessOtpArgs {
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface AddProductOtpArgs {
  productName: string;
  productCode: string;
  sellPrice: number;
  buyPrice: number;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

interface ExportExcelOtpArgs {
  exportLabel: string;
  requestedById: string;
  requestedByName: string;
  requestedByUsername: string;
}

@Injectable()
export class DiscountOtpService {
  constructor(
    @InjectModel(DiscountOtp.name)
    private readonly otpModel: Model<DiscountOtpDocument>,
    private readonly settingsService: SettingsService,
    private readonly mentionsService: MentionsService,
    private readonly usersService: UsersService,
    private readonly auditService: SecurityAuditService,
  ) {}

  private generateOtp(): string {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  async getThreshold(): Promise<number> {
    const settings = await this.settingsService.getSettings();
    return Number(settings.highValueDiscountLimit ?? 200);
  }

  async getTtlMin(): Promise<number> {
    const settings = await this.settingsService.getSettings();
    return Number(settings.highValueDiscountOtpTtlMin ?? 10);
  }

  async requestOtp(args: RequestArgs): Promise<{ otpId: string; expiresAt: string; threshold: number }> {
    const settings = await this.settingsService.getSettings();
    if (settings.otpEnabled === false) {
      throw new BadRequestException('نظام OTP معطل — لا يوجد حد للخصم حالياً');
    }

    // Mandatory field validation
    if (!args.client || !args.client.trim()) {
      throw new BadRequestException('اسم العميل مطلوب قبل طلب كود التحقق');
    }
    if (!args.txRef || !args.txRef.trim()) {
      throw new BadRequestException('رقم الفاتورة مطلوب قبل طلب كود التحقق');
    }

    const threshold = await this.getThreshold();
    if (!(args.discountAmount > threshold)) {
      throw new BadRequestException('قيمة الخصم لا تتجاوز الحد المسموح');
    }

    // txRef uniqueness: block if same ref already has an active (unused/not-expired) OTP
    const now = new Date();
    const existingActive = await this.otpModel.findOne({
      txRef: args.txRef.trim(),
      status: 'unused',
      expiresAt: { $gt: now.toISOString() },
    }).exec();
    if (existingActive) {
      throw new BadRequestException(`رقم الفاتورة #${args.txRef} له كود تحقق نشط بالفعل — انتظر انتهاء صلاحيته أو اطلب كوداً جديداً`);
    }

    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: args.discountAmount,
      itemsTotal: args.itemsTotal,
      client: args.client,
      txType: args.txType,
      txRef: args.txRef || '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      thresholdAtRequest: threshold,
    });

    // Notify all admins via mentions
    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const text =
        `🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالعميل: ${args.client || '-'}` +
        `\nالفاتورة: ${args.txRef || '-'}` +
        `\nالخصم: EGP ${args.discountAmount} (الحد: EGP ${threshold})` +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام التحقق',
        txId: String(doc._id),
        txRef: '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString(), threshold };
  }

  async validateOtp(
    otpId: string,
    otp: string,
  ): Promise<{ valid: boolean; message?: string }> {
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) return { valid: false, message: 'الكود غير موجود' };

    const now = new Date();
    const expired = new Date(doc.expiresAt) < now;

    if (doc.status === 'used') {
      return { valid: false, message: 'تم استخدام هذا الكود مسبقاً' };
    }
    if (doc.status === 'expired' || expired) {
      if (doc.status !== 'expired') {
        doc.status = 'expired';
        await doc.save();
      }
      return { valid: false, message: 'انتهت صلاحية الكود — اطلب كوداً جديداً' };
    }

    if (String(otp).trim() !== String(doc.otp)) {
      doc.attempts = (doc.attempts || 0) + 1;
      await doc.save();

      // Lock the requester's account after too many wrong OTP entries
      if (doc.attempts >= MAX_OTP_ATTEMPTS && doc.requestedById) {
        const requester = await this.usersService.findById(doc.requestedById).catch(() => null);
        if (requester && requester.isActive !== false) {
          const lockReason = `تم تعطيل الحساب بعد ${MAX_OTP_ATTEMPTS} محاولات إدخال كود OTP خاطئة`;
          await this.usersService.lockAccount(doc.requestedById, lockReason, 'system');
          await this.auditService.log({
            userId: doc.requestedById,
            username: doc.requestedByUsername || requester.username,
            violationType: 'otp_violation',
            action: lockReason,
            detail: `نوع الكود: ${doc.kind}`,
          });
          // Notify admins
          const allUsers = await this.usersService.findAll();
          const admins = allUsers.filter(u => u.role === 'admin');
          if (admins.length) {
            await this.mentionsService.createMany(
              admins.map(a => ({
                targetUserId: a._id.toString(),
                targetUsername: a.username,
                targetName: a.name,
                fromUserId: 'system',
                fromName: 'نظام الأمان',
                commentText: `🚨 تم تعطيل حساب "${requester.name || requester.username}" بعد ${MAX_OTP_ATTEMPTS} محاولات إدخال كود OTP خاطئة (نوع: ${doc.kind})`,
                read: false,
              })),
            );
          }
          return { valid: false, message: `🔒 تم تعطيل حسابك بعد ${MAX_OTP_ATTEMPTS} محاولات خاطئة — تواصل مع المدير` };
        }
      }

      const remaining = MAX_OTP_ATTEMPTS - doc.attempts;
      return { valid: false, message: remaining > 0 ? `الكود غير صحيح — تبقى ${remaining} محاولة` : 'الكود غير صحيح' };
    }

    doc.status = 'used';
    doc.usedAt = now.toISOString();
    await doc.save();
    return { valid: true };
  }

  async assertOtpForTransaction(
    otpId: string,
    discountAmount: number,
  ): Promise<DiscountOtpDocument> {
    if (!otpId) {
      throw new BadRequestException('يلزم كود تحقق للخصم المرتفع');
    }
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.status !== 'used') {
      throw new BadRequestException('كود التحقق لم يتم التحقق منه');
    }
    // Discount amount must match (within rounding)
    if (Math.abs((doc.discountAmount || 0) - discountAmount) > 0.5) {
      throw new BadRequestException('قيمة الخصم لا تطابق كود التحقق');
    }
    return doc;
  }

  async attachToTransaction(otpId: string, txId: string, txRef: string): Promise<void> {
    await this.otpModel.findByIdAndUpdate(otpId, { txId, txRef }).exec();
  }

  async requestPurchaseOtp(args: PurchaseOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const settings = await this.settingsService.getSettings();
    if (!settings.purchaseOtpEnabled) {
      throw new BadRequestException('نظام OTP للمشتريات غير مفعّل');
    }
    if (!args.supplier || !args.supplier.trim()) {
      throw new BadRequestException('اسم المورد مطلوب قبل طلب كود التحقق');
    }

    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: args.itemsTotal,
      client: args.supplier,
      txType: 'مشتريات',
      txRef: args.txRef || '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      thresholdAtRequest: 0,
      kind: 'purchase',
      purchaseItems: args.items || [],
    });

    // Notify all admins
    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const itemsText = (args.items || [])
        .slice(0, 5)
        .map(it => `  • ${it.name}: ${it.qty} × ${it.price} = EGP ${it.total}`)
        .join('\n');
      const moreItems = (args.items || []).length > 5 ? `\n  ... و${(args.items || []).length - 5} أصناف أخرى` : '';
      const text =
        `🛒 طلب شراء يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالمورد: ${args.supplier}` +
        `${args.txRef ? `\nرقم الفاتورة: ${args.txRef}` : ''}` +
        `\nالأصناف:\n${itemsText}${moreItems}` +
        `\nالإجمالي: EGP ${args.itemsTotal}` +
        `\nصالح حتى: ${expiresStr}`;

      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام المشتريات',
        txId: String(doc._id),
        txRef: args.txRef || '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertPurchaseOtp(otpId: string): Promise<void> {
    if (!otpId) {
      throw new BadRequestException('يلزم كود تحقق لإتمام عملية الشراء');
    }
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود تحقق الشراء غير موجود');
    if (doc.kind !== 'purchase') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') {
      throw new BadRequestException('كود تحقق الشراء لم يتم التحقق منه');
    }
  }

  async requestImportProductsOtp(args: ImportProductsOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: `استيراد ${args.count} صنف`,
      txType: 'import-products',
      txRef: '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'import-products',
      importItemNames: args.itemNames || [],
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const names = args.itemNames || [];
      const shownNames = names.slice(0, 10).map(n => `• ${n}`).join('\n');
      const moreNames = names.length > 10 ? `\n... و${names.length - 10} أصناف أخرى` : '';
      const namesBlock = names.length
        ? `\nالأصناف:\n${shownNames}${moreNames}`
        : '';
      const text =
        `📥 طلب استيراد أصناف يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nعدد الأصناف: ${args.count} صنف` +
        namesBlock +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام الاستيراد',
        txId: String(doc._id),
        txRef: '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertImportProductsOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لاستيراد الأصناف');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'import-products') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
  }

  async requestDeleteProductOtp(args: DeleteProductOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const label = args.isBulk
      ? `حذف ${args.count} صنف (جماعي)`
      : `حذف صنف: ${args.productName}${args.productCode ? ' [' + args.productCode + ']' : ''}`;

    const deleteProductNames = args.isBulk
      ? args.productName.split('،\n').map(s => s.trim()).filter(Boolean)
      : args.productName ? [args.productName] : [];

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: label,
      txType: 'delete-product',
      txRef: args.productCode || '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'delete-product',
      deleteProductNames,
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      let namesBlock = '';
      if (args.isBulk && args.productName) {
        const names = args.productName.split('،\n').filter(Boolean);
        const shown = names.slice(0, 5).map(n => `  • ${n.trim()}`).join('\n');
        const more = names.length > 5 ? `\n  ... و${names.length - 5} أصناف أخرى` : '';
        namesBlock = `\nالأصناف:\n${shown}${more}`;
      }
      const text =
        `🗑️ طلب حذف صنف يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\n${label}` +
        namesBlock +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام الحماية',
        txId: String(doc._id),
        txRef: args.productCode || '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertDeleteProductOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لحذف الصنف');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'delete-product') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
  }

  async requestDeleteSupplierOtp(args: DeleteSupplierOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: args.supplierName,
      txType: 'delete-supplier',
      txRef: args.supplierId,
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'delete-supplier',
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const text =
        `🗑️ طلب حذف مورد يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالمورد: ${args.supplierName}` +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام الحماية',
        txId: String(doc._id),
        txRef: args.supplierId,
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertDeleteSupplierOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لحذف المورد');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'delete-supplier') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
  }

  async requestSupplierPayOtp(args: SupplierPayOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    if (!args.supplier || !args.supplier.trim()) {
      throw new BadRequestException('اسم المورد مطلوب قبل طلب كود التحقق');
    }
    if (!args.amount || args.amount <= 0) {
      throw new BadRequestException('المبلغ غير صحيح');
    }

    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: args.amount,
      client: args.supplier,
      txType: 'supplier-pay',
      txRef: args.txRef || '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      thresholdAtRequest: 0,
      kind: 'supplier-pay',
      editTxId: args.txId,
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const text =
        `💳 طلب سداد مبلغ للمورد يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالمورد: ${args.supplier}` +
        (args.txRef ? `\nالفاتورة: #${args.txRef}` : '') +
        `\nالمبلغ المراد سداده: EGP ${args.amount}` +
        `\nإجمالي المتبقي: EGP ${args.remaining}` +
        `\nطريقة السداد: ${args.payMethod}` +
        `\nصالح حتى: ${expiresAt.toISOString()}`;

      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام سداد الموردين',
        txId: String(doc._id),
        txRef: args.txRef || '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertSupplierPayOtp(otpId: string, amount: number): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لسداد المبلغ للمورد');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'supplier-pay') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه بعد');
    if (Math.abs((doc.itemsTotal || 0) - amount) > 0.5) {
      throw new BadRequestException('المبلغ لا يطابق كود التحقق');
    }
  }

  async requestVaultAccessOtp(args: VaultAccessOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: args.requestedByName || args.requestedByUsername,
      txType: 'vault-access',
      txRef: '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'vault-access',
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const text =
        `🔐 طلب دخول الخزنة يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام الخزنة',
        txId: String(doc._id),
        txRef: '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertVaultAccessOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق للوصول إلى الخزنة');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'vault-access') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
  }

  async requestAddProductOtp(args: AddProductOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const label = `إضافة صنف: ${args.productName}${args.productCode ? ' [' + args.productCode + ']' : ''}`;

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: label,
      txType: 'add-product',
      txRef: args.productCode || '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'add-product',
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const text =
        `➕ طلب إضافة صنف يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\n${label}` +
        `\nسعر البيع: ${args.sellPrice} | سعر الشراء: ${args.buyPrice}` +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام إضافة الأصناف',
        txId: String(doc._id),
        txRef: args.productCode || '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertAddProductOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لإضافة الصنف');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'add-product') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
  }

  async requestExportExcelOtp(args: ExportExcelOtpArgs): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: args.exportLabel,
      txType: 'export-excel',
      txRef: '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'export-excel',
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const text =
        `📊 طلب تصدير Excel يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالتصدير: ${args.exportLabel}` +
        `\nصالح حتى: ${expiresStr}`;
      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام التصدير',
        txId: String(doc._id),
        txRef: '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertExportExcelOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لتصدير البيانات');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'export-excel') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
    await this.auditService.log({
      userId: doc.requestedById,
      username: doc.requestedByUsername,
      violationType: 'export_excel',
      action: `تصدير Excel: ${doc.client || 'بيانات'}`,
      detail: `otpId: ${otpId} — تم التحقق وبدء التصدير`,
    });
  }

  async requestEditTxOtp(args: {
    txId: string;
    txType: string;
    txRef: string;
    changes: string[];
    payload: Record<string, any>;
    requestedById: string;
    requestedByName: string;
    requestedByUsername: string;
  }): Promise<{ otpId: string; expiresAt: string }> {
    const now = new Date();
    const ttlMin = await this.getTtlMin();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const typeLabel = args.txType === 'مشتريات' ? 'مشتريات' : 'مبيعات';
    const doc = await this.otpModel.create({
      otp,
      discountAmount: 0,
      itemsTotal: 0,
      client: args.txRef || args.txId,
      txType: `edit-${typeLabel}`,
      txRef: args.txRef || '',
      requestedById: args.requestedById,
      requestedByName: args.requestedByName,
      requestedByUsername: args.requestedByUsername,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'unused',
      attempts: 0,
      kind: 'edit-tx',
      editTxId: args.txId,
      editTxType: args.txType,
      editChanges: args.changes || [],
      editPayload: JSON.parse(JSON.stringify(args.payload || {})),
      editStatus: '',
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const changesText = (args.changes || []).slice(0, 8).map(c => `  • ${c}`).join('\n');
      const moreChanges = (args.changes || []).length > 8 ? `\n  ... و${(args.changes || []).length - 8} تغييرات أخرى` : '';
      const text =
        `✏️ طلب تعديل حركة ${typeLabel} يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالنوع: ${typeLabel}` +
        (args.txRef ? `\nالمرجع: #${args.txRef}` : '') +
        `\nالتغييرات:\n${changesText}${moreChanges}` +
        `\nصالح حتى: ${expiresStr}`;

      const rows = admins.map((a: any) => ({
        targetUserId: String(a._id),
        targetUsername: (a.username || '').toLowerCase(),
        targetName: a.name || '',
        fromUserId: 'system',
        fromName: 'نظام التعديل',
        txId: String(doc._id),
        txRef: args.txRef || '',
        commentId: 0,
        commentText: text,
      }));
      await this.mentionsService.createMany(rows);
    } catch {
      // notification failure must not break OTP creation
    }

    return { otpId: String(doc._id), expiresAt: expiresAt.toISOString() };
  }

  async assertEditTxOtp(otpId: string): Promise<DiscountOtpDocument> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لتعديل الحركة');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'edit-tx') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
    return doc;
  }

  async approveEditTx(otpId: string, reviewedBy: string): Promise<{ payload: Record<string, any>; txId: string; requestedByName: string; reviewedBy: string }> {
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('طلب التعديل غير موجود');
    if (doc.kind !== 'edit-tx') throw new BadRequestException('نوع الطلب غير صحيح');
    if (doc.editStatus === 'approved') throw new BadRequestException('تمت الموافقة مسبقاً');
    if (doc.editStatus === 'rejected') throw new BadRequestException('تم الرفض مسبقاً');
    doc.status = 'used';
    doc.usedAt = new Date().toISOString();
    doc.editStatus = 'approved';
    doc.editReviewedBy = reviewedBy;
    doc.editReviewedAt = new Date().toISOString();
    const payload = doc.editPayload || {};
    const txId = doc.editTxId || '';
    await doc.save();
    // Notify requesting employee
    try {
      if (doc.requestedById) {
        const txRef = doc.txRef || doc.editTxId || '';
        const typeLabel = doc.editTxType === 'مشتريات' ? 'مشتريات' : 'مبيعات';
        const text =
          `✅ تمت الموافقة على طلب تعديل حركة ${typeLabel}` +
          (txRef ? ` (#${txRef})` : '') +
          `\nتمت المراجعة بواسطة: ${reviewedBy || 'المدير'}` +
          `\nتم تطبيق التعديل على الحركة بنجاح.`;
        await this.mentionsService.createMany([{
          targetUserId: doc.requestedById,
          targetUsername: doc.requestedByUsername || '',
          targetName: doc.requestedByName || '',
          fromUserId: 'system',
          fromName: reviewedBy || 'المدير',
          txId: txId || String(doc._id),
          txRef: txRef,
          commentId: 0,
          commentText: text,
        }]);
      }
    } catch { /* notification failure must not break approval */ }
    return { payload, txId, requestedByName: doc.requestedByName || doc.requestedByUsername || '', reviewedBy };
  }

  async rejectEditTx(otpId: string, reviewedBy: string): Promise<void> {
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('طلب التعديل غير موجود');
    if (doc.kind !== 'edit-tx') throw new BadRequestException('نوع الطلب غير صحيح');
    if (doc.editStatus === 'approved') throw new BadRequestException('تمت الموافقة مسبقاً — لا يمكن الرفض');
    doc.editStatus = 'rejected';
    doc.editReviewedBy = reviewedBy;
    doc.editReviewedAt = new Date().toISOString();
    await doc.save();
    // Notify requesting employee
    try {
      if (doc.requestedById) {
        const txRef = doc.txRef || doc.editTxId || '';
        const typeLabel = doc.editTxType === 'مشتريات' ? 'مشتريات' : 'مبيعات';
        const text =
          `❌ تم رفض طلب تعديل حركة ${typeLabel}` +
          (txRef ? ` (#${txRef})` : '') +
          `\nتمت المراجعة بواسطة: ${reviewedBy || 'المدير'}` +
          `\nيرجى التواصل مع المدير للمزيد من التفاصيل.`;
        await this.mentionsService.createMany([{
          targetUserId: doc.requestedById,
          targetUsername: doc.requestedByUsername || '',
          targetName: doc.requestedByName || '',
          fromUserId: 'system',
          fromName: reviewedBy || 'المدير',
          txId: String(doc._id),
          txRef: txRef,
          commentId: 0,
          commentText: text,
        }]);
      }
    } catch { /* notification failure must not break rejection */ }
  }

  async getEditTxOtp(otpId: string): Promise<DiscountOtpDocument | null> {
    return this.otpModel.findById(otpId).exec();
  }

  async list(filter?: {
    status?: string;
    kind?: string;
    dateFrom?: string;
    dateTo?: string;
    employee?: string;
  }): Promise<DiscountOtpDocument[]> {
    const q: Record<string, unknown> = {};
    if (filter?.status) q.status = filter.status;
    if (filter?.kind) q.kind = filter.kind;
    if (filter?.dateFrom || filter?.dateTo) {
      const range: Record<string, string> = {};
      if (filter.dateFrom) range['$gte'] = filter.dateFrom;
      if (filter.dateTo) range['$lte'] = filter.dateTo + 'T23:59:59.999Z';
      q.createdAt = range;
    }
    if (filter?.employee) {
      const regex = { $regex: filter.employee, $options: 'i' };
      q['$or'] = [{ requestedByName: regex }, { requestedByUsername: regex }];
    }
    return this.otpModel.find(q).sort({ createdAt: -1 }).limit(500).exec();
  }

  async stats(): Promise<Record<string, number>> {
    const all = await this.otpModel.find({}).select('status attempts kind').lean().exec();
    const result: Record<string, number> = {
      total: all.length,
      used: 0,
      unused: 0,
      expired: 0,
      failedAttempts: 0,
    };
    for (const r of all) {
      if (r.status === 'used') result.used++;
      else if (r.status === 'expired') result.expired++;
      else result.unused++;
      result.failedAttempts += r.attempts || 0;
    }
    return result;
  }

  async getImportItemNames(otpId: string): Promise<{ names: string[] }> {
    const doc = await this.otpModel.findById(otpId).select('importItemNames kind').exec();
    if (!doc || doc.kind !== 'import-products') return { names: [] };
    return { names: doc.importItemNames || [] };
  }
}
