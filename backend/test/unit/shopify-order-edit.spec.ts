import * as fs from 'fs';
import * as path from 'path';

export {};

/**
 * تعديل أوردر شوبيفاي — الخصم والتعليقات وسجل التعديلات.
 *
 * ⚠ دوال الواجهة تُستخرج من `frontend/public/index.html` المشحون ولا تُنسخ هنا:
 *   النسخة تظل ناجحة بعد كسر الأصل، وهو بالضبط عيب `test/unit/returns.spec.ts`
 *   الذي يؤكد على إعادة تنفيذ محلية فينجح سواء عمل الكود أم لا.
 *
 * ⚠ `export {}` إلزامي — المساعدات العلوية المتشابهة الأسماء بين ملفي spec تتصادم
 *   كـ TS2393 فلا تعمل أي من المجموعتين.
 *
 * القاعدة المحورية التي تقفلها هذه الحالات: خصم شوبيفاي (`discount`) وخصمنا
 * (`manualDiscount`/`codesDiscount`) حقول منفصلة تُجمع عند الحساب. الفصل هو ما يمنع
 * `handleOrderUpdate` من محو خصم الموظف عند كل orders/updated.
 */

const INDEX_HTML = path.resolve(__dirname, '../../../frontend/public/index.html');

/** يقتطع دالة بالاسم من الملف المشحون موازنةً للأقواس. */
function extractFn(src: string, name: string): string {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('الدالة غير موجودة في index.html: ' + name);
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

interface DiscEnv {
  codeAmount(c: { type: string; value: number }, itemsTotal: number): number;
  codesTotal(itemsTotal: number): number;
  manualAmount(itemsTotal: number): number;
  set(codes: Array<{ type: string; value: number }>, type: string, typed: string): void;
}

function loadDiscountFns(): DiscEnv {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
  const body = ['_spCodeAmount', '_spCodesTotal', '_spManualAmount']
    .map(n => extractFn(src, n))
    .join('\n');

  // بيئة صغيرة: الدوال تقرأ _spDiscCodes و_spDiscType وقيمة الحقل عبر qs.
  return new Function(`
    let _spDiscCodes = [], _spDiscType = 'fixed', _typed = '';
    const qs = () => ({ value: _typed });
    ${body}
    return {
      codeAmount: _spCodeAmount,
      codesTotal: _spCodesTotal,
      manualAmount: _spManualAmount,
      set(codes, type, typed) { _spDiscCodes = codes; _spDiscType = type; _typed = typed; },
    };
  `)() as DiscEnv;
}

/** الإجمالي كما تحسبه الخدمة — منسوخ الصيغة من computeShopifyOrderTotal للتحقق المتقاطع. */
function serviceTotal(o: {
  itemsTotal: number;
  shipCost?: number;
  discount?: number;
  manualDiscount?: number;
  codesDiscount?: number;
}) {
  const itemsTotal = Number(o.itemsTotal) || 0;
  const raw =
    (Number(o.discount) || 0) +
    (Number(o.manualDiscount) || 0) +
    (Number(o.codesDiscount) || 0);
  const totalDiscount = Math.min(Math.max(0, raw), itemsTotal);
  return {
    totalDiscount,
    total: Math.max(0, itemsTotal - totalDiscount + (Number(o.shipCost) || 0)),
  };
}

describe('Shopify order edit — حساب الخصم (من index.html المشحون)', () => {
  const env = loadDiscountFns();

  describe('قيمة الكود الواحد', () => {
    it('مبلغ ثابت يُؤخذ كما هو', () => {
      expect(env.codeAmount({ type: 'fixed', value: 50 }, 1000)).toBe(50);
    });

    it('نسبة تُحسب على إجمالي الأصناف', () => {
      expect(env.codeAmount({ type: 'percent', value: 10 }, 1000)).toBe(100);
    });

    it('النسبة تُقرَّب لأقرب جنيه — نفس Math.round في _txCodesTotal', () => {
      expect(env.codeAmount({ type: 'percent', value: 15 }, 333)).toBe(50);
    });

    it('قيمة غائبة تُعامَل صفراً لا NaN', () => {
      expect(env.codeAmount({ type: 'fixed', value: undefined as any }, 1000)).toBe(0);
    });
  });

  describe('مجموع الأكواد', () => {
    it('يجمع الثابت والنسبة معاً', () => {
      env.set([{ type: 'fixed', value: 50 }, { type: 'percent', value: 10 }], 'fixed', '');
      expect(env.codesTotal(1000)).toBe(150);
    });

    it('بلا أكواد يساوي صفراً', () => {
      env.set([], 'fixed', '');
      expect(env.codesTotal(1000)).toBe(0);
    });
  });

  describe('الخصم اليدوي', () => {
    it('مبلغ ثابت', () => {
      env.set([], 'fixed', '200');
      expect(env.manualAmount(1000)).toBe(200);
    });

    it('نسبة مئوية', () => {
      env.set([], 'percent', '25');
      expect(env.manualAmount(1000)).toBe(250);
    });

    it('النسبة تُقص عند 100% — نسبة أكبر لا تتجاوز قيمة الأصناف', () => {
      env.set([], 'percent', '150');
      expect(env.manualAmount(1000)).toBe(1000);
    });

    it('حقل فارغ يساوي صفراً', () => {
      env.set([], 'fixed', '');
      expect(env.manualAmount(1000)).toBe(0);
    });

    it('قيمة سالبة تساوي صفراً', () => {
      env.set([], 'fixed', '-50');
      expect(env.manualAmount(1000)).toBe(0);
    });
  });
});

describe('Shopify order edit — إجمالي الأوردر', () => {
  it('بلا أي خصم', () => {
    expect(serviceTotal({ itemsTotal: 1000, shipCost: 50 })).toEqual({
      totalDiscount: 0,
      total: 1050,
    });
  });

  it('خصم شوبيفاي وحده', () => {
    expect(serviceTotal({ itemsTotal: 1000, shipCost: 50, discount: 100 })).toEqual({
      totalDiscount: 100,
      total: 950,
    });
  });

  /**
   * السلوك المطلوب صراحةً: الخصم الإضافي يُجمع فوق خصم شوبيفاي، لا يحلّ محله.
   */
  it('الخصم اليدوي يُضاف فوق خصم شوبيفاي', () => {
    expect(
      serviceTotal({ itemsTotal: 1000, shipCost: 50, discount: 100, manualDiscount: 50 }),
    ).toEqual({ totalDiscount: 150, total: 900 });
  });

  it('الثلاثة معاً: شوبيفاي + أكواد + يدوي', () => {
    expect(
      serviceTotal({
        itemsTotal: 1000,
        shipCost: 50,
        discount: 100,
        codesDiscount: 80,
        manualDiscount: 20,
      }),
    ).toEqual({ totalDiscount: 200, total: 850 });
  });

  /**
   * ⚠ القص جماعي لا فردي. قص كل خصم على حدة يسمح لمجموعها بتجاوز قيمة الأصناف
   *   فيخرج إجمالي سالب — وهو ما تقفله هذه الحالة.
   */
  it('مجموع الخصومات يُقص عند إجمالي الأصناف فلا يصير الإجمالي سالباً', () => {
    expect(
      serviceTotal({ itemsTotal: 100, shipCost: 0, discount: 90, manualDiscount: 90 }),
    ).toEqual({ totalDiscount: 100, total: 0 });
  });

  it('الشحن يُضاف بعد الخصم ولا يُخصم منه', () => {
    expect(
      serviceTotal({ itemsTotal: 500, shipCost: 50, discount: 300, manualDiscount: 400 }),
    ).toEqual({ totalDiscount: 500, total: 50 });
  });

  it('قيم غائبة أو NaN تُعامَل صفراً', () => {
    expect(
      serviceTotal({ itemsTotal: 200, manualDiscount: undefined, codesDiscount: NaN }),
    ).toEqual({ totalDiscount: 0, total: 200 });
  });

  it('خصم سالب لا يزيد الإجمالي', () => {
    expect(serviceTotal({ itemsTotal: 200, discount: -50 })).toEqual({
      totalDiscount: 0,
      total: 200,
    });
  });

  /**
   * السيناريو الذي بُني الفصل من أجله.
   *
   * أوردر معلق بخصم يدوي 200 يصله orders/updated بأرقام شوبيفاي الأصلية (خصم 0).
   * لأن الويب هوك يعيد الحساب عبر computeShopifyOrderTotal بدل إسناد إجمالي شوبيفاي
   * مباشرة، يبقى الخصم اليدوي في الإجمالي. قبل هذا كان الإجمالي يعود 1050.
   */
  it('الخصم اليدوي ينجو من إعادة حساب الويب هوك', () => {
    expect(
      serviceTotal({ itemsTotal: 1000, shipCost: 50, discount: 0, manualDiscount: 200 }),
    ).toEqual({ totalDiscount: 200, total: 850 });
  });
});

describe('Shopify order edit — بنية الواجهة في index.html', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  it('التبويبان معرَّفان وأزرارهما مربوطة بـ _spSetTab', () => {
    for (const tab of ['items', 'history']) {
      expect(src).toContain(`data-sp-tab="${tab}"`);
      expect(src).toContain(`_spSetTab('${tab}')`);
    }
  });

  it('كل تبويب له لوحة مطابقة — وإلا بقيت اللوحة مخفية دائماً', () => {
    for (const pane of ['items', 'history']) {
      expect(src).toContain(`data-sp-pane="${pane}"`);
    }
  });

  /**
   * ⚠ الخصم يُحسب على الأصناف، وفصلهما في تبويبين كان يخفي أثر إضافة صنف على الخصم
   *   المقترح حتى ينتقل الموظف بين التبويبين. صارا لوحة واحدة.
   */
  it('لا تبويب مستقل للخصم — دُمج تحت الأصناف', () => {
    expect(src).not.toContain('data-sp-tab="discount"');
    expect(src).not.toContain('data-sp-pane="discount"');
    expect(extractFn(src, '_spSetTab')).not.toMatch(/tab === 'discount'/);
  });

  /**
   * التعليقات خرجت من مودال التعديل إلى نافذة مستقلة: كان الوصول إليها يكلّف
   * ثلاث خطوات (فتح الأوردر ← تعديل ← تبويب) وهي أكثر فعل يتكرر على أوردر قيد
   * المتابعة. بقاء التبويب مع النافذة يترك مدخلين لنفس الشيء.
   */
  it('لا تبويب تعليقات داخل مودال التعديل', () => {
    expect(src).not.toContain('data-sp-tab="comments"');
    expect(src).not.toContain('data-sp-pane="comments"');
    expect(extractFn(src, '_spSetTab')).not.toContain('_spRenderCommentsTab');
  });

  /**
   * ⚠ [hidden] عند الوكيل display:none فقط، ويخسر أمام display المعلن على .sp-tab-pane.
   *   بدون !important تبقى كل اللوحات ظاهرة فوق بعضها. نفس فخ .rv-toggle[hidden].
   */
  it('.sp-tab-pane[hidden] يفرض الإخفاء بـ !important', () => {
    expect(src).toContain('.sp-tab-pane[hidden]{display:none!important}');
  });

  it('كل تبويب يحفظ عبر مسار خاص به — لا حفظ موحّد', () => {
    expect(src).toContain('/discount`');
    expect(src).toContain('/comments`');
    expect(src).toContain('/items`');
  });

  /**
   * ⚠ openHighValueOtpFlow تقرأ #tx-client و#tx-ref من نموذج المعاملة وتتوقف إن غابا،
   *   وهما غير موجودين في مودال شوبيفاي. لذا مسار الأوردر يملأ _hvOtpCtx بنفسه.
   */
  it('بوابة OTP للأوردر لا تمر عبر openHighValueOtpFlow', () => {
    const fn = extractFn(src, '_spOpenDiscountOtp');
    expect(fn).toContain('_hvOtpCtx');
    expect(fn).not.toContain('openHighValueOtpFlow(');
  });

  /**
   * ⚠ submitHighValueOtp بدون callback يستدعي saveTx() — أي أنه يحفظ معاملة لا علاقة
   *   لها بالأوردر. onSuccess هنا هو ما يمنع ذلك.
   */
  it('بوابة OTP تمرر onSuccess فتعود إلى حفظ الخصم لا إلى saveTx', () => {
    const fn = extractFn(src, '_spOpenDiscountOtp');
    expect(fn).toContain('onSuccess');
    /* ⚠ الاستئناف صار قابلاً للتمرير: زر «حفظ التغييرات» يستأنف حفظ الأصناف
         والخصم معاً، بينما زر «تطبيق الخصم» يبقى على السلوك الافتراضي. */
    expect(fn).toContain('_spSaveDiscount');
    expect(fn).toContain('onOk');
  });

  it('شرط OTP مطابق لشرط سجل المعاملات — الأدمن معفى', () => {
    // القاعدة انتقلت إلى الفحص المشترك الذي يمرّ به الزرّان.
    const fn = extractFn(src, '_spDiscountPreflight');
    expect(fn).toContain('_isOtpRequired()');
    expect(fn).toContain('getHighValueDiscountLimit()');
  });

  /**
   * ⚠ صلاحية الأكواد تمر عبر _codeNotStarted/_codeExpired لا بمقارنة تواريخ جديدة:
   *   الاثنان يصحّحان اليوم المحلي، ومقارنة خام تُنهي الأكواد قبل أوانها في توقيت مصر.
   */
  it('فلترة الأكواد تعيد استخدام مساعدات التواريخ المحلية', () => {
    const fn = extractFn(src, '_spActiveCodes');
    expect(fn).toContain('_codeNotStarted');
    expect(fn).toContain('_codeExpired');
  });

  /**
   * ⚠ إعادة رسم التبويب كله عند كل ضغطة مفتاح تفقد تركيز حقل القيمة.
   *   المعاينة تحدّث الملخص والخطأ فقط. نفس قاعدة _cxrRenderTable.
   */
  it('معاينة الخصم تحدّث الملخص فقط لا التبويب كله', () => {
    const fn = extractFn(src, '_spRenderDiscountPreview');
    expect(fn).toContain('#sp-disc-sum');
    expect(fn).not.toContain('_spRenderDiscountTab()');
  });

  /**
   * ⚠ 'ar-EG' وحدها تطبع أرقاماً هندية (٠-٩) — الفخ المتكرر في هذا الملف.
   */
  /**
   * ⚠ 'ar-EG' وحدها تطبع أرقاماً هندية (٠-٩) — الفخ المتكرر في هذا الملف.
   *   التعليقات تستعمل _cmtTimeHtml نفسها التي تستعملها الفاتورة، فالوقت النسبي
   *   والدقيق عند الهوفر متطابقان في الموضعين؛ السجل يصوغ تاريخه بنفسه.
   */
  it('تاريخ سجل التعديلات بأرقام لاتينية', () => {
    expect(extractFn(src, '_spRenderHistoryTab')).toContain('ar-EG-u-nu-latn');
  });

  /**
   * ⚠ السيرفر أولاً: الكائن المحلي لا يُلمس إلا بعد نجاح الطلب، فالفشل لا يترك
   *   نصاً جديداً على الشاشة يظنه الموظف محفوظاً. نفس ترتيب saveInvCommentEdit.
   *   (هذا أقوى من الإرجاع بعد الفشل: لا حالة وسيطة خاطئة أصلاً.)
   */
  it('حالة التعليقات المحلية لا تتغير إلا بعد نجاح الطلب', () => {
    const fn = extractFn(src, '_spPersistComments');
    expect(fn.indexOf('await api(')).toBeLessThan(fn.indexOf('order.comments = comments'));
  });

  it('تغيير الخصم يُبطل أي OTP سابق — الكود مرتبط بقيمة بعينها', () => {
    for (const name of ['_spToggleCode', '_spSetDiscType']) {
      expect(extractFn(src, name)).toContain('_spDiscOtpId = ');
    }
  });
});

describe('Shopify order edit — التعليقات مطابقة لنظام الفاتورة', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  it('يعيد استخدام أصناف الفاتورة لا أصنافاً خاصة — فالشكل واحد', () => {
    const fn = extractFn(src, '_spRenderCommentsTab');
    for (const cls of ['inv-cmt-item', 'tx-cmt-avatar', 'tx-cmt-author', 'tx-cmt-time', 'tx-cmt-text', 'inv-cmt-list']) {
      expect(fn).toContain(cls);
    }
  });

  it('يعرض صورة الحرفين والوقت النسبي بنفس مساعدات الفاتورة', () => {
    const fn = extractFn(src, '_spRenderCommentsTab');
    expect(fn).toContain('_cmtInitials');
    expect(fn).toContain('_cmtTimeHtml');
  });

  it('نص التعليق يمر بـ renderMentionText فتظهر المنشنات ملوّنة', () => {
    expect(extractFn(src, '_spRenderCommentsTab')).toContain('renderMentionText');
  });

  it('التعديل والحذف يظهران لصاحب التعليق فقط', () => {
    const fn = extractFn(src, '_spRenderCommentsTab');
    expect(fn).toContain('isMine');
    expect(fn).toContain('_spStartEditComment');
    expect(fn).toContain('_spDeleteComment');
  });

  /**
   * ⚠ selectMention يبني معرّف الحقل كـ `inv-comment-text-<id>` عند إدراج الاسم
   *   المختار. أي تسمية أخرى تجعل الاختيار من قائمة المنشن لا يكتب شيئاً.
   */
  it('حقل الكتابة يحمل المعرّف الذي يتوقعه selectMention', () => {
    expect(extractFn(src, '_spRenderCommentsTab')).toContain('inv-comment-text-');
  });

  it('الإكمال التلقائي للمنشن موصول بالحقل', () => {
    const fn = extractFn(src, '_spRenderCommentsTab');
    expect(fn).toContain('onMentionInput');
    expect(fn).toContain('onMentionKey');
  });

  /**
   * ⚠ Enter يرسل التعليق إلا أثناء فتح قائمة المنشن — وإلا أرسل التعليق بدل اختيار
   *   الاسم الذي يتصفّحه المستخدم.
   */
  it('Enter لا يرسل بينما قائمة المنشن مفتوحة', () => {
    expect(extractFn(src, '_spRenderCommentsTab')).toContain('!_mentionDropdown');
  });

  it('التعديل يستخدم نفس شكل ومفاتيح startEditInvComment', () => {
    const fn = extractFn(src, '_spStartEditComment');
    expect(fn).toContain('tx-cmt-edit-row');
    expect(fn).toContain('tx-cmt-edit-input');
    expect(fn).toContain("ivCmtSave");
  });

  it('التعديل بلا تغيير لا يرسل طلباً', () => {
    expect(extractFn(src, '_spSaveCommentEdit')).toContain('cmt.text === newText');
  });

  it('الحذف يؤكد أولاً بنفس حوار الفاتورة — لا رجعة فيه', () => {
    const fn = extractFn(src, '_spDeleteComment');
    expect(fn).toContain('showConfirm');
    expect(fn).toContain('ivCmtDeleteConfirm');
    expect(fn).toContain('danger');
  });

  /**
   * ⚠ السيرفر أولاً: تعديل الحالة المحلية قبل نجاح الطلب يترك النص الجديد على
   *   الشاشة بعد الفشل فيظن الموظف أنه حُفظ.
   */
  it('الحالة المحلية لا تتغير إلا بعد نجاح الطلب', () => {
    const fn = extractFn(src, '_spPersistComments');
    expect(fn.indexOf('await api(')).toBeLessThan(fn.indexOf('order.comments = comments'));
  });

  /**
   * ⚠ processMentionsInComment تخرج صامتة إن لم يكن txId في مصفوفة transactions،
   *   ومعرّف الأوردر ليس معاملة — فاستخدامها كان يُسقط كل منشن هنا بلا أثر.
   */
  it('المنشن لا يمر عبر processMentionsInComment', () => {
    const fn = extractFn(src, '_spProcessMentions');
    expect(fn).not.toContain('processMentionsInComment(');
    expect(fn).toContain("api('/mentions'");
  });

  it('المنشن يعمل عند الإضافة وعند التعديل معاً', () => {
    expect(extractFn(src, '_spAddComment')).toContain('_spProcessMentions');
    expect(extractFn(src, '_spSaveCommentEdit')).toContain('_spProcessMentions');
  });

  /**
   * ⚠ فشل إرسال المنشن كان `catch (_) {}` في الأصل: التعليق يُحفظ فيطمئن الموظف
   *   أنه نبّه زميله والزميل لم يصله شيء.
   */
  it('فشل المنشن يُعلَن ولا يُبتلع', () => {
    expect(extractFn(src, '_spProcessMentions')).toContain('_warnMentionFailed');
  });

  it('المنشن يحدّث الشارة وقائمة الإشعارات', () => {
    const fn = extractFn(src, '_spProcessMentions');
    expect(fn).toContain('refreshMentionsFromServer');
    expect(fn).toContain('buildNotifications');
    expect(fn).toContain('_updateMentionBadge');
  });

  /**
   * ⚠ onMentionNotifClick يفرّق بالوجهة عبر نص التعليق أو fromName. بلا علامة
   *   يسقط منشن الأوردر في مسار الفاتورة فلا يفتح شيئاً.
   */
  it('نص المنشن يحمل علامة تميّز الأوردر عن الفاتورة', () => {
    expect(extractFn(src, '_spProcessMentions')).toContain('SP_MENTION_TAG');
    expect(src).toContain("const SP_MENTION_TAG = 'أوردر شوبيفاي'");
  });

  it('التوجيه يفتح نافذة التعليقات ويومض على التعليق المنادى عليه', () => {
    const fn = extractFn(src, 'openShopifyOrderComments');
    expect(fn).toContain('openShopifyCommentsModal(orderId)');
    expect(fn).toContain('comment-mention-highlight');
  });

  /**
   * ⚠ لا بد أن يسبق فرعَي المتابعة والفاتورة في onMentionNotifClick: كلاهما يعامل
   *   المعرّف كمعاملة فيبتلع منشن الأوردر.
   */
  it('فرع التوجيه يسبق فرعي المتابعة والفاتورة', () => {
    const fn = extractFn(src, 'onMentionNotifClick');
    const sp = fn.indexOf('openShopifyOrderComments');
    const fu = fn.indexOf('isCommentNotif');
    expect(sp).toBeGreaterThan(-1);
    expect(sp).toBeLessThan(fu);
  });
});


/**
 * الباندلز (Smart discount bundles) على أوردر شوبيفاي.
 *
 * القاعدة: محرك واحد لا اثنان. `_bundleSuggestionsFor` هي نفسها التي يستعملها سجل
 * المعاملات، فباندل يتغيّر في الإعدادات ينعكس على الشاشتين معاً. نسخ القواعد كان
 * سيجعل نفس السلة تقترح خصمين مختلفين حسب الشاشة.
 */
describe('Shopify order edit — اقتراحات الباندلز', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  /** يبني النواة المستخرجة مع بيئة صغيرة. */
  function buildEngine() {
    return new Function('settings', 'products', 'items', 'applied', `
      const _codeNotStarted = (d, now) => { if (!d) return false; const s = new Date(d);
        return new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(),0,0,0,0) > now; };
      const _codeExpired = (d, now) => { if (!d) return false; const e = new Date(d);
        return new Date(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate(),23,59,59,999) < now; };
      ${extractFn(src, '_bundleSuggestionsFor')}
      return _bundleSuggestionsFor(items, applied, {});
    `);
  }

  const products = [
    { _id: 'p1', name: 'Bow dining coaster' },
    { _id: 'p2', name: 'Bow coaster cups' },
  ];
  const settings = {
    discountCodes: [
      { id: 'c1', code: 'BOWDINING', type: 'fixed', value: 190, active: true },
      { id: 'cx', code: 'EXPIRED', type: 'fixed', value: 50, active: true, endDate: '2020-01-01' },
      { id: 'ci', code: 'INACTIVE', type: 'fixed', value: 30, active: false },
    ],
    discountBundles: [
      { id: 'b1', name: 'Bow dining offer', active: true, productIds: ['p1', 'p2'],
        discountCodeId: 'c1', minQty: 6, priority: 1, allowPartial: true, partialDiscountCodeId: 'c1' },
      { id: 'b2', name: 'Expired offer', active: true, productIds: ['p1'],
        discountCodeId: 'cx', minQty: 1, priority: 2, allowPartial: false },
      { id: 'b3', name: 'Inactive code', active: true, productIds: ['p2'],
        discountCodeId: 'ci', minQty: 1, priority: 3, allowPartial: false },
    ],
  };
  const run = (items: any[], applied: any[] = []) =>
    buildEngine()(settings, products, items, applied) as any[];

  it('باندل كامل مستوفى الكميات يُقترح بقيمته الصحيحة', () => {
    const out = run([{ productId: 'p1', qty: 6, price: 100 }, { productId: 'p2', qty: 6, price: 50 }]);
    const bow = out.find(x => x.code === 'BOWDINING');
    expect(bow).toBeDefined();
    expect(bow.isFull).toBe(true);
    expect(bow.discountAmt).toBe(190);
  });

  it('كمية أقل من الحد الأدنى لا تُنتج اقتراحاً', () => {
    const out = run([{ productId: 'p1', qty: 2, price: 100 }, { productId: 'p2', qty: 2, price: 50 }]);
    expect(out.find(x => x.code === 'BOWDINING')).toBeUndefined();
  });

  it('كود منتهي أو معطَّل لا يُقترح', () => {
    const out = run([{ productId: 'p1', qty: 6, price: 100 }, { productId: 'p2', qty: 6, price: 50 }]);
    expect(out.some(x => x.code === 'EXPIRED')).toBe(false);
    expect(out.some(x => x.code === 'INACTIVE')).toBe(false);
  });

  it('الباندل الجزئي يُقترح ويسمّي الصنف الناقص', () => {
    const out = run([{ productId: 'p1', qty: 6, price: 100 }]);
    const bow = out.find(x => x.code === 'BOWDINING');
    expect(bow).toBeDefined();
    expect(bow.isFull).toBe(false);
    expect(bow.partialMissing).toContain('Bow coaster cups');
  });

  /**
   * السلوك المطلوب صراحةً: أصناف شوبيفاي غير المطابَقة (بلا productId) لا تنتمي لأي
   * باندل، فالاقتراح يُحسب من المطابَق ولا يُحجب بسببها.
   */
  it('الأصناف غير المطابَقة لا تمنع اقتراحاً صحيحاً', () => {
    const out = run([
      { productId: '', qty: 2, price: 100 },
      { productId: null, qty: 1, price: 80 },
      { productId: 'p1', qty: 6, price: 100 },
      { productId: 'p2', qty: 6, price: 50 },
    ]);
    expect(out.some(x => x.code === 'BOWDINING')).toBe(true);
  });

  it('الكود المطبَّق بالفعل يُعلَّم لا يُكرَّر', () => {
    const out = run(
      [{ productId: 'p1', qty: 6, price: 100 }, { productId: 'p2', qty: 6, price: 50 }],
      [{ id: 'c1' }],
    );
    expect(out.filter(x => x.code === 'BOWDINING').length).toBe(1);
    expect(out.find(x => x.code === 'BOWDINING').alreadyApplied).toBe(true);
  });

  it('سلة بلا منتجات مرتبطة لا تُنتج اقتراحات', () => {
    expect(run([{ productId: 'p9', qty: 1, price: 10 }])).toHaveLength(0);
  });
});

describe('Shopify order edit — الباندلز موصولة بالواجهة', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  /**
   * ⚠ محرك واحد: لو نُسخت القواعد بدل استدعاء النواة، انحرفت الشاشتان وأصبح نفس
   *   الأوردر يقترح خصماً مختلفاً حسب مكان فتحه.
   */
  it('تستدعي النواة المشتركة لا نسخة خاصة', () => {
    expect(extractFn(src, '_spBundleSuggestions')).toContain('_bundleSuggestionsFor(');
  });

  it('الغلاف القديم ما زال يستدعي النواة نفسها — سجل المعاملات لم يتغيّر', () => {
    expect(extractFn(src, '_computeDiscountSuggestions')).toContain('_bundleSuggestionsFor(');
  });

  /** ⚠ لوحة اقتراحات لا يجب أن تُسقط تبويب الخصم كله عند خطأ في بيانات باندل. */
  it('فشل حساب الاقتراحات لا يُسقط التبويب', () => {
    expect(extractFn(src, '_spBundleSuggestions')).toContain('catch');
  });

  it('الاقتراح يُعرض ولا يُطبَّق تلقائياً — النقر قرار الموظف', () => {
    const fn = extractFn(src, '_spSuggestionsHtml');
    expect(fn).toContain('_spApplySuggestion');
    expect(fn).toContain('onclick=');
  });

  /** ⚠ التطبيق يمر بـ _spToggleCode فيرث إبطال الـOTP — لا مسار ثانٍ. */
  it('التطبيق يمر بمسار تبديل الكود نفسه', () => {
    expect(extractFn(src, '_spApplySuggestion')).toContain('_spToggleCode');
  });

  it('التطبيق يُرفض على أوردر غير معلق', () => {
    expect(extractFn(src, '_spApplySuggestion')).toContain('_spIsEditable');
  });

  /**
   * ⚠ تلميح لا تحذير: الأصناف غير المطابَقة حالة طبيعية في أوردرات شوبيفاي، والرسالة
   *   تعرض فرصة (عروض أكثر) لا عطلاً. الكهرماني و⚠️ كانا يقولان «حدث خطأ»، فيقرأها
   *   الموظف كمشكلة يجب حلّها قبل المتابعة.
   */
  it('رسالة غير المطابَق تلميح لا تحذير', () => {
    const fn = extractFn(src, '_spSuggestionsHtml');
    expect(fn).toContain('spSuggUnmatched');
    expect(fn).toContain('sp-sugg-hint');
    expect(fn).not.toContain('sp-sugg-warn');
    expect(extractFn(src, '_spUnmatchedCount')).toContain('!i.productId');
  });

  it('لا لوحة تحذير كهرمانية ولا رمز خطر في النص', () => {
    expect(src).not.toMatch(/\.sp-sugg-warn\{/);
    const m = src.match(/spSuggUnmatched:\{ar:'([^']*)',en:'([^']*)'/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toContain('⚠');
    expect(m![2]).not.toContain('⚠');
  });

  /** النمط محايد: خلفية اللوح العادية وحدّه، والأيقونة إعلامية بلون العلامة. */
  it('نمط التلميح محايد لا تنبيهي', () => {
    expect(src).toMatch(/\.sp-sugg-hint\{[^}]*background:var\(--bg-alt\)/);
    expect(src).toMatch(/\.sp-sugg-hint svg\{[^}]*color:var\(--accent\)/);
  });

  it('لا يرسم كتلة فارغة حين لا اقتراح ولا تنبيه', () => {
    expect(extractFn(src, '_spSuggestionsHtml')).toContain("return ''");
  });

  it('اللوحة مركّبة داخل تبويب الخصم', () => {
    expect(extractFn(src, '_spRenderDiscountTab')).toContain('_spSuggestionsHtml(editable)');
  });
});


/**
 * نافذة التعليقات المستقلة — الوصول في خطوة واحدة من صف الأوردر.
 */
describe('Shopify order edit — نافذة التعليقات المستقلة', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  /**
   * ⚠ سياق منفصل عن _spEditOrder: النافذة تُفتح دون مودال التعديل، فربطها بحالته
   *   كان سيجعلها تفشل حين يكون مغلقاً — وهي الحالة الطبيعية الآن.
   */
  it('التعليقات لها سياقها الخاص لا حالة مودال التعديل', () => {
    expect(src).toContain('let _spCmtOrder = null');
    for (const fn of ['_spRenderCommentsTab', '_spAddComment', '_spStartEditComment',
                      '_spSaveCommentEdit', '_spDeleteComment']) {
      expect(extractFn(src, fn)).not.toContain('_spEditOrder');
    }
  });

  it('النافذة تُفتح بمعرّف الأوردر وحده وتتحقق من وجوده', () => {
    const fn = extractFn(src, 'openShopifyCommentsModal');
    expect(fn).toContain('_spOrderById(orderId)');
    expect(fn).toContain('spOrderNotFound');
    expect(fn).toContain('openModal(');
  });

  it('النافذة ترسم التعليقات في مضيفها الخاص', () => {
    expect(extractFn(src, 'openShopifyCommentsModal')).toContain('_spRenderCommentsTab()');
    expect(extractFn(src, '_spRenderCommentsTab')).toContain('#sp-cmt-host');
  });

  /** النافذة تُفتح للكتابة غالباً لا للقراءة. */
  it('التركيز يقع على حقل الكتابة عند الفتح', () => {
    expect(extractFn(src, 'openShopifyCommentsModal')).toContain('focus()');
  });

  /**
   * ⚠ الأيقونة تُرسم على كل صف؛ الفرق بين «فيه تعليق» و«مفيش» صار في الوضوح لا في
   *   الوجود. إظهارها على بعض الصفوف فقط كان يزحزح «تأكيد الطلب» في تلك الصفوف
   *   وحدها فيبدو العمود مكسوراً رأسياً — وهو ما دفع إلى الباهت بدل الإخفاء.
   */
  it('الأيقونة على كل صف، والفرق في الوضوح لا في الوجود', () => {
    const fn = extractFn(src, '_spCommentsBtnHtml');
    expect(fn).not.toContain("if (!n) return");   // لم يعد يُخفى
    expect(fn).toContain('has-cmt');              // الصنف هو ما يفرّق
    expect(fn).toContain('sp-cmt-slot');
  });

  /**
   * ⚠ الحالة تُشتق من العدد لا تُثبَّت: تثبيتها على true يجعل كل صف يعرض رقماً
   *   (صفراً) وصنف has-cmt، فيختفي الفرق البصري كله الذي بُني عليه التصميم.
   */
  it('الرقم وحالة has-cmt مشتقان من عدد التعليقات', () => {
    const fn = extractFn(src, '_spCommentsBtnHtml');
    expect(fn).toContain('const has = n > 0');
    expect(fn).toContain("has ? `<span class=\"sp-cmt-n\">");
    expect(fn).toContain("has ? ' has-cmt' : ''");
  });

  /**
   * ⚠ العدّاد داخل الزر لا شارة عائمة فوقه: الشارة تحتاج هامشاً حولها فترفع ارتفاع
   *   الصف، والزر يقف على خط واحد مع «تأكيد الأوردر».
   */
  it('العدّاد داخل الزر لا شارة مطلقة', () => {
    const fn = extractFn(src, '_spCommentsBtnHtml');
    expect(fn).toContain('o.comments');
    expect(fn).toContain('sp-cmt-n');
    expect(fn).not.toContain('sp-cmt-badge');
  });

  /**
   * ⚠ الخلية ضيقة: flex-wrap كان يدفع الزر إلى سطر فوق زر التأكيد بدل جانبه.
   *   الزر الآن داخل .sp-act-row نفسها وهي nowrap.
   */
  it('الزر على نفس خط زر التأكيد', () => {
    const cell = src.slice(src.indexOf('<td data-col="action">'));
    const row = cell.indexOf('sp-act-row');
    const btn = cell.indexOf('_spCommentsBtnHtml');
    const confirm = cell.indexOf('sp-confirm-btn');
    expect(row).toBeLessThan(btn);
    expect(btn).toBeLessThan(confirm);
    expect(src).toContain('gap:6px;flex-wrap:nowrap}');
  });

  /** ⚠ النقر على الزر يجب ألا يشغّل نقرة الصف نفسها. */
  it('زر الصف يوقف انتشار النقرة', () => {
    expect(extractFn(src, '_spCommentsBtnHtml')).toContain('event.stopPropagation()');
  });

  /**
   * ⚠ قائمة ⋮ تُرسم للأوردر المعلق غير الملغى فقط. وضع الزر داخلها وحدها كان يخفي
   *   التعليقات عن المؤكد والملغى — وهما أكثر ما يحتاج متابعة.
   */
  /**
   * ⚠ الزر مُلحق بكل فروع الحالة لا بفرع واحد: قائمة ⋮ تُرسم للمعلق غير الملغى فقط،
   *   فحصره فيها كان يخفي التعليقات عن المؤكد والملغى.
   */
  it('الزر متاح في كل فروع الحالة لا في المعلق وحده', () => {
    const cell = src.slice(src.indexOf('<td data-col="action">'), src.indexOf('<td data-col="source">'));
    // فرع المعلق + فرع الاسترجاع + الفرع الأخير
    expect((cell.match(/_spCommentsBtnHtml/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('الزر موجود في بطاقة الموبايل بكل فروع الحالة', () => {
    expect(src).toContain('const _cardCmtBtn = _spCommentsBtnHtml(o,');
    // أربعة فروع: طلب إلغاء / معلق / استرجاع / الباقي
    expect((src.match(/\$\{_cardCmtBtn\}/g) || []).length).toBe(4);
  });

  it('عنصر التعليقات موجود في قائمتي ⋮ معاً', () => {
    expect((src.match(/openShopifyCommentsModal\('\$\{o\._id\}'\)/g) || []).length).toBe(2);
  });

  /**
   * ⚠ إشعار المنشن يجب أن يفتح النافذة لا مودال التعديل: التبويب حُذف، فاستدعاؤه
   *   كان يفتح التعديل على الأصناف والتعليق المنادى عليه لا يظهر إطلاقاً.
   */
  it('المنشن يفتح النافذة المستقلة لا مودال التعديل', () => {
    const fn = extractFn(src, 'openShopifyOrderComments');
    expect(fn).toContain('openShopifyCommentsModal(orderId)');
    expect(fn).not.toContain("_spSetTab('comments')");
  });
});


/**
 * توحيد مصطلح تأكيد الطلب.
 *
 * زر الصف كان يقول «تأكيد الطلب» بينما شريط التحديد يقول «إرسال إلى سجل المعاملات»
 * لنفس الفعل تماماً — اسمان لشيء واحد على شاشة واحدة. الاسم موحَّد الآن، والمقصد
 * (الذهاب إلى سجل المعاملات) بقي في الـtitle حيث لا يزاحم اسم الفعل.
 */
describe('Shopify — مصطلح تأكيد الطلب موحَّد', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  function tkey(name: string): { ar: string; en: string } {
    const m = src.match(new RegExp('\\n\\s*' + name + ":\\{ar:'([^']*)',en:'([^']*)'"));
    if (!m) throw new Error('مفتاح غير موجود: ' + name);
    return { ar: m[1], en: m[2] };
  }

  it('الزر القصير والطويل يحملان النص نفسه', () => {
    expect(tkey('spSendToTransactionsLong')).toEqual(tkey('spSendToTransactions'));
  });

  it('لا يظهر «إرسال» على أي زر فعل', () => {
    for (const k of ['spSendToTransactions', 'spSendToTransactionsLong', 'spBulkConfirmBtn']) {
      expect(tkey(k).ar).not.toContain('إرسال');
      expect(tkey(k).en.toLowerCase()).not.toContain('send');
    }
  });

  it('شريط التحديد يصرّف الجمع', () => {
    expect(tkey('spBulkConfirm').ar).not.toBe(tkey('spSendToTransactionsLong').ar);
  });

  /**
   * ⚠ شريطان مختلفان بمجموعتَي تحديد مختلفتين: شوبيفاي على `_shopifySelectedIds`
   *   وتجهيز الطلبات على `_dpReadySelectedIds`. قراءة أحدهما لمجموعة الآخر تجعل
   *   صيغة المفرد/الجمع تتبع عدداً لا علاقة له بما هو محدَّد على الشاشة.
   */
  it('كل شريط يصرّف على مجموعة تحديده هو', () => {
    const lines = src.split('\n');
    const sp = lines.find(l => l.includes("_shopifySelectedIds.size === 1 ? t('spSendToTransactionsLong')"));
    const dp = lines.find(l => l.includes("_dpReadySelectedIds.size === 1 ? t('spSendToTransactionsLong')"));
    expect(sp).toBeDefined();
    expect(dp).toBeDefined();
    expect(sp).not.toContain('_dpReadySelectedIds');
    expect(dp).not.toContain('_shopifySelectedIds');
  });

  it('المقصد يبقى في الـtitle لا على الزر', () => {
    expect(tkey('spSendToTransactionsTitle').ar).toContain('سجل المعاملات');
  });
});


/**
 * ⚠ زر التعليقات وعدّاده يُبنيان وقت رسم الصف. حفظ تعليق كان يعيد رسم النافذة وحدها،
 *   فيبقى الصف على حالته السابقة: لا أيقونة بعد أول تعليق، ورقم قديم بعد كل إضافة أو
 *   حذف — البيانات صحيحة والشاشة تكذبها حتى أول تنقّل.
 */
describe('Shopify — صف الأوردر يتحدث بعد تغيّر التعليقات', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  it('مسار الحفظ المشترك يعيد رسم الصف', () => {
    expect(extractFn(src, '_spPersistComments')).toContain('_spRefreshOrderRow()');
  });

  /** الإضافة والتعديل والحذف تمر كلها بـ_spPersistComments، فمكان واحد يكفي. */
  it('الثلاث عمليات تمر بمسار الحفظ نفسه', () => {
    for (const fn of ['_spAddComment', '_spSaveCommentEdit', '_spDeleteComment']) {
      expect(extractFn(src, fn)).toContain('_spPersistComments');
    }
  });

  /**
   * ⚠ لا إعادة جلب من الخادم: التعليقات محفوظة والمصفوفة محدَّثة، وطلب شبكة هنا يعيد
   *   ضبط الصفحة والفرز والفلاتر التي يقف عليها الموظف.
   */
  it('يعيد الرسم فقط ولا يعيد الجلب', () => {
    const fn = extractFn(src, '_spRefreshOrderRow');
    expect(fn).toContain('renderShopifyOrders()');
    expect(fn).not.toContain('loadShopifyOrders');
  });

  it('لا يعيد الرسم خارج صفحة الأوردرات', () => {
    expect(extractFn(src, '_spRefreshOrderRow')).toContain("currentPage === 'shopify-orders'");
  });

  /** فشل الرسم يجب ألا يُسقط عملية حفظ نجحت بالفعل. */
  it('فشل إعادة الرسم لا يُسقط الحفظ', () => {
    expect(extractFn(src, '_spRefreshOrderRow')).toContain('catch');
  });
});


/**
 * تناسق عمود الإجراءات وشكل فقاعة التعليق.
 */
describe('Shopify — تناسق العمود وشكل التعليق', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  /**
   * ⚠ عمود الإجراءات عرضه ثابت (148px). إظهار زر التعليقات على بعض الصفوف دون غيرها
   *   كان يزحزح «تأكيد الطلب» في تلك الصفوف وحدها، فيبدو العمود مكسوراً رأسياً.
   *   الخانة تُحجز على كل صف ويختفي محتواها وحده.
   */
  it('الخانة محجوزة والأيقونة حاضرة على كل صف', () => {
    const fn = extractFn(src, '_spCommentsBtnHtml');
    expect(fn).toContain('sp-cmt-slot');
    expect(fn).not.toContain("if (!n) return");
  });

  /** ⚠ الباهت يجب أن يُرفع على اللمس: لا هوفر هناك فيبقى باهتاً للأبد. */
  it('الأيقونة الباهتة مرفوعة على أجهزة اللمس', () => {
    expect(src).toMatch(/@media \(hover:none\)\{\.sp-cmt-open\{opacity:\.55\}/);
  });

  it('الخانة ثابتة العرض في الأنماط', () => {
    expect(src).toMatch(/\.sp-cmt-slot\{[^}]*width:44px/);
  });

  /**
   * ⚠ الصنف مشترك بين تعليقات الفاتورة ونموذج المعاملة وأوردر شوبيفاي — تعليق واحد
   *   بشكل واحد أينما ظهر.
   */
  it('فقاعة التعليق معرَّفة كصندوق لا نص عائم', () => {
    const bubble = (src.match(/\.tx-cmt-text\{[\s\S]*?\}/) || [''])[0];
    expect(bubble).toContain('background:var(--bg-alt)');
    expect(bubble).toContain('border:1px solid var(--border)');
    expect(bubble).toContain('border-radius:12px');
    expect(bubble).toContain('display:inline-block');
  });

  /** ⚠ خصائص منطقية لا يسار/يمين: الصفحة تنقلب مع اللغة والفقاعة تتبعها. */
  it('الزاوية المدبَّبة منطقية الاتجاه', () => {
    const bubble = (src.match(/\.tx-cmt-text\{[\s\S]*?\}/) || [''])[0];
    expect(bubble).toContain('border-start-start-radius');
    expect(bubble).not.toContain('border-top-left-radius');
  });

  it('للفقاعة نسخة في الوضع الداكن', () => {
    expect(src).toMatch(/body\.dark-mode \.tx-cmt-text\{/);
  });

  it('الأنظمة الثلاثة ترسم بنفس الصنف', () => {
    expect((src.match(/class="tx-cmt-text"/g) || []).length).toBe(3);
  });

  /**
   * ⚠ قاعدة واحدة فقط: نسختان متعارضتان تجعل الأخيرة تفوز صامتة، فيُحشر حقل التعديل
   *   داخل فقاعة ضيقة. و:has() غير مضمونة الدعم فلا يُعتمد عليها هنا.
   */
  it('حقل التعديل يلغي حشو الفقاعة بقاعدة واحدة', () => {
    const rules = src.match(/\.tx-cmt-edit-row\{[^}]*\}/g) || [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('margin:-8px -11px');
    expect(src).not.toMatch(/\.tx-cmt-text:has\(/);
  });
});


/**
 * نجمة التمييز.
 *
 * علامة بصرية بحتة: لا تغيّر حالة ولا أولوية ولا تدخل أي تقرير، ولذلك يضعها ويرفعها
 * أي مستخدم بلا صلاحية ولا موافقة. جعلها حقلاً ذا معنى لاحقاً قرار منفصل.
 */
describe('Shopify — نجمة تمييز الأوردر', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  it('النجمة بجانب رقم الطلب في الجدول والبطاقة', () => {
    expect(src).toMatch(/data-col="ref">\$\{_spStarHtml\(o\)\}/);
    expect(src).toMatch(/class="sp-card-ref">\$\{_spStarHtml\(o\)\}/);
  });

  it('متاحة أيضاً من خيارات الطلب في القائمتين', () => {
    expect((src.match(/onclick="_spToggleStar\('\$\{o\._id\}'\)"/g) || []).length).toBe(2);
  });

  /** ⚠ بلا صلاحية: النجمة ليست قراراً إدارياً. */
  it('لا حارس صلاحيات على التبديل', () => {
    const fn = extractFn(src, '_spToggleStar');
    expect(fn).not.toMatch(/isAdmin\(\)|hasPerm\(/);
  });

  /**
   * ⚠ الحالة تُقلب محلياً قبل الشبكة: النجمة فعل لحظي، وانتظار الرد قبل إظهار أثرها
   *   يجعلها تبدو معطّلة على اتصال بطيء — وتُرجَع عند الفشل فلا تبقى نجمة لم تُحفظ.
   */
  it('تقلب محلياً ثم ترجع عند الفشل', () => {
    const fn = extractFn(src, '_spToggleStar');
    expect(fn).toContain('o.starred = !prev');
    expect(fn).toContain('o.starred = prev');
    expect(fn.indexOf('o.starred = !prev')).toBeLessThan(fn.indexOf('await api('));
  });

  it('تعيد رسم الصف فور التبديل', () => {
    expect(extractFn(src, '_spToggleStar')).toContain('_spRefreshOrderRow()');
  });

  it('المفعَّلة مملوءة والمطفأة مفرَّغة', () => {
    const fn = extractFn(src, '_spStarHtml');
    expect(fn).toContain("fill=\"${on ? 'currentColor' : 'none'}\"");
  });

  it('تحمل aria-pressed وتوقف انتشار النقرة', () => {
    const fn = extractFn(src, '_spStarHtml');
    expect(fn).toContain('aria-pressed');
    expect(fn).toContain('event.stopPropagation()');
  });

  /** المميَّزة ظاهرة دائماً — وهذا هو الغرض كله؛ غير المميَّزة تظهر بالمرور فقط. */
  it('المميَّزة ظاهرة دائماً وغيرها بالمرور', () => {
    expect(src).toMatch(/\.sp-star\{[^}]*opacity:0/);
    expect(src).toMatch(/\.sp-star\.is-on\{[^}]*opacity:1/);
    expect(src).toMatch(/tr:hover \.sp-star/);
  });

  /** ⚠ خصائص منطقية: الصفحة تنقلب مع اللغة والنجمة تتبع رقم الطلب. */
  it('الهامش منطقي لا يسار/يمين', () => {
    expect(src).toMatch(/\.sp-star\{[^}]*margin-inline-end/);
    expect(src).not.toMatch(/\.sp-star\{[^}]*margin-right/);
  });
});


/**
 * الخصم الإضافي عبر السلسلة كلها: الأوردر → نافذة التأكيد → الحركة → الفاتورة.
 */
describe('Shopify — الخصم الإضافي يظهر ويُحسب في كل مكان', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
  const be = fs.readFileSync(
    path.resolve(__dirname, '../../src/shopify/shopify.service.ts'), 'utf8');

  /**
   * ⚠ كانت نافذة التأكيد تعرض `order.discount` وحده (خصم شوبيفاي)، فالموظف يؤكّد
   *   على إجمالي لا يفسّره ما يراه: الإجمالي منخفض والسبب غير معروض.
   */
  it('نافذة التأكيد تعرض الخصومات الثلاثة كسطور مستقلة', () => {
    // ⚠ يُقتطع من صف الإجمالي إلى الوراء: مفتاح spApproveClient يظهر أولاً في جدول
    //   الترجمات لا في المودال، فالاقتطاع من أول ظهور له كان يقيس الكتلة الخطأ.
    const iTotal = src.indexOf('<div class="spd-row spd-row-total">');
    expect(iTotal).toBeGreaterThan(-1);
    const dlg = src.slice(iTotal - 1800, iTotal + 200);
    expect(dlg).toContain('spApproveDiscount');   // خصم شوبيفاي
    expect(dlg).toContain('spDiscCodes');         // خصم الأكواد
    expect(dlg).toContain('spDiscManual');        // الخصم اليدوي
    expect(dlg).toContain('fmtJ(order.total)');   // الإجمالي بعدها كلها
  });

  it('إجمالي النافذة يقرأ order.total المحسوب بالخصومات كلها', () => {
    const dlg = src.slice(src.indexOf("t('spApproveTotal')"), src.indexOf("t('spApproveTotal')") + 220);
    expect(dlg).toMatch(/fmtJ\(order\.total\)/);
  });

  /**
   * ⚠ كانت هذه الحالة تثبّت الصيغة القديمة (خصم شوبيفاي + الأكواد فقط)، أي أنها
   *   تقفل العيب نفسه: الخصم اليدوي لا يصل `tx.discount`، فيقلّ ما يُبلغ عنه
   *   `totalDiscounts` في لوحة التحكم والتقارير، وتعرض الفاتورة إجمالياً صحيحاً
   *   بجانب خصمٍ أقلّ منه. `tx.discount` هو **إجمالي** الخصم — نفس ما يحفظه نموذج
   *   سجل المعاملات عبر `_syncDiscountFromCodes`.
   */
  it('الترحيل إلى الحركة يجمع الخصومات الثلاثة في tx.discount', () => {
    const i = be.indexOf('const tx = await this.txModel.create(');
    const block = be.slice(i, i + 2600);
    const line = block.slice(block.indexOf('discount: Math.min('), block.indexOf('manualDiscount:'));
    expect(line).toContain('order.discount');
    expect(line).toContain('order.codesDiscount');
    expect(line).toContain('order.manualDiscount');
    // ⚠ يُقصّ كمجموعة واحدة تماماً كـcomputeShopifyOrderTotal الذي حسب order.total
    expect(line).toContain('order.itemsTotal');
    // يبقى مخزَّناً كتفصيل للمراجعة
    expect(block).toMatch(/manualDiscount: Number\(order\.manualDiscount\) \|\| 0/);
    expect(block).toMatch(/total: order\.total/);
  });

  it('الفاتورة تعرض الخصم اليدوي ولا تُخفي بطاقته', () => {
    const i = src.indexOf('const _manualDisc = Number(tx.manualDiscount)');
    const inv = src.slice(i, i + 1800);
    expect(inv).toContain('ivManualDiscount');
    expect(inv).toMatch(/if \(!_codeNames\.length && !\(_manualDisc > 0\) && !\(_disc > 0\)\) return ''/);
  });

  it('تصدير الأرشيف يجمع الخصمين', () => {
    expect(src).toMatch(/_xpNum\(tx\.discount\) \+ _xpNum\(tx\.manualDiscount\)/);
  });

  /**
   * ⚠ الحقل كان يُفرَّغ عند كل إعادة رسم، فيبدو الخصم المحفوظ وكأنه لم يُطبَّق.
   * ⚠ ولا تُعرض القيمة المحفوظة في وضع النسبة: المحفوظ جنيهات، فيُقرأ 200 على أنه 200%.
   */
  it('حقل الخصم يحتفظ بالقيمة', () => {
    const fn = extractFn(src, '_spDiscInputValue');
    expect(fn).toContain("qs('#sp-disc-value')");
    expect(fn).toContain('order.manualDiscount');
    expect(fn).toContain("_spDiscType === 'fixed'");
  });

  it('زر الحفظ يعطي تأكيداً لحظياً ثم يعود', () => {
    const fn = extractFn(src, '_spDiscFlashSaved');
    expect(fn).toContain('spDiscSavedBtn');
    expect(fn).toContain('clearTimeout(_spDiscSavedTimer)');
    expect(fn).toContain('spDiscApply');
  });

  it('الحفظ يومض ويحدّث الصف بلا إعادة جلب', () => {
    const fn = extractFn(src, '_spPersistDiscount');
    expect(fn).toContain('_spDiscFlashSaved()');
    expect(fn).toContain('_spRefreshOrderRow()');
    expect(fn).not.toContain('loadShopifyOrders');
  });
});


/**
 * دمج تبويبي الأصناف والخصم، وتوحيد شكل بطاقة الاقتراح مع سجل المعاملات.
 */
describe('Shopify — الأصناف والخصم لوحة واحدة', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
  const mi = src.indexOf("modal.id = 'shopify-edit-modal'");
  const modal = src.slice(mi, mi + 9000);

  /** ⚠ البحث نقطة البداية؛ أسفل قائمة قد تطول كان يخرج من الرؤية كلما كبر الأوردر. */
  it('الترتيب: بحث ثم أصناف ثم خصم', () => {
    const iSearch = modal.indexOf('shopify-edit-search');
    const iItems = modal.indexOf('id="shopify-edit-items"');
    const iDisc = modal.indexOf('id="sp-pane-discount"');
    expect(iSearch).toBeGreaterThan(-1);
    expect(iSearch).toBeLessThan(iItems);
    expect(iItems).toBeLessThan(iDisc);
  });

  /** ⚠ ماسح واحد لا اثنان متداخلان. */
  it('الأصناف والخصم داخل ماسح واحد', () => {
    expect(modal).toContain('sp-items-scroll');
    expect(src).toMatch(/\.sp-items-scroll\{flex:1;overflow-y:auto/);
  });

  /**
   * ⚠ الاقتراح يجب أن يظهر لحظة اكتمال شروط الباقة: قيمة الخصم وسقفه ومطابقة
   *   الباقات كلها مشتقّة من الأصناف، فترك الخصم على حاله يعرض ما لا يخص السلة.
   */
  it('كل تغيّر في الأصناف يعيد رسم الخصم', () => {
    expect(extractFn(src, '_renderShopifyEditItems')).toContain('_spRenderDiscountTab()');
    for (const fn of ['_shopifyEditAddFromPicker', '_shopifyEditRemoveItem', '_shopifyEditQty']) {
      expect(extractFn(src, fn)).toContain('_renderShopifyEditItems()');
    }
  });

  /**
   * ⚠ نفس أصناف `.dsb-*` التي يستعملها بانر سجل المعاملات لا نسخة ثانية: الموظف
   *   الذي تعوّد الشكل هناك يقرأه هنا بلا تعلّم جديد.
   */
  it('البطاقة تستعمل أصناف بانر سجل المعاملات', () => {
    const fn = extractFn(src, '_spSuggestionsHtml');
    for (const cls of ['dsb-wrap', 'dsb-header', 'dsb-cards', 'dsb-card-code',
                       'dsb-card-amt', 'dsb-card-apply-hint', 'dsb-applied-chip']) {
      expect(fn).toContain(cls);
    }
  });

  it('الأنماط القديمة الخاصة حُذفت لا تُركت ميتة', () => {
    expect(src).not.toMatch(/\.sp-sugg-card\{/);
    expect(src).not.toMatch(/\.sp-sugg-btn\{/);
  });

  it('الباقة الناقصة تُظهر نسبة الاكتمال ولا تُطبَّق بالنقر', () => {
    const fn = extractFn(src, '_spSuggestionsHtml');
    expect(fn).toContain('dsb-card-partial-fill');
    expect(fn).toMatch(/toast\(\$\{JSON\.stringify/);
  });

  /** ⚠ عرض المودال 660px يضغط الشبكة، فتُمرَّر أفقياً بدل أن تنكمش البطاقات. */
  it('البطاقات تُمرَّر أفقياً داخل المودال', () => {
    expect(src).toMatch(/#sp-pane-discount \.dsb-cards\{overflow-x:auto/);
  });
});


/**
 * سلامة بنية جسم الصفحة.
 *
 * ⚠ وسم <div> مفتوح بلا إغلاق لا يُنتج أي خطأ JavaScript: المتصفح يصلح الشجرة
 *   بنفسه فيضم كل ما بعده داخل العنصر المفتوح. حين يكون ذلك العنصر مودالاً
 *   `display:none`، تصبح كل الصفحات التالية له داخل أب مخفي — فتظهر بيضاء تماماً
 *   بينما `currentPage` صحيح و`.page.active` مضبوطة و`display:block` محسوبة.
 *
 *   حدث هذا فعلاً: `#pu-card-orders-modal` فقد `</div>` واحداً، فسقطت صفحتا
 *   «أوردرات شوبيفاي» و«الفاتورة» بلا رسالة واحدة في الكونسول. الفحص الساكن هو
 *   الطريقة الوحيدة لالتقاطه — لا اختبار وحدة يراه، ولا محلل JS يشتكي منه.
 */
describe('index.html — جسم الصفحة متوازن', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');

  /** يوازن <div> داخل نطاق نصي، متجاهلاً ما بداخل التعليقات. */
  function divBalance(text: string): number {
    const clean = text.replace(/<!--[\s\S]*?-->/g, '');
    const open = (clean.match(/<div\b/g) || []).length;
    const close = (clean.match(/<\/div>/g) || []).length;
    return open - close;
  }

  /**
   * ⚠ المودالات ذات `display:none` هي الخطرة تحديداً: أي عنصر بعد واحد منها في
   *   الملف يصير داخله إن فقد إغلاقه، فيرثه مخفياً. نفحص الحاويات الفعلية فقط
   *   (`class="modal-overlay"`) لا كل عنصر يحمل كلمة modal في معرّفه.
   */
  it('كل حاوية modal-overlay ثابتة متوازنة', () => {
    const lines = src.split('\n');
    const bodyAt = lines.findIndex(l => l.includes('<body'));
    expect(bodyAt).toBeGreaterThan(-1);

    const modals: Array<{ id: string; line: number }> = [];
    for (let i = bodyAt; i < lines.length; i++) {
      const l = lines[i];
      if (!l.includes('class="modal-overlay"')) continue;
      const m = l.match(/<div\s+id="([^"]+)"/);
      if (m) modals.push({ id: m[1], line: i });
    }
    expect(modals.length).toBeGreaterThan(2);

    const broken: string[] = [];
    for (const { id, line } of modals) {
      let depth = 0, closed = false;
      for (let k = line; k < Math.min(line + 400, lines.length); k++) {
        depth += divBalance(lines[k]);
        if (depth === 0 && k > line) { closed = true; break; }
        if (depth < 0) break;
      }
      if (!closed) broken.push(`${id} (سطر ${line + 1})`);
    }
    expect(broken).toEqual([]);
  });

  /**
   * ⚠ مودال طلبات البطاقة تحديداً: هو الذي كسر الصفحتين، ويقع قبلهما في الملف
   *   فيبتلعهما إن فقد إغلاقه.
   */
  it('مودال طلبات البطاقة يغلق نفسه', () => {
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.includes('id="pu-card-orders-modal"'));
    expect(start).toBeGreaterThan(-1);

    let depth = 0, closedAt = -1;
    for (let k = start; k < Math.min(start + 300, lines.length); k++) {
      depth += divBalance(lines[k]);
      if (depth === 0 && k > start) { closedAt = k; break; }
    }
    expect(closedAt).toBeGreaterThan(start);
  });
});
