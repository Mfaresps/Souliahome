import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SettingsDocument = HydratedDocument<Settings>;

export class ShipCompany {
  /**
   * Stable carrier code from shared/carriers.constants.ts — this is what transactions store and
   * what every report groups by. `name` is display only.
   *
   * ⚠ Defaults to '' rather than being required: rows written before the carrier registry existed
   * carry only a name, and SettingsService.migrateDoc backfills the code from it. A required field
   * here would reject those documents on read.
   */
  @Prop({ default: '' })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: 110 })
  cairo: number;

  @Prop({ default: 150 })
  gov: number;
}

export class DiscountCode {
  @Prop({ required: true })
  id: string; // UUID generated on creation

  @Prop({ required: true })
  code: string; // e.g. SUMMER15

  @Prop({ default: '' })
  description: string;

  @Prop({ required: true, enum: ['percent', 'fixed'] })
  type: string; // 'percent' | 'fixed'

  @Prop({ required: true })
  value: number; // 15 for 15% or 50 for 50 EGP

  @Prop({ type: String, default: null })
  startDate: string | null; // ISO date string

  @Prop({ type: String, default: null })
  endDate: string | null; // ISO date string

  @Prop({ default: true })
  active: boolean;

  @Prop({ default: 0 })
  usageCount: number;

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  createdAt: string;

  @Prop({ type: [Object], default: [] })
  auditLog: Array<{
    action: string; // 'created' | 'updated' | 'activated' | 'deactivated' | 'deleted'
    by: string;
    at: string;
    note?: string;
  }>;

  @Prop({ type: [Object], default: [] })
  usageHistory: Array<{
    txRef: string;
    txId: string;
    client: string;
    amount: number; // discount amount applied
    by: string;
    at: string;
  }>;
}

export class DiscountBundle {
  @Prop({ required: true })
  id: string; // UUID

  @Prop({ required: true })
  name: string; // Bundle display name, e.g. "باقة الصيف"

  @Prop({ default: '' })
  description: string;

  @Prop({ type: [String], default: [] })
  productIds: string[]; // all product IDs that form the full bundle

  @Prop({ required: true })
  discountCodeId: string; // ID of the DiscountCode to suggest

  @Prop({ default: true })
  active: boolean;

  @Prop({ default: false })
  allowPartial: boolean; // true → suggest partial code for partial selection

  @Prop({ default: null, type: String })
  partialDiscountCodeId: string | null; // optional separate code for partial match

  @Prop({ default: 1 })
  priority: number; // higher = preferred when bundles overlap

  @Prop({ default: 1 })
  minQty: number; // kept for backward compat; superseded by productMinQtys when present

  @Prop({ type: Object, default: {} })
  productMinQtys: Record<string, number>; // per-product minimum qty { [productId]: minQty }

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  createdAt: string;
}

@Schema({ timestamps: true })
export class Settings {
  @Prop({ default: 110 })
  cairoPrice: number;

  @Prop({ default: 150 })
  govPrice: number;

  @Prop({ type: [Object], default: [] })
  shipCos: ShipCompany[];

  @Prop({ default: '1234' })
  vaultPass: string;

  @Prop({ default: 0 })
  vaultBalance: number;

  @Prop({ default: 0 })
  vaultCash: number;

  @Prop({ default: 0 })
  vaultVodafone: number;

  @Prop({ default: 0 })
  vaultInstapay: number;

  @Prop({ default: 0 })
  vaultBank: number;

  @Prop({ default: 'ar' })
  lang: string;

  @Prop({ default: true })
  langEnabled: boolean;

  @Prop({ default: false })
  darkMode: boolean;

  @Prop({ default: '2.4.0' })
  systemVersion: string;

  @Prop({ type: Date, default: () => new Date() })
  lastVersionUpdate: Date;

  @Prop({ type: Date, default: () => new Date() })
  lastLiveUpload: Date;

  @Prop({ default: false })
  staffDiscountEnabled: boolean;

  @Prop({ default: true })
  otpEnabled: boolean;

  @Prop({ default: 200 })
  highValueDiscountLimit: number;

  @Prop({ default: 10 })
  highValueDiscountOtpTtlMin: number;

  @Prop({ default: false })
  purchaseOtpEnabled: boolean;

  @Prop({ default: true })
  printIncludePolicy: boolean;

  @Prop({ default: 'Instapay' })
  defaultPayMethod: string;

  @Prop({ default: '' })
  defaultDepMethod: string;

  @Prop({ default: '' })
  defaultShipCo: string;

  /**
   * Carrier pre-selected in every order-entry form (manual transaction + Shopify confirm dialog).
   * The picker is always shown — this only decides which option starts selected, so the common
   * single-carrier case stays one click while a second carrier is still one click away.
   *
   * Stores a `code`, not a name; `defaultShipCo` above is the legacy name kept in sync for any
   * consumer still reading it.
   */
  @Prop({ default: '' })
  defaultCarrierCode: string;

  /* ────────────────────────────────────────────────────────────────────────
   * COMPANY IDENTITY — the issuer block on every printed invoice.
   *
   * A formal invoice must state who issued it. Before these existed the printed
   * page carried only a logo, so a customer holding the paper could not identify
   * the seller, and the document had no standing as a commercial record.
   *
   * Every one defaults to '' and the print layout omits any line that is empty —
   * so an install that never fills these in prints exactly as it did before,
   * minus nothing. Fill them in Settings → الطباعة.
   * ──────────────────────────────────────────────────────────────────────── */

  /** Registered legal name, printed as the issuer. Falls back to 'SOULIA' when empty. */
  @Prop({ default: '' })
  companyLegalName: string;

  /** Street address of the issuing branch. */
  @Prop({ default: '' })
  companyAddress: string;

  /** Contact phone printed under the issuer block. */
  @Prop({ default: '' })
  companyPhone: string;

  @Prop({ default: '' })
  companyEmail: string;

  @Prop({ default: '' })
  companyWebsite: string;

  /** البطاقة الضريبية — printed only when set. */
  @Prop({ default: '' })
  companyTaxNumber: string;

  /** السجل التجاري — printed only when set. */
  @Prop({ default: '' })
  companyCommercialReg: string;

  @Prop({ default: '' })
  printPolicySales: string;

  @Prop({ default: '' })
  printPolicyPurchase: string;

  @Prop({ default: 10 })
  printPolicyFontSize: number;

  @Prop({ default: 'normal' })
  printPolicyFontWeight: string;

  @Prop({ default: true })
  printPolicyHighlight: boolean;

  /**
   * قوالب جداول الورديات المحفوظة — كل قالب بيوصف أسبوع كامل لأي عدد موظفين.
   *
   * الشكل: { id, name, roles: [{ key, label }], days: [{ day, windows: { <roleKey>: [{start,end}] } }] }
   * الأدوار مخزّنة كـ **مفاتيح مجرّدة** (`r1`,`r2`,…) مش userId — القالب بيوصف النمط،
   * والمدير بيربط كل دور بموظف وقت التطبيق. ده اللي بيخلي نفس القالب يتطبق على أي
   * مجموعة موظفين، ويفضل صالح بعد ما موظف يسيب الشغل.
   *
   * ⚠ `type: [Object]` إلزامي — نفس قاعدة discountCodes/discountBundles فوق.
   * الافتراضي [] فالتركيبات القديمة بتقرا القالب المدمج في الواجهة زي ما هي، من غير أي backfill.
   */
  @Prop({ type: [Object], default: [] })
  shiftRotas: Record<string, unknown>[];

  @Prop({ type: [Object], default: [] })
  discountCodes: DiscountCode[];

  @Prop({ type: [Object], default: [] })
  discountBundles: DiscountBundle[];

  @Prop({ default: false })
  global2faEnabled: boolean;

  /** Bosta API key — stored encrypted in DB, never returned to frontend as plaintext */
  @Prop({ default: '' })
  bostaApiKey: string;

  /** Secret token used to verify inbound Bosta webhook calls (sent as ?token= query param) */
  @Prop({ default: '' })
  bostaWebhookSecret: string;

  // ─── النسخ الاحتياطي السحابي (Cloudflare R2) ───────────────────────────
  // نفس نمط bostaApiKey: يُخزَّن هنا ولا يُعاد إلى الواجهة أبداً (انظر
  // getSettings، حيث يُستبدل بعَلَم r2SecretAccessKeySet).

  /** Cloudflare Account ID — يُبنى منه عنوان الوصول */
  @Prop({ default: '' })
  r2AccountId: string;

  /** R2 Access Key ID */
  @Prop({ default: '' })
  r2AccessKeyId: string;

  /** R2 Secret Access Key — لا يُعاد إلى الواجهة مطلقاً */
  @Prop({ default: '' })
  r2SecretAccessKey: string;

  /** اسم الـ bucket على R2 */
  @Prop({ default: 'soulia-backups' })
  r2Bucket: string;

  /** تفعيل الرفع التلقائي بعد النسخة الليلية */
  @Prop({ default: false })
  r2Enabled: boolean;

  /** عدد النسخ التي تبقى على السحابة */
  @Prop({ default: 14 })
  r2Keep: number;

  /**
   * الحد الأقصى لصور إيصالات العربون على R2 (مجلد deposit-receipts/). عند تجاوزه يحذف كرون
   * التنظيف الأقدم من صور الإيصالات المعتمدة/المردودة فقط — صورة إيصال قيد المراجعة لا تُحذف أبداً.
   * 2000 صورة × 180KiB ≈ 0.37GB؛ السعة المجانية مشتركة مع باقي ملفات الحساب.
   */
  @Prop({ default: 2000 })
  r2ReceiptsMax: number;

  /**
   * نتيجة آخر رفع — تعرضها لوحة الإعدادات.
   * ⚠ `type: Object` إلزامي مع @Prop كائنية، وإلا فـ CannotDetermineTypeError
   * عند تحميل الوحدة وتموت كل المسارات (انظر قاعدة @Prop القابل لـ null).
   */
  @Prop({ type: Object, default: null })
  r2LastRun: {
    status: string;
    message: string;
    file: string;
    sizeBytes: number;
    remoteCount: number;
    finishedAt: string;
  } | null;

  /**
   * COD collection large-amount warning threshold (EGP).
   * When a COD collection amount is >= this value, the frontend requires
   * an explicit second confirmation before the vault entry is created.
   * Default 5000 — set to 0 to disable the check.
   */
  @Prop({ default: 5000 })
  codCollectionThreshold: number;

  // ── Automatic Bosta settlement (carrier-auto-settle.service.ts) ─────────────────────────────
  /** Master switch. Off by default: nothing settles until an admin turns it on. */
  @Prop({ default: false })
  autoSettleEnabled: boolean;

  /** Stamped when the switch is first turned on. Deliveries before it are settled only by selection. */
  @Prop({ default: '' })
  autoSettleSince: string;

  /** Largest overcharge above the invoice tariff (EGP) that settles without a human decision. */
  @Prop({ default: 20 })
  autoSettleReviewLimit: number;

  /** Vault account Bosta settlements post to unless the user picks another one. */
  @Prop({ default: 'تحويل بنكي' })
  autoSettleVaultMethod: string;

  /** Seconds between DELIVERED and reading the price — Bosta writes the final price just after delivery. */
  @Prop({ default: 60 })
  autoSettleReadDelaySec: number;

  /** Default fee Bosta takes per transfer (EGP), pre-filled when a transfer is recorded. */
  @Prop({ default: 25 })
  carrierTransferFee: number;

  /** Employee performance scoring configuration (Customer Service Performance Dashboard) — points awarded per criterion, admin-tunable */
  @Prop({
    type: Object,
    default: {
      deliveryPoints: 2,
      depositFullPoints: 5,
      depositPartial50Points: 3,
      depositPartialLowPoints: 2,
      depositNonePoints: 1,
    },
  })
  performanceConfig: {
    deliveryPoints: number;
    depositFullPoints: number;
    depositPartial50Points: number;
    depositPartialLowPoints: number;
    depositNonePoints: number;
  };
}

export const SettingsSchema = SchemaFactory.createForClass(Settings);
