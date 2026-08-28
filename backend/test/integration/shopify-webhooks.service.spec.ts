/**
 * الـ webhooks التي كانت مسجَّلة في شوبيفاي وتُرمى بصمت.
 *
 * ستة webhooks مسجَّلة، واثنان فقط (orders/create و orders/updated) كانا متعالَجين. الباقي
 * كان يصل، يعبر التحقق من التوقيع، ثم يسقط على `return { received: true }` مع 200 OK —
 * فلا يعيد شوبيفاي المحاولة ولا يظهر الإسقاط في أي مكان.
 *
 * القاعدة الحاكمة في الثلاثة: النظام يسجّل الواقعة ولا يتخذ القرار المالي. إلغاء حركة مؤكدة
 * يعكس المخزون والخزنة ودفتر المورد — لا يُشتق ذلك من webhook.
 *
 * Run with: npm test -- shopify-webhooks
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
    status: 'pending',
    cancelled: false,
    cancelRequest: null,
    total: 895,
    items: [{ code: 'A', qty: 1, price: 845 }],
    ...overrides,
  };
  o.save = jest.fn().mockImplementation(async () => o);
  return o;
}

function serviceFor(order: any, tx: any) {
  const updateOne = jest.fn().mockResolvedValue({});
  const svc = Object.create(ShopifyServiceClass().prototype);
  svc.shopifyOrderModel = {
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(order),
      // handleOrderCancelled needs a real doc (it calls .save()), so findOne resolves too
      then: (r: any) => Promise.resolve(order).then(r),
    }),
  };
  svc.txModel = {
    updateOne,
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(tx) }),
    }),
  };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.presence = { emitEvent: jest.fn() };
  return { svc, updateOne };
}

describe('handleOrderCancelled — إلغاء من شوبيفاي', () => {
  it('يلغي مباشرة عندما لا توجد حركة (لم يتحرك مخزون ولا خزنة)', async () => {
    const order = buildOrder();
    const { svc } = serviceFor(order, null);

    const res = await svc.handleOrderCancelled({ id: 111, cancel_reason: 'customer' });

    expect(res.handled).toBe(true);
    expect(order.cancelled).toBe(true);
    expect(order.cancelReasonCode).toBe('shopify-cancelled');
    expect(order.cancelledBy).toBe('Shopify');
    expect(order.save).toHaveBeenCalled();
  });

  it('⚠ لا يلغي حركة مؤكدة تلقائياً — يسجّل تعارضاً بدلاً من ذلك', async () => {
    const order = buildOrder({ status: 'confirmed' });
    const { svc, updateOne } = serviceFor(order, {
      _id: 't1',
      cancelled: false,
      bostaOrderId: 'B-77',
    });

    const res = await svc.handleOrderCancelled({ id: 111, cancel_reason: 'customer' });

    expect(res.handled).toBe(true);
    // الأوردر لا يُلغى، والحركة لا تُمس — القرار المالي يبقى بشرياً
    expect(order.cancelled).toBe(false);
    expect(order.save).not.toHaveBeenCalled();

    const $set = updateOne.mock.calls[0][1].$set;
    expect($set.shopifyCancelConflict).toMatchObject({ shipped: true, resolved: false });
  });

  it('يميّز الشحنة الخارجة — shipped يغيّر الإجراء المطلوب', async () => {
    const order = buildOrder({ status: 'confirmed' });
    const { svc, updateOne } = serviceFor(order, {
      _id: 't1',
      cancelled: false,
      bostaOrderId: '',
    });

    await svc.handleOrderCancelled({ id: 111 });

    expect(updateOne.mock.calls[0][1].$set.shopifyCancelConflict.shipped).toBe(false);
  });

  it('لا يكرر العمل على أوردر ملغي بالفعل', async () => {
    const order = buildOrder({ cancelled: true });
    const { svc } = serviceFor(order, null);

    const res = await svc.handleOrderCancelled({ id: 111 });

    expect(res.handled).toBe(true);
    expect(order.save).not.toHaveBeenCalled();
  });

  it('لا يرمي عند الخطأ — الرمي يعطّل الـ webhook لدى شوبيفاي', async () => {
    const svc = Object.create(ShopifyServiceClass().prototype);
    svc.shopifyOrderModel = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await expect(svc.handleOrderCancelled({ id: 111 })).resolves.toMatchObject({
      handled: false,
    });
  });
});

describe('handleFulfillment — شحنة من خارج النظام', () => {
  it('⚠ يتجاهل صدى شحنتنا — رقم التتبع هو ما أرسلناه بعد إنشاء شحنة Bosta', async () => {
    const order = buildOrder({ status: 'confirmed' });
    const { svc, updateOne } = serviceFor(order, {
      _id: 't1',
      bostaTrackingNumber: 'BST123',
      bostaOrderId: 'B-77',
    });

    const res = await svc.handleFulfillment({ order_id: 111, tracking_number: 'BST123' });

    expect(res.handled).toBe(true);
    // لا كتابة إطلاقاً — وإلا صارت حلقة: نكتب حالة كتبناها للتو
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('⚠ رقم التتبع وحده يكفي لتمييز الصدى — لا يعتمد على bostaOrderId فقط', async () => {
    // شحنة أنشأناها نحن لكن bostaOrderId لم يُخزَّن بعد (سباق بين الحفظ ووصول الـ webhook).
    // بدون فحص رقم التتبع تُسجَّل شحنتنا كـ«خارجية» وتظهر إنذاراً كاذباً على كل طلب نشحنه.
    const order = buildOrder({ status: 'confirmed' });
    const { svc, updateOne } = serviceFor(order, {
      _id: 't1',
      bostaTrackingNumber: 'BST123',
      bostaOrderId: '',
    });

    await svc.handleFulfillment({ order_id: 111, tracking_number: 'BST123' });

    expect(updateOne).not.toHaveBeenCalled();
  });

  it('يسجّل شحنة أُنشئت من لوحة شوبيفاي مباشرة', async () => {
    const order = buildOrder({ status: 'confirmed' });
    const { svc, updateOne } = serviceFor(order, {
      _id: 't1',
      bostaTrackingNumber: '',
      bostaOrderId: '',
    });

    await svc.handleFulfillment({
      order_id: 111,
      tracking_number: 'AR99',
      tracking_company: 'Aramex',
      status: 'success',
    });

    expect(updateOne.mock.calls[0][1].$set.externalFulfillment).toMatchObject({
      trackingNumber: 'AR99',
      trackingCompany: 'Aramex',
      resolved: false,
    });
  });

  it('لا يكتب فوق شحنة Bosta عند ورود رقم تتبع مختلف', async () => {
    const order = buildOrder({ status: 'confirmed' });
    const { svc, updateOne } = serviceFor(order, {
      _id: 't1',
      bostaTrackingNumber: 'BST123',
      bostaOrderId: 'B-77',
    });

    const res = await svc.handleFulfillment({ order_id: 111, tracking_number: 'OTHER' });

    expect(res.handled).toBe(true);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('لا يرمي عند غياب order_id', async () => {
    const svc = Object.create(ShopifyServiceClass().prototype);
    svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await expect(svc.handleFulfillment({})).resolves.toMatchObject({ handled: false });
  });
});
