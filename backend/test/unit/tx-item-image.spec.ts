import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { CreateTransactionDto, UpdateTransactionDto } from '../../src/transactions/dto/transaction.dto';
import { CreateReturnRequestDto } from '../../src/returns/dto/return-request.dto';

/**
 * الصورة كانت بتختفي من كل سطور الفواتير، والسبب مكانش في الـrenderer.
 *
 * `TransactionItem.imageUrl` موجود في الـschema، والـfrontend (`saveTx`) وShopify
 * (`mapItems`) الاتنين بيبعتوه — بس `TransactionItemDto` مكانش معرّفه. الـValidationPipe
 * شغّال بـ`whitelist:true` + `forbidNonWhitelisted:false` (شوف main.ts)، يعني أي خاصية
 * مش معرّفة في الـDTO **بتتشال في صمت** من غير أي خطأ. النتيجة: 1180 سطر في قاعدة
 * البيانات كلهم من غير صورة، وكل فاتورة بتعرض الأيقونة البديلة.
 *
 * ⚠ الاختبار ده بيشغّل الـDTO **الحقيقي** جوّه ValidationPipe بنفس إعدادات main.ts —
 * مش نسخة محلية. نسخة محلية كانت هتفضل ناجحة بعد ما الأصل يتكسر، وده بالظبط اللي
 * `returns.spec.ts` بيعمله غلط (متوثّق في CLAUDE.md).
 */
describe('TransactionItemDto — imageUrl يعدّي من الـwhitelist pipe', () => {
  // نفس إعدادات main.ts بالظبط — لو اتغيرت هناك لازم تتغير هنا.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  });

  const IMG = 'https://i.ibb.co/KxrqjvGV/image.png';

  const item = (extra: Record<string, unknown> = {}) => ({
    productId: '6a754a85725d8d582c171e83',
    code: 'STRIPED-SAFFRON-ORG-001',
    name: 'Striped Saffron Tote Bag',
    imageUrl: IMG,
    qty: 1,
    price: 875,
    total: 875,
    ...extra,
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    date: '2026-08-28',
    type: 'مبيعات',
    client: 'Sara Medhat',
    employee: 'Shopify (admin)',
    items: [item()],
    total: 875,
    ...extra,
  });

  const run = async (payload: unknown, metatype: any) =>
    (await pipe.transform(payload, { type: 'body', metatype })) as any;

  it('بيحافظ على imageUrl في الإنشاء — الانحدار الأصلي (فاتورة #2439)', async () => {
    const out = await run(body(), CreateTransactionDto);
    expect(out.items[0].imageUrl).toBe(IMG);
  });

  it('بيحافظ على imageUrl في التعديل — التعديل مالازمش يمسح صورة اتخزنت', async () => {
    const out = await run(body(), UpdateTransactionDto);
    expect(out.items[0].imageUrl).toBe(IMG);
  });

  it('السطر بيخرج بكل حقوله ومحدش اتشال في صمت', async () => {
    const out = await run(body(), CreateTransactionDto);
    expect(Object.keys(out.items[0]).sort()).toEqual(
      ['code', 'imageUrl', 'name', 'price', 'productId', 'qty', 'total'].sort(),
    );
  });

  it('imageUrl اختياري — سطر من غير صورة لسه صالح (بيانات قديمة/منتج بلا صورة)', async () => {
    const noImg: any = item();
    delete noImg.imageUrl;
    const out = await run(body({ items: [noImg] }), CreateTransactionDto);
    expect(out.items[0].imageUrl).toBeUndefined();
    expect(out.items[0].name).toBe('Striped Saffron Tote Bag');
  });

  it('لسه بيشيل الخصائص غير المعرّفة — الـwhitelist نفسها مااتلغتش', async () => {
    const out = await run(
      body({ items: [item({ someUnknownField: 'x' })] }),
      CreateTransactionDto,
    );
    expect(out.items[0].imageUrl).toBe(IMG);
    expect(out.items[0].someUnknownField).toBeUndefined();
  });
});

/**
 * نفس الفجوة كانت في مسار مرتجعات العملاء.
 *
 * سلسلة الصورة هنا 3 خطوات: العميل → `ReturnItemDto` → `ReturnRequest` →
 * (وقت الاعتماد) `items: ret.items` على معاملة الـ'مرتجع' اللي بتتعرض في صفحة
 * الفاتورة. الـDTO هو البوابة الوحيدة اللي بتفلتر — `items` معرّف
 * `type: [Object]` في الـschema فبيقبل أي حقل — يعني سطر من غير `imageUrl` في
 * الـDTO كان بيوصل آخر الخط فاضي.
 */
describe('ReturnItemDto — imageUrl يعدّي لمعاملة المرتجع', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  });

  const IMG = 'https://i.ibb.co/KxrqjvGV/image.png';

  const body = (items: unknown[]) => ({
    originalTransactionId: '6a754a85725d8d582c171e83',
    originalRef: '2439',
    originalDate: '2026-08-20',
    client: 'Sara Medhat',
    items,
    total: 875,
    // لازم يكون من ALL_RETURN_REASONS وإلا الـDTO بيرفض قبل ما نوصل للصورة.
    reason: 'عيب مصنع',
  });

  const line = (extra: Record<string, unknown> = {}) => ({
    code: 'STRIPED-SAFFRON-ORG-001',
    name: 'Striped Saffron Tote Bag',
    imageUrl: IMG,
    qty: 1,
    price: 875,
    total: 875,
    condition: 'سليم',
    ...extra,
  });

  const run = async (payload: unknown) =>
    (await pipe.transform(payload, {
      type: 'body',
      metatype: CreateReturnRequestDto,
    })) as any;

  it('بيحافظ على imageUrl في طلب المرتجع', async () => {
    const out = await run(body([line()]));
    expect(out.items[0].imageUrl).toBe(IMG);
  });

  it('الصورة بتعدّي كمان من DTO المعاملة لما approve() تنسخ ret.items', async () => {
    const afterReturn = await run(body([line()]));
    // نفس اللي approve() بتعمله: items: ret.items → TransactionsService.create
    const afterTx: any = await pipe.transform(
      {
        date: '2026-08-28',
        type: 'مرتجع',
        client: 'Sara Medhat',
        employee: 'admin',
        items: afterReturn.items.map((i: any) => ({
          code: i.code,
          name: i.name,
          imageUrl: i.imageUrl,
          qty: i.qty,
          price: i.price,
          total: i.total,
          condition: i.condition,
        })),
        total: 875,
      },
      { type: 'body', metatype: CreateTransactionDto },
    );
    expect(afterTx.items[0].imageUrl).toBe(IMG);
  });

  it('اختياري — طلب من غير صورة لسه صالح', async () => {
    const noImg: any = line();
    delete noImg.imageUrl;
    const out = await run(body([noImg]));
    expect(out.items[0].imageUrl).toBeUndefined();
    expect(out.items[0].condition).toBe('سليم');
  });

  it('condition لسه شغال جنب الصورة — مافيش حقل زاح التاني', async () => {
    const out = await run(body([line({ condition: 'تالف' })]));
    expect(out.items[0].imageUrl).toBe(IMG);
    expect(out.items[0].condition).toBe('تالف');
  });
});
