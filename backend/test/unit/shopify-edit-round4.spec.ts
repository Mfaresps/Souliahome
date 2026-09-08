import * as fs from 'fs';
import * as path from 'path';

export {};

/**
 * محرّر أوردر شوبيفاي — الجولة الرابعة.
 *
 * ⚠ كل ما يُختبر هنا يُستخرج من المصدر المشحون (`index.html` وخدمة NestJS) ولا
 *   يُنسخ: النسخة المحلية تظل ناجحة بعد كسر الأصل، وهو بالضبط عيب
 *   `test/unit/returns.spec.ts`.
 *
 * ⚠ `export {}` إلزامي — المساعدات العلوية المتشابهة الأسماء بين ملفي spec تتصادم
 *   كـ TS2393 فلا تعمل أي من المجموعتين.
 */

const INDEX_HTML = path.resolve(__dirname, '../../../frontend/public/index.html');
const SERVICE = path.resolve(__dirname, '../../src/shopify/shopify.service.ts');

/** يقتطع دالة بالاسم من الملف المشحون موازنةً للأقواس. */
function grabFn(src: string, name: string): string {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('الدالة غير موجودة: ' + name);
  /* ⚠ يُتخطّى قوسا المعامِلات أولاً: التوقيع قد يحمل قيمة افتراضية كائنية
       (`opts = {}`)، فأخذ أول "{" بعد الاسم يقتطع القيمة الافتراضية لا الجسم. */
  const lp = src.indexOf('(', m.index);
  let pd = 0, afterParams = lp;
  for (let j = lp; j < src.length; j++) {
    if (src[j] === '(') pd++;
    else if (src[j] === ')') { pd--; if (pd === 0) { afterParams = j; break; } }
  }
  const open = src.indexOf('{', afterParams);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index + 1, j + 1);
    }
  }
  throw new Error('أقواس غير متوازنة: ' + name);
}

/**
 * سجل التعديلات يسمّي الصنف المضاف والمحذوف.
 *
 * السطر السابق كان «عدد الأصناف: 4 ← 2» فقط — رقمٌ لا يقول أيّ صنف خرج. ومع
 * الاستبدال (حذف صنف وإضافة آخر) لا يتغيّر العدد أصلاً فلا يُسجَّل شيء إطلاقاً:
 * تعديلٌ كامل على الأوردر بلا أثر في السجل.
 */
describe('Shopify — سجل التعديلات يسجّل إضافة وحذف الأصناف', () => {
  let diffOrderItems: (a: unknown[], b: unknown[]) => string[];

  beforeAll(() => {
    /* ⚠ تُقرأ الدالة من الخدمة المشحونة عبر `ts-jest` نفسه، لا بنزع الأنواع بتعابير
         نمطية: النزع اليدوي يترك `new Map<...>()` و`(i: any)` فيرمي المحوِّل، وأسوأ
         منه أنه قد "ينجح" على نصٍّ مشوَّه فيختبر منطقاً غير الذي يُشحن.
       ⚠ الدالة `private`، فتُستدعى عبر الكائن نفسه — الخصوصية قيد وقت-ترجمة لا
         وقت-تشغيل. النسخة المُختبَرة هي حرفياً التي تعمل في الإنتاج. */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ShopifyService } = require('../../src/shopify/shopify.service');
    const proto = ShopifyService.prototype as Record<string, unknown>;
    expect(typeof proto.diffOrderItems).toBe('function');
    diffOrderItems = (a, b) =>
      (proto.diffOrderItems as (x: unknown[], y: unknown[]) => string[]).call(proto, a, b);
  });

  const IT = (id: string, name: string, qty: number, price = 10) =>
    ({ productId: id, name, qty, price });

  it('يسجّل الصنف المضاف بالاسم', () => {
    const out = diffOrderItems(
      [IT('a', 'Bow dining', 1)],
      [IT('a', 'Bow dining', 1), IT('b', 'Amwaj Bag', 2)],
    );
    expect(out.some(l => l.includes('أُضيف') && l.includes('Amwaj Bag'))).toBe(true);
  });

  it('يسجّل الصنف المحذوف بالاسم', () => {
    const out = diffOrderItems(
      [IT('a', 'Bow dining', 1), IT('b', 'Amwaj Bag', 2)],
      [IT('a', 'Bow dining', 1)],
    );
    expect(out.some(l => l.includes('حُذف') && l.includes('Amwaj Bag'))).toBe(true);
  });

  /** ⚠ الحالة التي كانت تمرّ بلا أي سطر: العدد لم يتغيّر. */
  it('الاستبدال يُسجَّل حذفاً وإضافةً رغم ثبات العدد', () => {
    const out = diffOrderItems([IT('a', 'Old', 1)], [IT('b', 'New', 1)]);
    expect(out.some(l => l.includes('حُذف') && l.includes('Old'))).toBe(true);
    expect(out.some(l => l.includes('أُضيف') && l.includes('New'))).toBe(true);
  });

  it('يسجّل تغيّر الكمية بالاسم', () => {
    const out = diffOrderItems([IT('a', 'Bow', 1, 10)], [IT('a', 'Bow', 3, 10)]);
    expect(out.some(l => l.includes('كمية') && l.includes('3'))).toBe(true);
  });

  it('يسجّل تغيّر السعر بالاسم', () => {
    const out = diffOrderItems([IT('a', 'Bow', 1, 10)], [IT('a', 'Bow', 1, 25)]);
    expect(out.some(l => l.includes('سعر') && l.includes('25'))).toBe(true);
  });

  it('لا يسجّل شيئاً حين لا يتغيّر شيء', () => {
    expect(diffOrderItems([IT('a', 'Bow', 2, 10)], [IT('a', 'Bow', 2, 10)])).toEqual([]);
  });

  /** ⚠ صنف شوبيفاي غير المطابَق بلا productId — يُفهرس بالكود ثم بالاسم. */
  it('يتعامل مع صنف بلا productId', () => {
    const out = diffOrderItems(
      [{ code: 'X1', name: 'Unmatched', qty: 1, price: 5 }],
      [{ code: 'X1', name: 'Unmatched', qty: 4, price: 5 }],
    );
    expect(out.some(l => l.includes('كمية'))).toBe(true);
  });

  /** ⚠ المكرّرات تُجمَّع لا يطغى آخرها، وإلا قُرئ نقصٌ في الكمية لم يحدث. */
  it('يجمع كميات الأصناف المكرّرة بنفس المفتاح', () => {
    expect(diffOrderItems([IT('a', 'Bow', 1), IT('a', 'Bow', 2)], [IT('a', 'Bow', 3)])).toEqual([]);
  });

  /**
   * ⚠ الاختبارات أعلاه تثبت أن الدالة صحيحة، لا أنها موصولة. هذا يشغّل
   *   `updateOrderItems` المشحونة على مستند وهمي ويقرأ ما استقرّ فعلاً في
   *   `editHistory` — وهو الشيء الذي يراه المستخدم.
   */
  describe('موصولة فعلاً بـ updateOrderItems', () => {
    const buildService = () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ShopifyService } = require('../../src/shopify/shopify.service');
      const svc = Object.create(ShopifyService.prototype) as Record<string, unknown>;
      (svc as { logger: unknown }).logger = { log() {}, warn() {}, error() {} };
      return svc;
    };

    /* ⚠ `itemsTotal`/`total` تُشتقّان من الأصناف الابتدائية لا تُترَكان صفراً:
         مستندٌ يبدأ بصفر يُسجّل «إجمالي الأصناف: 0 ← 20» في كل حالة، فتبدو حالة
         «لا تغيير» فاشلةً لعيبٍ في التجهيزة لا في الكود. */
    const sum = (items: Array<Record<string, number>>) =>
      items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    const makeOrder = (items: unknown[]) => {
      const base = sum(items as Array<Record<string, number>>);
      return {
        _id: 'o1', ref: '2526', status: 'pending', items,
        itemsTotal: base, total: base, discount: 0, manualDiscount: 0, codesDiscount: 0,
        editHistory: [] as Array<{ changes: string[] }>,
        markModified() {}, save() { return Promise.resolve(this); },
      };
    };

    const run = async (oldItems: unknown[], newItems: unknown[]) => {
      const svc = buildService();
      const order = makeOrder(oldItems);
      (svc as { shopifyOrderModel: unknown }).shopifyOrderModel = {
        findById: () => Promise.resolve(order),
      };
      await (svc.updateOrderItems as (a: string, b: unknown[], c: string) => Promise<unknown>)
        .call(svc, 'o1', newItems, 'Fares');
      return order.editHistory;
    };

    it('إضافة صنف تصل إلى editHistory بالاسم', async () => {
      const hist = await run(
        [IT('a', 'Bow dining', 1)],
        [IT('a', 'Bow dining', 1), IT('b', 'Amwaj Bag', 2)],
      );
      expect(hist).toHaveLength(1);
      expect(hist[0].changes.some(l => l.includes('أُضيف') && l.includes('Amwaj Bag'))).toBe(true);
    });

    it('حذف صنف يصل إلى editHistory بالاسم', async () => {
      const hist = await run(
        [IT('a', 'Bow dining', 1), IT('b', 'Amwaj Bag', 2)],
        [IT('a', 'Bow dining', 1)],
      );
      expect(hist[0].changes.some(l => l.includes('حُذف') && l.includes('Amwaj Bag'))).toBe(true);
    });

    /** ⚠ الحالة التي كانت تُحفظ بلا أي سطر في السجل. */
    it('الاستبدال يُسجَّل رغم ثبات عدد الأصناف', async () => {
      const hist = await run([IT('a', 'Old', 1, 10)], [IT('b', 'New', 1, 10)]);
      expect(hist).toHaveLength(1);
      expect(hist[0].changes.some(l => l.includes('حُذف') && l.includes('Old'))).toBe(true);
      expect(hist[0].changes.some(l => l.includes('أُضيف') && l.includes('New'))).toBe(true);
    });

    /** حفظٌ لم يغيّر شيئاً لا يُسجَّل — قاعدة `pushOrderHistory` القائمة. */
    it('لا يُكتب سطر حين لا يتغيّر شيء', async () => {
      expect(await run([IT('a', 'Bow', 2, 10)], [IT('a', 'Bow', 2, 10)])).toHaveLength(0);
    });
  });
});

/** حماية الخصم في محرّر الأوردر — نفس نظام النظام لا نظام ثانٍ. */
describe('Shopify — حماية الخصم مطابقة لنظام المعاملات', () => {
  let src: string;
  beforeAll(() => { src = fs.readFileSync(INDEX_HTML, 'utf8'); });

  it('الشرط مطابق حرفياً لشرط saveTx', () => {
    expect(grabFn(src, '_spDiscountPreflight'))
      .toContain('_isOtpRequired() && ourDisc > getHighValueDiscountLimit()');
  });

  /** ⚠ الحد يُذكر قبل الضغط لا بعده — الرفض بعد الحفظ يأتي متأخراً. */
  it('يعرض الحد في اللوحة قبل الحفظ', () => {
    const guard = grabFn(src, '_spDiscGuardHtml');
    expect(guard).toContain('getHighValueDiscountLimit()');
    expect(guard).toContain('spDiscLimitNote');
    expect(guard).toContain('spDiscLimitOver');
    /* ⚠ يُفتَّش داخل `_spRenderDiscountTab` لا في الملف كله: الدالة قد تبقى معرَّفة
         بينما يُحذف استدعاؤها من القالب، فيمرّ الاختبار على ميزةٍ لا تُرسم. */
    expect(grabFn(src, '_spRenderDiscountTab')).toContain('_spDiscGuardHtml(ourDisc)');
  });

  it('الأدمن لا يُعرض له حد', () => {
    expect(grabFn(src, '_spDiscGuardHtml')).toContain('if (!_isOtpRequired()) return');
  });

  it('يعرض حالة «تم التحقق» للقيمة المعتمَدة وحدها', () => {
    const guard = grabFn(src, '_spDiscGuardHtml');
    expect(guard).toContain('spDiscOtpVerified');
    // نفس هامش 0.5 الذي يقبله الخادم — لا هامش ثانٍ مخترع هنا.
    expect(guard).toContain('_spDiscOtpAmount - ourDisc) <= 0.5');
  });

  /** ⚠ التحقق السابق يُمسح تحت الحد، وإلا أُعيد استعمال موافقة صدرت لمبلغ آخر. */
  it('يمسح OTP قديماً حين ينزل الخصم تحت الحد', () => {
    const save = grabFn(src, '_spDiscountPreflight');
    expect(save).toContain('_spDiscOtpAmount = 0;');
    expect(/\} else \{[\s\S]{0,600}_spDiscOtpId = /.test(save)).toBe(true);
  });

  it('يسجّل المحاولة والنتيجة في سجل مراجعة الخصم', () => {
    // المحاولة تُسجَّل عند البوابة، والنتيجة عند الكتابة.
    expect(grabFn(src, '_spDiscountPreflight')).toContain("_logBundleDiscAction('pending_approval'");
    expect(grabFn(src, '_spPersistDiscount'))
      .toContain("_logBundleDiscAction(_spDiscOtpId ? 'approved' : 'applied'");
  });

  it('مفاتيح الترجمة الجديدة موجودة بقيمة إنجليزية حقيقية', () => {
    const keys = ['spDiscLimitNote', 'spDiscLimitOver', 'spDiscOtpVerified',
      'spBlkGrpStock', 'spBlkGrpMissing', 'spBlkGrpDup', 'spBlkGrpOther', 'spBlkOrdersN'];
    for (const k of keys) {
      // ⚠ قيمة en فارغة تسقط إلى العربية بصمت (فخّ t() الموثّق) — لذا [^']+ لا [^']*
      expect(new RegExp(k + ":\\{ar:'[^']+',en:'[^']+'\\}").test(src)).toBe(true);
    }
  });

  /** ⚠ أيقونتا الحارس `const` — غير مرفوعتين، فوضعهما تحت مستهلكهما يرمي TDZ. */
  it('أيقونات الحارس معرَّفة فوق مستهلكها', () => {
    expect(src.indexOf('const SP_GUARD_LOCK')).toBeLessThan(src.indexOf('function _spDiscGuardHtml'));
  });
});

/** قائمة المحجوبين مختصرة بالسبب. */
describe('Shopify — قائمة الأوردرات المحجوبة مجمَّعة', () => {
  let src: string;
  beforeAll(() => { src = fs.readFileSync(INDEX_HTML, 'utf8'); });

  it('التجميع يقرأ الوسم لا نصّ الرسالة المترجَم', () => {
    const fn = grabFn(src, '_spBlockedGroupsHtml');
    expect(fn).toContain("b.kind || 'other'");
    // مطابقة النص المعروض تنهار فور تبديل اللغة.
    expect(fn).not.toContain('available');
  });

  it('كل مسار حجب يحمل وسمه', () => {
    const v = grabFn(src, '_spValidateBulkSelection');
    for (const k of ["kind: 'other'", "kind: 'dup'", "kind: 'missing'", "kind: 'stock'"]) {
      expect(v).toContain(k);
    }
  });

  /** ⚠ لا يُحذف أوردر من العرض: الزائد يظهر كشارة «+n» ونصّه في title. */
  it('الزائد عن الحد يُذكر ولا يُسقط', () => {
    const fn = grabFn(src, '_spBlockedGroupsHtml');
    expect(fn).toContain('spBlkMoreN');
    expect(fn).toContain('rows.slice(MAX)');
  });

  it('الجملة الأصلية تبقى في title لكل رقم', () => {
    expect(grabFn(src, '_spBlockedGroupsHtml')).toContain('escHtml(b.reason');
  });

  it('السطر القديم (جملة كاملة لكل أوردر) لم يعد يُرسم', () => {
    expect(src).not.toContain('<div style="padding:4px 0;font-size:.78rem;line-height:1.5"><b>#$');
  });
});

/** القائمة المنسدلة لاختيار المنتج — الظهور والتصفية. */
describe('Shopify — القائمة المنسدلة تظهر بنعومة', () => {
  let src: string;
  beforeAll(() => { src = fs.readFileSync(INDEX_HTML, 'utf8'); });

  it('تتحرّك عند الفتح فقط لا مع كل حرف', () => {
    expect(src).toContain('.sp-pick-menu.is-open.is-typing{animation:none}');
    expect(grabFn(src, '_shopifyInlineSearch')).toContain("classList.toggle('is-typing', wasOpen)");
  });

  /** ⚠ القياس بعد تصفير maxHeight، وإلا قرأ الارتفاع المقصوص فلا تكبر القائمة أبداً. */
  it('تصفّر maxHeight قبل قياس المحتوى', () => {
    const fn = grabFn(src, '_shopifyInlineSearch');
    const clear = fn.indexOf("pickerEl.style.maxHeight = ''");
    const measure = fn.indexOf('pickerEl.scrollHeight');
    expect(clear).toBeGreaterThan(-1);
    expect(measure).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(measure);
  });

  it('تحترم prefers-reduced-motion', () => {
    expect(src).toContain('.sp-pick-menu.is-open{animation:none}');
  });

  it('الإخفاء يمسح حالة الفتح', () => {
    expect(grabFn(src, '_spPickHide')).toContain("classList.remove('is-open', 'is-typing')");
  });

  /** الحركة على opacity/transform وحدهما — تحريك الارتفاع يعيد تخطيط أربعين صفاً. */
  it('حركة الظهور لا تحرّك الارتفاع', () => {
    const kf = src.slice(src.indexOf('@keyframes spPickIn'), src.indexOf('@keyframes spPickIn') + 160);
    expect(kf).toContain('opacity');
    expect(kf).toContain('transform');
    expect(kf).not.toContain('height');
  });
});
