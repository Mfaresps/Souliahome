import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Settings } from '../settings/schemas/settings.schema';
import * as crypto from 'crypto';

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

  async confirmSetup(userId: string, token: string): Promise<boolean> {
    const user = await this.userModel.findById(userId);
    if (!user || !user.totpSecret) throw new BadRequestException('No TOTP secret found');

    const valid = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token,
      window: 4,
    });

    if (!valid) throw new BadRequestException('رمز التحقق غير صحيح — تأكد من مسح QR الجديد وإعادة الإعداد');

    await this.userModel.findByIdAndUpdate(userId, { totpEnabled: true });
    return true;
  }

  async disableTotp(userId: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      totpEnabled: false,
      totpSecret: null,
      trustedDevices: [],
    });
  }

  verifyToken(secret: string, token: string): boolean {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 6,
    });
  }

  generateDeviceToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  async addTrustedDevice(userId: string, deviceToken: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, {
      $addToSet: { trustedDevices: deviceToken },
    });
  }

  async isTrustedDevice(userId: string, deviceToken: string): Promise<boolean> {
    if (!deviceToken) return false;
    const user = await this.userModel.findById(userId).select('trustedDevices');
    return user?.trustedDevices?.includes(deviceToken) ?? false;
  }

  async revokeTrustedDevices(userId: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(userId, { trustedDevices: [] });
  }

  async getGlobal2faStatus(): Promise<boolean> {
    const settings = await this.settingsModel.findOne();
    return settings?.global2faEnabled ?? false;
  }

  async setGlobal2fa(enabled: boolean): Promise<void> {
    await this.settingsModel.findOneAndUpdate({}, { global2faEnabled: enabled }, { upsert: true });
  }
}
