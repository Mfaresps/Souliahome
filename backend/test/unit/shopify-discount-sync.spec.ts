import * as fs from 'fs';
import * as path from 'path';

export {};

/**
 * الخصم الإضافي بعد الإرسال إلى سجل المعاملات.
 *
 * القاعدة المحورية: **`tx.discount` هو إجمالي الخصم على الحركة، لا خصم شوبيفاي
 * وحده.** نموذج سجل المعاملات يحفظ `discount = min(الأكواد + اليدوي, itemsTotal)`
 * (انظر `_syncDiscountFromCodes` في `index.html`)، وكل ما يقرأ الخصم بعد ذلك يقرأ
 * هذا الحقل وحده:
 *   · `totalDiscounts` في لوحة التحكم والتقارير
 *   · شارة الخصم في جدول الحركات وصفحة الفاتورة
 *   · تقرير أكواد الخصم
 *
 * ⚠ `manualDiscount` مخزَّن للعرض فقط — لا يقرأه الخادم في أي تجميع. ترك الخصم
 *   الإضافي خارج `discount` كان يجعل الفاتورة تعرض إجمالياً منخفضاً (صحيحاً) بجانب
 *   خصمٍ أقلّ منه، والـKPI يُبلغ عن خصومات أقلّ مما مُنح فعلاً.
 *
 * ⚠ `export {}` إلزامي — المساعدات العلوية المتشابهة الأسماء بين ملفات spec تتصادم
 *   كـ TS2393 فلا تعمل أي من المجموعتين.
 */

const SERVICE = path.resolve(__dirname, '../../src/shopify/shopify.service.ts');
const TX_SERVICE = path.resolve(__dirname, '../../src/transactions/transactions.service.ts');
const INDEX_HTML = path.resolve(__dirname, '../../../frontend/public/index.html');

/** يقتطع كتلة بين علامتين من ملف مشحون. */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  if (i < 0) throw new Error('العلامة غير موجودة: ' + from);
  const j = src.indexOf(to, i);
  return src.slice(i, j < 0 ? src.length : j);
}

describe('Shopify — الخصم الإضافي يصل إلى الحركة كاملاً', () => {
  let svc: string;
  let approve: string;
  beforeAll(() => {
    svc = fs.readFileSync(SERVICE, 'utf8');
    approve = slice(svc, 'async approveOrder', 'async rejectOrder');
  });

  it('يجمع خصم شوبيفاي + الأكواد + الخصم اليدوي في tx.discount', () => {
    expect(approve).toContain('Number(order.manualDiscount)');
    // المصادر الثلاثة كلها داخل تعبير discount الواحد
    const line = slice(approve, 'discount: Math.min(', 'manualDiscount:');
    expect(line).toContain('order.discount');
    expect(line).toContain('order.codesDiscount');
    expect(line).toContain('order.manualDiscount');
  });

  /** ⚠ القصّ كمجموعة واحدة تماماً كـ`computeShopifyOrderTotal` الذي حسب order.total. */
  it('يقصّ المجموع عند itemsTotal كما يفعل حساب الإجمالي', () => {
    const line = slice(approve, 'discount: Math.min(', 'manualDiscount:');
    expect(line).toContain('Math.min');
    expect(line).toContain('order.itemsTotal');
  });

  it('يبقي manualDiscount مخزَّناً كتفصيل للمراجعة', () => {
    expect(approve).toContain('manualDiscount: Number(order.manualDiscount) || 0');
  });

  it('الأكواد المطبَّقة تُرحَّل فيقرأها تقرير أكواد الخصم', () => {
    expect(approve).toContain('discountCodeId: order.discountCodeId');
    expect(approve).toContain('discountCode: order.discountCode');
  });

  /** ⚠ order.total محسوب أصلاً بعد الخصومات الثلاثة، فلا يُعاد حسابه هنا. */
  it('الإجمالي يُنقل كما هو ولا يُعاد اشتقاقه', () => {
    expect(approve).toContain('total: order.total');
  });

  /**
   * ⚠ الحارس الحقيقي: الصيغة القديمة كانت تجمع اثنين فقط. لو عادت، تعود الفجوة.
   */
  it('REGRESSION: لا يعود إلى جمع مصدرين فقط', () => {
    expect(approve).not.toContain(
      'discount: (Number(order.discount) || 0) + (Number(order.codesDiscount) || 0),',
    );
  });
});

describe('الخصم — الحساب متطابق بين شوبيفاي وسجل المعاملات', () => {
  /**
   * ⚠ النموذجان يجب أن ينتجا نفس `discount` لنفس المدخلات، وإلا اختلف تقرير
   *   الخصومات حسب الباب الذي دخلت منه الحركة.
   */
  it('index.html يجمع الأكواد + اليدوي ويقصّهما عند itemsTotal', () => {
    const idx = fs.readFileSync(INDEX_HTML, 'utf8');
    const fn = slice(idx, 'function _syncDiscountFromCodes', '\n}');
    expect(fn).toContain('txDiscount = Math.min(codesDisc + manualDisc, itemsTotal)');
  });

  it('نفس القاعدة مطبَّقة على مسار شوبيفاي', () => {
    const s = fs.readFileSync(SERVICE, 'utf8');
    const line = slice(slice(s, 'async approveOrder', 'async rejectOrder'),
      'discount: Math.min(', 'manualDiscount:');
    // مجموع ثلاثي مقصوص — نفس شكل _syncDiscountFromCodes (خصم شوبيفاي هو الطرف الثالث)
    expect((line.match(/Number\(order\./g) || []).length).toBeGreaterThanOrEqual(3);
    expect(line).toContain('Math.min');
  });
});

describe('KPI الخصومات يقرأ الحقل الصحيح', () => {
  let tx: string;
  beforeAll(() => { tx = fs.readFileSync(TX_SERVICE, 'utf8'); });

  /**
   * ⚠ هذا الاختبار يوثّق سبب إصلاح مسار شوبيفاي بدل تعديل الـKPI: التجميع يقرأ
   *   `t.discount` وحده، وهو المتّفق عليه مع نموذج سجل المعاملات. جعل الـKPI يجمع
   *   `manualDiscount` أيضاً كان سيُحصي الخصم اليدوي **مرّتين** على كل حركة يدوية،
   *   لأن `discount` هناك يحتويه أصلاً.
   */
  it('totalDiscounts يقرأ tx.discount وحده — والمصدر هو ما يجب أن يكون كاملاً', () => {
    const agg = slice(tx, 'const totalDiscounts = salesTx.reduce', 'const totalDeposit');
    expect(agg).toContain('Number(t.discount)');
    expect(agg).not.toContain('manualDiscount');
  });

  it('لا يقرأ الخادم manualDiscount في أي تجميع', () => {
    // لو صار يُقرأ يوماً، يجب مراجعة هذا الملف كله: سيتضاعف الخصم اليدوي.
    expect((tx.match(/manualDiscount/g) || []).length).toBe(0);
  });
});
