import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Settings } from '../settings/schemas/settings.schema';
import { generateBackupCodes, hashBackupCode, normalizeBackupCode, normalizeDigits, totpStepFresh } from './auth-security.util';

/** ±1 step (30 s) for clock drift. It was ±6 (13 valid codes at once) — far too easy to guess. */
const TOTP_WINDOW = 1;

@Injectable()
export class TotpService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Settings.name) private settingsModel: Model<Settings>,
  ) {}

  async generateSetup(userId: string): Promise<{ qrCode: string; secret: string }> {
    const user = await this.userModel.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    // If already enabled, don't overwrite the active secret
    if (user.totpEnabled && user.totpSecret) {
      throw new BadRequestException('التحقق بخطوتين مفعّل بالفعل — عطّله أولاً لإعادة الإعداد');
    }

    const secret = speakeasy.generateSecret({
      name: `SOULIA (${user.username})`,
      issuer: 'SOULIA WMS',
      length: 20,
    });

    await this.userModel.findByIdAndUpdate(userId, { totpSecret: secret.base32 });

    const otpauthUrl = secret.otpauth_url ?? `otpauth://totp/SOULIA:${user.username}?secret=${secret.base32}&issuer=SOULIA`;
    const qrCode = await new Promise<string>((resolve, reject) =>
      QRCode.toDataURL(otpauthUrl, (err, url) => (err ? reject(err) : resolve(url)))
    );
    return { qrCode, secret: secret.base32 };
  }

  /** The time step a code belongs to, or null when it is not valid now. */
  codeStep(secret: string, token: string, now = Date.now()): number | null {
    const code = normalizeDigits(token);
    if (!secret || code.length !== 6) return null;
    const res = speakeasy.totp.verifyDelta({ secret, encoding: 'base32', token: code, window: TOTP_WINDOW, time: Math.floor(now / 1000) } as any);
    if (!res || typeof res.delta !== 'number') return null;
    return Math.floor(now / 1000 / 30) + res.delta;
  }

  /**
   * Checks a code and spends its time step: a code that was already used (or an older one) is
   * refused, so a code seen over someone's shoulder cannot be replayed. Atomic on `totpLastStep`.
   */
  async verifyAndSpend(userId: string, token: string, now = Date.now()): Promise<boolean> {
    const user = await this.userModel.findById(userId).select('totpSecret totpEnabled totpLastStep').lean();
    if (!user?.totpSecret || !user.totpEnabled) return false;
    const step = this.codeStep(user.totpSecret, token, now);
    if (step === null || !totpStepFresh((user as any).totpLastStep, step)) return false;
    const res = await this.userModel.updateOne(
      { _id: userId, $or: [{ totpLastStep: null }, { totpLastStep: { $exists: false } }, { totpLastStep: { $lt: step } }] },
      { $set: { totpLastStep: step } },
    );
    return res.modifiedCount > 0;
  }

  /** Confirms the first code after scanning; turns 2FA on and returns ten one-time backup codes. */
  async confirmSetup(userId: string, token: string): Promise<{ backupCodes: string[] }> {
    const user = await this.userModel.findById(userId);
    if (!user || !user.totpSecret) throw new BadRequestException('انتهت عملية الإعداد. ابدأ من جديد.');
    if (user.totpEnabled) throw new BadRequestException('التحقق بخطوتين مفعّل بالفعل');
    const step = this.codeStep(user.totpSecret, token);
    if (step === null) throw new BadRequestException('رمز التحقق غير صحيح. تأكد من مسح رمز QR الظاهر الآن.');
    const backupCodes = generateBackupCodes();
    const res = await this.userModel.updateOne(
      { _id: userId, totpEnabled: { $ne: true }, totpSecret: user.totpSecret },
      { $set: { totpEnabled: true, totpEnabledAt: new Date(), totpLastStep: step, totpBackupCodes: backupCodes.map((c) => ({ hash: hashBackupCode(c), usedAt: null })) } },
    );
    if (!res.modifiedCount) throw new BadRequestException('تعذّر إكمال التفعيل. حاول مرة أخرى.');
    return { backupCodes };
  }

  async disableTotp(userId: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      totpEnabled: false,
      totpSecret: null,
      totpLastStep: null,
      totpBackupCodes: [],
      trustedDevices: [],
    });
  }

  /** Spends one backup code. */
  async useBackupCode(userId: string, code: string): Promise<boolean> {
    if (normalizeBackupCode(code).length !== 8) return false;
    const res = await this.userModel.updateOne(
      { _id: userId, totpEnabled: true, totpBackupCodes: { $elemMatch: { hash: hashBackupCode(code), usedAt: null } } },
      { $set: { 'totpBackupCodes.$.usedAt': new Date() } },
    );
    return res.modifiedCount > 0;
  }

  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const codes = generateBackupCodes();
    await this.userModel.updateOne({ _id: userId, totpEnabled: true }, { $set: { totpBackupCodes: codes.map((c) => ({ hash: hashBackupCode(c), usedAt: null })) } });
    return codes;
  }

  backupCodesLeft(user: { totpBackupCodes?: { usedAt?: Date | null }[] } | null): number {
    return (user?.totpBackupCodes || []).filter((c) => !c?.usedAt).length;
  }

  async getGlobal2faStatus(): Promise<boolean> {
    const settings = await this.settingsModel.findOne();
    return settings?.global2faEnabled ?? false;
  }

  async setGlobal2fa(enabled: boolean): Promise<void> {
    await this.settingsModel.findOneAndUpdate({}, { global2faEnabled: enabled }, { upsert: true });
  }
}
