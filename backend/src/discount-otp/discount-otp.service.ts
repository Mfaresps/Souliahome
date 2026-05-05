import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
    const threshold = await this.getThreshold();
    if (!(args.discountAmount > threshold)) {
      throw new BadRequestException('قيمة الخصم لا تتجاوز الحد المسموح');
    }
    const ttlMin = await this.getTtlMin();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);
    const otp = this.generateOtp();

    const doc = await this.otpModel.create({
      otp,
      discountAmount: args.discountAmount,
      itemsTotal: args.itemsTotal,
      client: args.client,
      txType: args.txType,
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
        `🔐 كود تحقق خصم مرتفع: ${otp}\n` +
        `طلب من: ${args.requestedByName || args.requestedByUsername || 'موظف'}\n` +
        `قيمة الخصم: ${args.discountAmount} ج.م (الحد: ${threshold})\n` +
        `العميل: ${args.client || '-'} — صالح حتى ${expiresStr}`;
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

  async list(filter?: { status?: string }): Promise<DiscountOtpDocument[]> {
    const q: Record<string, unknown> = {};
    if (filter?.status) q.status = filter.status;
    return this.otpModel.find(q).sort({ createdAt: -1 }).limit(500).exec();
  }
}
