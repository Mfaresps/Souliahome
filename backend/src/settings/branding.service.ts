import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { BrandLogo, BrandLogoDocument } from './schemas/brand-logo.schema';
import { Settings, SettingsDocument } from './schemas/settings.schema';
import { SettingsService } from './settings.service';
import { prepareBrandLogo } from './branding-image.util';

export const BRAND_SLOTS = ['splash', 'header', 'tab'] as const;
export type BrandSelection = Record<typeof BRAND_SLOTS[number], string | null>;
const emptySelection = (): BrandSelection => ({ splash: null, header: null, tab: null });

@Injectable()
export class BrandingService {
  constructor(@InjectModel(BrandLogo.name) private readonly logos: Model<BrandLogoDocument>,
    @InjectModel(Settings.name) private readonly settingsModel: Model<SettingsDocument>,
    private readonly settingsService: SettingsService) {}

  private meta(logo: any) {
    return { id: logo.id, name: logo.name, width: logo.width, height: logo.height, sourceWidth: logo.sourceWidth,
      sourceHeight: logo.sourceHeight, bytes: logo.bytes, createdAt: logo.createdAt,
      imageUrl: `/api/branding/logos/${logo.id}/image`, iconUrl: `/api/branding/logos/${logo.id}/icon` };
  }

  async snapshot() {
    const settings = await this.settingsModel.findOne().select('branding').lean().exec();
    const stored = settings?.branding || emptySelection();
    const selected = BRAND_SLOTS.map(slot => stored[slot]).filter(Boolean);
    const logos = selected.length ? await this.logos.find({ id: { $in: selected } }).lean().exec() : [];
    const ids = new Set(logos.map(logo => logo.id));
    const selection = emptySelection();
    BRAND_SLOTS.forEach(slot => { const id = stored[slot]; selection[slot] = id && ids.has(id) ? id : null; });
    return { selection, logos: logos.map(logo => this.meta(logo)) };
  }

  async library() {
    const [snapshot, logos] = await Promise.all([this.snapshot(), this.logos.find().sort({ createdAt: -1 }).lean().exec()]);
    return { selection: snapshot.selection, logos: logos.map(logo => this.meta(logo)) };
  }

  private validName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new BadRequestException('اكتب اسماً للشعار من 1 إلى 80 حرفاً.');
    return name.trim();
  }

  async upload(file: Express.Multer.File | undefined, name: unknown) {
    const label = this.validName(name);
    if (!file?.buffer) throw new BadRequestException('اختر صورة الشعار أولاً.');
    const prepared = await prepareBrandLogo(file.buffer, file.originalname);
    const logo = await this.logos.create({ id: randomUUID(), name: label, ...prepared });
    return this.meta(logo);
  }

  async rename(id: string, name: unknown) {
    const logo = await this.logos.findOneAndUpdate({ id }, { $set: { name: this.validName(name) } }, { new: true }).exec();
    if (!logo) throw new NotFoundException('الشعار غير موجود.');
    return this.meta(logo);
  }

  async select(selection: BrandSelection) {
    if (!selection || BRAND_SLOTS.some(slot => selection[slot] !== null && (typeof selection[slot] !== 'string' || !/^[a-f0-9-]{36}$/i.test(selection[slot]!)))) {
      throw new BadRequestException('اختر شعاراً محفوظاً لكل موضع أو اختر الشعار الأصلي.');
    }
    const ids = [...new Set(BRAND_SLOTS.map(slot => selection[slot]).filter(Boolean))];
    if (ids.length !== await this.logos.countDocuments({ id: { $in: ids } }).exec()) throw new BadRequestException('أحد الشعارات المختارة غير موجود في المكتبة.');
    const settings = await this.settingsService.getSettings();
    const branding = emptySelection();
    BRAND_SLOTS.forEach(slot => { branding[slot] = selection[slot]; });
    await this.settingsModel.findByIdAndUpdate(settings._id, { $set: { branding } }).exec();
    return this.snapshot();
  }

  async image(id: string, icon: boolean) {
    const logo = await this.logos.findOne({ id }).select(icon ? '+iconBase64' : '+imageBase64').lean().exec();
    if (!logo) throw new NotFoundException('الشعار غير موجود.');
    return Buffer.from(icon ? logo.iconBase64 : logo.imageBase64, 'base64');
  }
}
