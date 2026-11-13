/**
 * «بيانات المرتجعات» — a DOCUMENTATION-ONLY record of defective goods found when a supplier's
 * delivery arrives (Nov 13, 2026).
 *
 * ⚠ Separate from «مرتجعات الموردين» (supplier-returns/), which is the accounting return that
 * moves stock, the supplier ledger and the vault. A statement moves NOTHING: no inventory
 * movement, no ledger entry, no vault entry, no cost, no purchase order or invoice change.
 * The service only ever writes its own two collections.
 *
 * ⚠ `code` values are stored. Never rename one — add a new code instead.
 * Mirrored by RS_REASONS / RS_STATUSES in frontend/public/supplier-return-statements.js.
 */
export const RS_COLLECTION = 'supplierreturnstatements';
export const RS_IMAGES_COLLECTION = 'supplierreturnstatementimages';
export const RS_IMAGE_PREFIX = 'supplier-return-statements/';

export const RS_REASONS = [
  { code: 'manufacturing-defect', ar: 'عيب تصنيع', en: 'Manufacturing defect' },
  { code: 'shipping-damage', ar: 'تلف أثناء النقل', en: 'Damaged during shipping' },
  { code: 'wrong-color', ar: 'اختلاف اللون', en: 'Wrong color' },
  { code: 'wrong-size', ar: 'اختلاف المقاس أو الأبعاد', en: 'Wrong size' },
  { code: 'material-quality', ar: 'مشكلة في جودة الخامة', en: 'Material quality issue' },
  { code: 'not-as-agreed', ar: 'غير مطابق للمواصفات المتفق عليها', en: 'Not as agreed' },
  { code: 'missing-parts', ar: 'نقص في الكمية أو المكونات', en: 'Missing parts' },
  { code: 'wrong-product', ar: 'منتج خاطئ', en: 'Wrong product' },
  { code: 'damaged-packaging', ar: 'تلف التغليف', en: 'Damaged packaging' },
  { code: 'other', ar: 'سبب آخر', en: 'Other' },
] as const;
export const RS_REASON_CODES = RS_REASONS.map((r) => r.code) as string[];

export const RS_STATUSES = [
  { code: 'draft', ar: 'مسودة', en: 'Draft' },
  { code: 'sent', ar: 'تم الإرسال للمورد', en: 'Sent to supplier' },
  { code: 'received', ar: 'استلمه المورد', en: 'Received by supplier' },
  { code: 'resolved', ar: 'تمت المعالجة', en: 'Resolved' },
  { code: 'closed', ar: 'مغلق', en: 'Closed' },
] as const;
export const RS_STATUS_CODES = RS_STATUSES.map((s) => s.code) as string[];

/** One perm per action. ⚠ Mirrored in index.html PERMS/PERMS_AR, roles-permissions.js and
 *  users/access-role-permissions.ts. Admin passes every check. */
export const RS_PERMS = {
  view: 'suppliers-rs-view',
  create: 'suppliers-rs-create',
  edit: 'suppliers-rs-edit',
  status: 'suppliers-rs-status',
  delete: 'suppliers-rs-delete',
  export: 'suppliers-rs-export',
} as const;
export const RS_PERM_LIST = Object.values(RS_PERMS) as string[];

export const RS_MAX_LINES = 100;
export const RS_MAX_IMAGES_PER_LINE = 6;
export const RS_MAX_QTY = 100000;
export const RS_NOTE_MAX = 1000;
