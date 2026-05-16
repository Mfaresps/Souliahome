import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DiscountOtp, DiscountOtpDocument } from './schemas/discount-otp.schema';
import { SettingsService } from '../settings/settings.service';
import { MentionsService } from '../mentions/mentions.service';
import { UsersService } from '../users/users.service';

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

@Injectable()
export class DiscountOtpService {
  constructor(
    @InjectModel(DiscountOtp.name)
    private readonly otpModel: Model<DiscountOtpDocument>,
    private readonly settingsService: SettingsService,
    private readonly mentionsService: MentionsService,
    private readonly usersService: UsersService,
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      const text =
        `🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالعميل: ${args.client || '-'}` +
        `\nالفاتورة: ${args.txRef || '-'}` +
        `\nالخصم: ${args.discountAmount} ج.م (الحد: ${threshold} ج.م)` +
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
      return { valid: false, message: 'الكود غير صحيح' };
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      const itemsText = (args.items || [])
        .slice(0, 5)
        .map(it => `  • ${it.name}: ${it.qty} × ${it.price} = ${it.total} ج.م`)
        .join('\n');
      const moreItems = (args.items || []).length > 5 ? `\n  ... و${(args.items || []).length - 5} أصناف أخرى` : '';
      const text =
        `🛒 طلب شراء يحتاج موافقتك` +
        `\n🔐 كود التحقق: ${otp}` +
        `\nالموظف: ${args.requestedByName || args.requestedByUsername || 'موظف'}` +
        `\nالمورد: ${args.supplier}` +
        `${args.txRef ? `\nرقم الفاتورة: ${args.txRef}` : ''}` +
        `\nالأصناف:\n${itemsText}${moreItems}` +
        `\nالإجمالي: ${args.itemsTotal} ج.م` +
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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
    });

    try {
      const users = await this.usersService.findAll();
      const admins = users.filter((u: any) => u.role === 'admin');
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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

  async assertAddProductOtp(otpId: string): Promise<void> {
    if (!otpId) throw new BadRequestException('يلزم كود تحقق لإضافة الصنف');
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('كود التحقق غير موجود');
    if (doc.kind !== 'add-product') throw new BadRequestException('نوع كود التحقق غير صحيح');
    if (doc.status !== 'used') throw new BadRequestException('كود التحقق لم يتم التحقق منه');
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
      const expiresStr = expiresAt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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

  async approveEditTx(otpId: string, reviewedBy: string): Promise<{ payload: Record<string, any>; txId: string }> {
    const doc = await this.otpModel.findById(otpId).exec();
    if (!doc) throw new BadRequestException('طلب التعديل غير موجود');
    if (doc.kind !== 'edit-tx') throw new BadRequestException('نوع الطلب غير صحيح');
    if (doc.editStatus === 'approved') throw new BadRequestException('تمت الموافقة مسبقاً');
    if (doc.editStatus === 'rejected') throw new BadRequestException('تم الرفض مسبقاً');
    // Mark OTP as used and approved
    doc.status = 'used';
    doc.usedAt = new Date().toISOString();
    doc.editStatus = 'approved';
    doc.editReviewedBy = reviewedBy;
    doc.editReviewedAt = new Date().toISOString();
    const payload = doc.editPayload || {};
    const txId = doc.editTxId || '';
    await doc.save();
    return { payload, txId };
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
  }

  async getEditTxOtp(otpId: string): Promise<DiscountOtpDocument | null> {
    return this.otpModel.findById(otpId).exec();
  }

  async list(filter?: { status?: string }): Promise<DiscountOtpDocument[]> {
    const q: Record<string, unknown> = {};
    if (filter?.status) q.status = filter.status;
    return this.otpModel.find(q).sort({ createdAt: -1 }).limit(500).exec();
  }

  async getImportItemNames(otpId: string): Promise<{ names: string[] }> {
    const doc = await this.otpModel.findById(otpId).select('importItemNames kind').exec();
    if (!doc || doc.kind !== 'import-products') return { names: [] };
    return { names: doc.importItemNames || [] };
  }
}
