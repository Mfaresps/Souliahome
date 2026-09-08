/**
 * نقاط الموظف: المكافأة والخصم لازم يوصلوا مفصولين وبأسبابهم.
 *
 * كارت «نقاطي» كان بيعرض `points.total` بس — رقم واحد. التعديلات اليدوية
 * (`manual_bonus`) كانت بتترجع كـ`bonus` **بالصافي**، فمكافأة +١٠٠ وخصم −٤٠ في
 * نفس الشهر بيبقوا `60`: رقم لا هو مكافأة ولا خصم، والموظف يقراه إنه اداله ٦٠
 * وهو في الحقيقة اتخصم منه ٤٠ كمان. وسبب التعديل — اللي المدير مجبَر يكتبه في
 * الـDTO — ماكانش بيخرج من الـAPI أصلاً، فنقاط بتتحرّك من غير تفسير بتتقرا
 * كعُطل في النظام مش كقرار إداري.
 *
 * الاختبار ده بيشغّل `getMyWorkspace` الحقيقية على `logModel` متزيَّف بيطبّق
 * منطق التجميع بنفسه، فلو الـ`$cond` اتشال أو رجع للصافي بيسقط.
 *
 * Run with: npm test -- my-points-adjustments
 */

// ⚠ يجعل الملف موديولاً بنطاقه الخاص — نفس سبب `export {}` في الملفات الشقيقة:
// دوال المساعدة ذات الأسماء المشتركة تتصادم كـTS2393 فلا يعمل أي منهما.
export {};

function ScoringServiceClass(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/employee-performance/employee-scoring.service').EmployeeScoringService;
}

type Row = { _id: string; actionType: string; points: number; note?: string; meta?: any; createdAt?: Date };

/**
 * `logModel` متزيَّف بينفّذ `$group`/`$cond` بتوع الخدمة على صفوف حقيقية.
 *
 * ⚠ بينفّذ التعبير اللي الخدمة بعتته فعلاً، مش بيرجّع أرقام محفوظة. لو حد شال
 * فرع `bonusTotal` من الـaggregation، المفتاح هيختفي من النتيجة والاختبار
 * يسقط — وده بالظبط الغرض. قايمة راجعة ثابتة كانت هتعدّي على أي تغيير.
 */
function logModelFor(rows: Row[]) {
  const evalExpr = (expr: any, doc: Row): any => {
    if (typeof expr === 'string' && expr.startsWith('$')) return (doc as any)[expr.slice(1)];
    if (expr === null || typeof expr !== 'object') return expr;
    if ('$sum' in expr) return evalExpr(expr.$sum, doc);
    if ('$cond' in expr) return evalExpr(expr.$cond[0], doc) ? evalExpr(expr.$cond[1], doc) : evalExpr(expr.$cond[2], doc);
    if ('$eq' in expr) return evalExpr(expr.$eq[0], doc) === evalExpr(expr.$eq[1], doc);
    if ('$gt' in expr) return evalExpr(expr.$gt[0], doc) > evalExpr(expr.$gt[1], doc);
    if ('$lt' in expr) return evalExpr(expr.$lt[0], doc) < evalExpr(expr.$lt[1], doc);
    if ('$and' in expr) return expr.$and.every((e: any) => evalExpr(e, doc));
    return expr;
  };

  return {
    aggregate: jest.fn().mockImplementation(async (pipeline: any[]) => {
      const group = pipeline.find((s) => s.$group);
      if (!group) return [];
      const acc: Record<string, number> = {};
      for (const [key, expr] of Object.entries(group.$group)) {
        if (key === '_id') continue;
        acc[key] = rows.reduce((sum, r) => sum + (Number(evalExpr(expr, r)) || 0), 0);
      }
      return [{ _id: null, ...acc }];
    }),
    find: jest.fn().mockImplementation((q: any) => {
      const matched = q.actionType
        ? rows.filter((r) => r.actionType === q.actionType)
        : rows.slice();
      return {
        select: () => ({
          sort: () => ({
            limit: (n: number) => ({
              lean: () => ({ exec: async () => matched.slice(0, n) }),
            }),
          }),
        }),
      };
    }),
    countDocuments: jest.fn().mockImplementation(async (q: any) =>
      q?.actionType ? rows.filter((r) => r.actionType === q.actionType).length : rows.length,
    ),
  };
}

function emptyFind() {
  return {
    find: jest.fn().mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }),
    }),
    countDocuments: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue([]),
  };
}

async function workspaceFor(rows: Row[]) {
  const svc = Object.create(ScoringServiceClass().prototype);
  svc.logModel = logModelFor(rows);
  svc.shopifyOrderModel = emptyFind();
  svc.followUpModel = emptyFind();
  svc.txModel = emptyFind();
  return svc.getMyWorkspace('u1', 'month');
}

const bonus = (points: number, note: string, by = 'admin'): Row => ({
  _id: 'b' + points + note,
  actionType: 'manual_bonus',
  points,
  note,
  meta: { adjustedBy: by },
  createdAt: new Date('2026-09-05T10:00:00Z'),
});

const earned = (points: number): Row => ({
  _id: 'e' + points,
  actionType: 'deposit_full',
  points,
  createdAt: new Date('2026-09-04T10:00:00Z'),
});

describe('getMyWorkspace — المكافأة والخصم مفصولين وبأسبابهم', () => {
  it('يفصل المكافأة عن الخصم بدل الصافي', async () => {
    // ⚠ الحالة اللي الرقم الصافي بيخفيها: +100 و−40 بيدّوا bonus=60.
    const w: any = await workspaceFor([earned(20), bonus(100, 'أداء ممتاز'), bonus(-40, 'تأخير')]);

    expect(w.points.bonusTotal).toBe(100);
    expect(w.points.penaltyTotal).toBe(40);   // مقدار موجب، مش −40
    expect(w.points.bonus).toBe(60);          // الصافي لسه موجود للتوافق
    expect(w.points.earned).toBe(20);
    expect(w.points.total).toBe(80);          // 20 + 60
  });

  it('يرجّع سبب كل تعديل ومين عمله', async () => {
    const w: any = await workspaceFor([bonus(100, 'أداء ممتاز', 'ahmed'), bonus(-40, 'تأخير', 'sara')]);

    expect(w.adjustments).toHaveLength(2);
    const reasons = w.adjustments.map((a: any) => a.reason);
    expect(reasons).toContain('أداء ممتاز');
    expect(reasons).toContain('تأخير');

    const penalty = w.adjustments.find((a: any) => a.points < 0);
    expect(penalty.reason).toBe('تأخير');
    expect(penalty.by).toBe('sara');
    expect(penalty.createdAt).toBeTruthy();
  });

  it('يستبعد النقاط المكتسبة من قائمة التعديلات', async () => {
    // صفوف التسجيل التلقائي مش تعديلات يدوية — لو دخلت القايمة هتتعرض
    // كأن مدير زوّد نقاط، وهي نقاط الموظف من شغله.
    const w: any = await workspaceFor([earned(20), earned(15), bonus(50, 'مكافأة')]);

    expect(w.adjustments).toHaveLength(1);
    expect(w.adjustments[0].points).toBe(50);
  });

  it('صفر تعديلات = قائمة فاضية لا مفاتيح ناقصة', async () => {
    // ⚠ الواجهة بتقرا `bonusTotal`/`penaltyTotal` من غير حارس، فلازم يكونوا
    // أرقام دايماً — `undefined` كان هيطبع NaN في الكارت.
    const w: any = await workspaceFor([earned(20)]);

    expect(w.points.bonusTotal).toBe(0);
    expect(w.points.penaltyTotal).toBe(0);
    expect(w.adjustments).toEqual([]);
    expect(w.adjustmentsTruncated).toBe(false);
  });

  it('خصم فقط بدون أي مكافأة', async () => {
    const w: any = await workspaceFor([earned(100), bonus(-30, 'غياب')]);

    expect(w.points.bonusTotal).toBe(0);
    expect(w.points.penaltyTotal).toBe(30);
    expect(w.points.total).toBe(70);
  });
});
