/**
 * تعديل عنوان أوردر شوبيفاي بعد إرسال الشحنة إلى Bosta.
 *
 * `handleOrderUpdate` كان يكتب العنوان الجديد فوق القديم على الحركة دون قيد — حتى على حركة
 * سُلّمت بالفعل إلى Bosta. النتيجة: النظام يعرض عنواناً والشحنة ذاهبة إلى آخر، ولا شيء في
 * الشاشة يشير إلى الاختلاف. وهذا مسار ساخن: 92 orders/updated مقابل 24 orders/create في اللوج.
 *
 * Bosta لا تسمح بتعديل عنوان شحنة قائمة (POST /deliveries و PUT :id/terminate فقط)، فالقاعدة
 * هي: قبل الشحن نحدّث، بعد الشحن نسجّل التعارض ونُبقي العنوان المشحون كما هو.
 *
 * تُستدعى الميثود مقابل stubs بدل بناء DI graph كامل — نفس أسلوب shopify-cancel-approval.
 *
 * Run with: npm test -- shopify-address-conflict
 */

// ⚠ يجعل الملف موديولاً بنطاقه الخاص. بدونه تتصادم دوال المساعدة ذات الأسماء
// المشتركة مع ملف الاختبار الشقيق (TS2393) ولا يعمل أي منهما.
export {};

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({
  EmployeeScoringService: class {},
}));

function ShopifyServiceClass(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/shopify/shopify.service').ShopifyService;
}

function buildOrder(overrides: Record<string, unknown> = {}): any {
  const o: any = {
    _id: 'o1',
    ref: '2450',
    shopifyId: '111',
    status: 'confirmed',
    notes: '',
    tags: '',
    shippingAddress: 'شارع الجلاء 12',
    shippingCity: 'Gharbia',
    shippingBostaCity: 'Gharbia',
    shippingGov: 'الغربية',
    financialStatus: 'paid',
    items: [],
    ...overrides,
  };
  o.save = jest.fn().mockImplementation(async () => o);
  return o;
}

/** Shopify webhook payload with a shipping address. */
function payload(address1: string, province = 'Gharbia'): any {
  return {
    id: 111,
    note: '',
    tags: '',
    financial_status: 'paid',
    line_items: [],
    shipping_lines: [{ price: '50' }],
    total_discounts: '0',
    shipping_address: { address1, province, city: province },
  };
}

/**
 * `tx` is what the transaction lookup returns (null = no linked transaction).
 * Captures the `$set` the service writes so the assertions read the real payload.
 */
function serviceFor(order: any, tx: any) {
  const updateOne = jest.fn().mockResolvedValue({});
  const svc = Object.create(ShopifyServiceClass().prototype);
  svc.shopifyOrderModel = { findOne: jest.fn().mockResolvedValue(order) };
  svc.txModel = {
    updateOne,
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(tx) }),
    }),
  };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.employeeScoringService = { scoreDepositDetection: jest.fn().mockResolvedValue(undefined) };
  svc.presence = { emitEvent: jest.fn() };
  return { svc, updateOne };
}

const setOf = (updateOne: jest.Mock) => updateOne.mock.calls[0][1].$set;

describe('handleOrderUpdate — تعديل العنوان بعد الشحن', () => {
  it('يحدّث العنوان عادةً عندما لا تكون الشحنة قد أُرسلت إلى Bosta', async () => {
    const order = buildOrder();
    const { svc, updateOne } = serviceFor(order, {
      bostaOrderId: '',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    const res = await svc.handleOrderUpdate(payload('شارع البحر 90'));

    expect(res.updated).toBe(true);
    const $set = setOf(updateOne);
    expect($set.shippingAddress).toBe('شارع البحر 90');
    expect($set.addressChangeConflict).toBeUndefined();
  });

  it('لا يكتب فوق العنوان بعد الشحن — يسجّل التعارض بدلاً منه', async () => {
    const order = buildOrder();
    const { svc, updateOne } = serviceFor(order, {
      bostaOrderId: 'B-77',
      bostaStatus: 'PICKED_UP',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    await svc.handleOrderUpdate(payload('شارع البحر 90', 'Cairo'));

    const $set = setOf(updateOne);
    // القاعدة الأساسية: العنوان المشحون يبقى كما هو
    expect($set.shippingAddress).toBeUndefined();
    expect($set.shippingCity).toBeUndefined();
    expect($set.shippingBostaCity).toBeUndefined();

    expect($set.addressChangeConflict).toMatchObject({
      oldAddress: 'شارع الجلاء 12',
      newAddress: 'شارع البحر 90',
      oldCity: 'Gharbia',
      newCity: 'Cairo',
      bostaStatus: 'PICKED_UP',
      resolved: false,
    });
  });

  it('لا يسجّل تعارضاً عندما يصل تحديث بنفس العنوان (أغلب الـ webhooks)', async () => {
    const order = buildOrder();
    const { svc, updateOne } = serviceFor(order, {
      bostaOrderId: 'B-77',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    await svc.handleOrderUpdate(payload('شارع الجلاء 12'));

    expect(setOf(updateOne).addressChangeConflict).toBeUndefined();
  });

  it('يرصد تغيّر المحافظة وحدها — تغيير المدينة يوجّه الشحنة إلى فرع آخر', async () => {
    const order = buildOrder();
    const { svc, updateOne } = serviceFor(order, {
      bostaOrderId: 'B-77',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    await svc.handleOrderUpdate(payload('شارع الجلاء 12', 'Cairo'));

    expect(setOf(updateOne).addressChangeConflict).toMatchObject({
      oldCity: 'Gharbia',
      newCity: 'Cairo',
    });
  });

  it('notes/tags تُحدَّث دائماً — التجميد يخص العنوان وحده', async () => {
    const order = buildOrder();
    const { svc, updateOne } = serviceFor(order, {
      bostaOrderId: 'B-77',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    const p = payload('شارع البحر 90');
    p.note = 'العميل طلب الاتصال قبل التسليم';
    p.tags = 'مستعجل, VIP';
    await svc.handleOrderUpdate(p);

    const $set = setOf(updateOne);
    expect($set.notes).toBe('العميل طلب الاتصال قبل التسليم');
    expect($set.tags).toEqual(['مستعجل', 'VIP']);
  });

  it('سجل أوردر شوبيفاي يتتبّع المتجر دائماً — الاختلاف عن الحركة هو ما يُظهر التعارض', async () => {
    const order = buildOrder();
    const { svc } = serviceFor(order, {
      bostaOrderId: 'B-77',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    await svc.handleOrderUpdate(payload('شارع البحر 90'));

    expect(order.shippingAddress).toBe('شارع البحر 90');
  });

  it('لا ينهار عندما لا توجد حركة مرتبطة (أوردر لم يُؤكَّد بعد)', async () => {
    const order = buildOrder({ status: 'pending' });
    const { svc, updateOne } = serviceFor(order, null);

    const res = await svc.handleOrderUpdate(payload('شارع البحر 90'));

    expect(res.updated).toBe(true);
    expect(setOf(updateOne).addressChangeConflict).toBeUndefined();
  });
});

describe('handleOrderUpdate — تجميد الأصناف والقيمة بعد التأكيد', () => {
  it('يحدّث الأصناف والإجمالي طالما الأوردر معلق', async () => {
    const order = buildOrder({ status: 'pending', total: 100 });
    const { svc } = serviceFor(order, null);

    const p = payload('شارع الجلاء 12');
    p.line_items = [];
    p.shipping_lines = [{ price: '70' }];
    await svc.handleOrderUpdate(p);

    expect(order.total).toBe(70);
    expect(order.valueChangeConflict).toBeUndefined();
  });

  it('⚠ لا يعدّل قيمة أوردر مؤكد — يسجّل تعارضاً بدلاً منه', async () => {
    const order = buildOrder({ status: 'confirmed', total: 895 });
    const { svc } = serviceFor(order, {
      bostaOrderId: '',
      shippingAddress: 'شارع الجلاء 12',
      shippingCity: 'Gharbia',
    });

    const p = payload('شارع الجلاء 12');
    p.shipping_lines = [{ price: '70' }];
    await svc.handleOrderUpdate(p);

    // القيمة المخزَّنة لا تتحرك — الحركة خصمت مخزوناً وحرّكت خزنة على أساسها
    expect(order.total).toBe(895);
    expect(order.valueChangeConflict).toMatchObject({
      oldTotal: 895,
      newTotal: 70,
      resolved: false,
    });
  });

  it('لا يسجّل تعارض قيمة عندما لا تتغير القيمة فعلياً', async () => {
    const order = buildOrder({ status: 'confirmed', total: 50 });
    const { svc } = serviceFor(order, null);

    const p = payload('شارع الجلاء 12');
    p.shipping_lines = [{ price: '50' }];
    p.line_items = [];
    await svc.handleOrderUpdate(p);

    expect(order.valueChangeConflict).toBeUndefined();
  });
});
