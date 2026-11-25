import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { compressReceipt } from '../shopify/receipt-upload-policy.util';
import { r2GetObjectBuffer, r2PutObject } from '../shared/r2-uploader.util';
import { SettingsService } from '../settings/settings.service';

/**
 * Supplier invoice photos on a purchase («فواتير المورد») and expense receipts («مرفق المصروف»). Same rule as transfer receipts: the
 * image is decoded, stripped of metadata and compressed to ≤ 180 KB JPEG at a size where printed
 * text stays legible (compressReceipt), then kept on Cloudflare R2 when it is configured, else
 * in Mongo. The purchase stores the image URL in invoiceImages, exactly like a pasted link,
 * so every screen that already shows an invoice link shows the photo with no change.
 *
 * ⚠ The URL is a capability: its id is 32 random bytes, so it cannot be guessed or enumerated,
 * and GET needs no session — img tags and the printed invoice cannot send a token.
 */
export const INVOICE_IMAGES_COLLECTION = 'purchaseinvoiceimages';
export const INVOICE_IMAGE_PREFIX = 'purchase-invoices/';
export const EXPENSE_IMAGE_PREFIX = 'expenses/';
export const AVATAR_IMAGE_PREFIX = 'avatars/';
export type InvoiceImagePurpose = 'purchase' | 'expense' | 'avatar';
/** Profile photos are shown at ≤52px: a 256px square ≤ 40 KB is plenty. */
export const MAX_AVATAR_BYTES = 40 * 1024;
export const INVOICE_IMAGE_URL_BASE = '/api/invoice-images/';
export const MAX_INVOICE_UPLOAD_BYTES = 12 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{64}$/;
// Who may upload, per purpose. Expenses follow the /expenses write boundary (perm `expenses`).
const UPLOAD_PERMS: Record<InvoiceImagePurpose, string[]> = {
  purchase: ['purchase-create', 'purchase-edit', 'purchase-edit-price'],
  expense: ['expenses'],
  avatar: [], // any signed-in account (own profile photo; the user window is admin-only anyway)
};
const PREFIX: Record<InvoiceImagePurpose, string> = { purchase: INVOICE_IMAGE_PREFIX, expense: EXPENSE_IMAGE_PREFIX, avatar: AVATAR_IMAGE_PREFIX };

/** Square crop from the centre, 256px (192px if needed), metadata stripped, ≤ MAX_AVATAR_BYTES JPEG. */
export async function compressAvatar(input: Buffer): Promise<Buffer> {
  const options = { failOn: 'error' as const, limitInputPixels: 40_000_000 };
  const meta = await sharp(input, options).metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1) throw new Error('Unsupported image');
  for (const side of [256, 192]) {
    for (const quality of [80, 68, 55]) {
      const out = await sharp(input, options).rotate().flatten({ background: '#fff' })
        .resize({ width: side, height: side, fit: 'cover', position: 'attention' })
        .jpeg({ quality, mozjpeg: true }).toBuffer();
      if (out.length <= MAX_AVATAR_BYTES) return out;
    }
  }
  throw new Error('Avatar too large');
}
const CACHE_MAX = 200;

export interface InvoiceImageActor { userId?: string; role?: string; perms?: string[]; name?: string; username?: string }

@Injectable()
export class InvoiceImagesService {
  private readonly logger = new Logger(InvoiceImagesService.name);
  private readonly cache = new Map<string, Buffer>();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  private get images() { return this.connection.collection(INVOICE_IMAGES_COLLECTION); }

  static canUpload(user: InvoiceImageActor | undefined, purpose: InvoiceImagePurpose = 'purchase'): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (purpose === 'avatar') return !!user.userId;
    const perms = user.perms || [];
    return UPLOAD_PERMS[purpose].some((p) => perms.includes(p));
  }

  async upload(user: InvoiceImageActor, file: { buffer: Buffer; originalname?: string } | undefined, rawPurpose?: string) {
    const purpose: InvoiceImagePurpose = rawPurpose === 'expense' ? 'expense' : rawPurpose === 'avatar' ? 'avatar' : 'purchase';
    if (!InvoiceImagesService.canUpload(user, purpose)) {
      throw new ForbiddenException(purpose === 'expense' ? 'ليست لديك صلاحية رفع صور المصاريف' : 'ليست لديك صلاحية رفع صور فواتير المشتريات');
    }
    if (!file?.buffer?.length) throw new BadRequestException(purpose === 'avatar' ? 'اختر صورة' : 'اختر صورة الفاتورة');
    if (file.buffer.length > MAX_INVOICE_UPLOAD_BYTES) throw new BadRequestException('حجم الصورة أكبر من 12 ميجابايت');
    let buffer: Buffer;
    try { buffer = purpose === 'avatar' ? await compressAvatar(file.buffer) : await compressReceipt(file.buffer); }
    catch { throw new BadRequestException('استخدم صورة JPEG أو PNG أو WebP واضحة'); }

    const id = randomBytes(32).toString('hex');
    const doc: any = {
      _id: id, purpose, contentType: 'image/jpeg', bytes: buffer.length, originalBytes: file.buffer.length,
      name: String(file.originalname || 'invoice').slice(0, 120),
      uploadedBy: user.name || user.username || '', uploadedById: user.userId || '', createdAt: new Date(),
    };
    const cfg = (await this.settings?.getR2Config()) || null;
    if (cfg) {
      const key = `${PREFIX[purpose]}${new Date().toISOString().slice(0, 7)}/${id}.jpg`;
      const put = await r2PutObject(cfg, key, buffer, 'image/jpeg', 30000);
      if (!put.ok) {
        this.logger.warn(`R2 upload of a purchase invoice photo failed: ${put.message}`);
        throw new ServiceUnavailableException('تعذّر حفظ الصورة على التخزين السحابي؛ أعد المحاولة');
      }
      doc.imageKey = key;
      doc.storage = 'r2';
    } else {
      doc.data = buffer.toString('base64');
      doc.storage = 'db';
    }
    await this.images.insertOne(doc);
    return { id, url: INVOICE_IMAGE_URL_BASE + id + '.jpg', bytes: buffer.length, storage: doc.storage };
  }

  /** Public by capability id. Returns the JPEG bytes. */
  async read(rawId: string): Promise<Buffer> {
    const id = String(rawId || '').replace(/\.jpg$/i, '');
    if (!ID_RE.test(id)) throw new NotFoundException('الصورة غير موجودة');
    const hit = this.cache.get(id);
    if (hit) return hit;
    const img: any = await this.images.findOne({ _id: id as any });
    if (!img) throw new NotFoundException('الصورة غير موجودة');
    let body: Buffer;
    if (img.data) body = Buffer.from(img.data, 'base64');
    else {
      const cfg = (await this.settings?.getR2Config()) || null;
      if (!cfg || !Object.values(PREFIX).some((prefix) => String(img.imageKey || '').startsWith(prefix))) throw new ServiceUnavailableException('تعذّر تحميل الصورة');
      const r = await r2GetObjectBuffer(cfg, img.imageKey);
      if (!r.ok) throw new ServiceUnavailableException('تعذّر تحميل الصورة من التخزين السحابي');
      body = r.body;
    }
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(id, body);
    return body;
  }
}
