import { Connection, Types, isValidObjectId } from 'mongoose';

/**
 * المورد الأساسي للمنتج — **مصدر واحد**: سطر في `productsuppliers` عليه `primary: true`
 * (سطر واحد بس لكل منتج — unique partial index). `product.supplier` (الاسم) و`product.supplierId`
 * نسخة عرض بتتكتب من هنا بس، عشان الفلاتر والبحث والتصدير يفضلوا شغالين زي ما هم.
 *
 * ⚠ كل مسار بيغيّر مورد المنتج لازم يعدّي من `setPrimarySupplier`: حفظ الكارت، التعديل الجماعي،
 *   الاستيراد، زرار «اجعله الأساسي» في جدول الأسعار، أول فاتورة شراء، وحذف المورد من الجدول.
 * ⚠ مالوش أي دور في التكلفة أو الربح (دول من فواتير الشراء — avg-cost.util / line-cost.util).
 */
export type PrimaryRef = { id?: string; name?: string } | null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** المورد بالـ id، وإلا بالاسم (مطابق تمامًا، وإلا من غير فرق حروف كبيرة/صغيرة — نفس قاعدة تفرّد الاسم). */
export async function resolveSupplier(conn: Connection, ref: PrimaryRef): Promise<{ id: string; name: string } | null> {
  if (!ref) return null;
  const col = conn.collection('suppliers');
  if (ref.id && isValidObjectId(ref.id)) {
    const s: any = await col.findOne({ _id: new Types.ObjectId(ref.id) }, { projection: { name: 1 } });
    if (s) return { id: String(s._id), name: String(s.name || '') };
  }
  const name = String(ref.name || '').trim();
  if (!name) return null;
  const s: any = (await col.findOne({ name }, { projection: { name: 1 } }))
    || (await col.findOne({ name: { $regex: `^${escapeRe(name)}$`, $options: 'i' } }, { projection: { name: 1 } }));
  return s ? { id: String(s._id), name: String(s.name || '') } : null;
}

/**
 * يحدّد (أو يشيل) المورد الأساسي لمنتج.
 * - `ref` = null أو اسم فاضي → مافيش مورد أساسي، والمنتج «— بدون —».
 * - مورد معروف → سطره في جدول الأسعار يبقى الأساسي (يتعمل من غير سعر لو مش موجود)، والباقي لأ.
 * - اسم مش مطابق لأي مورد (استيراد قديم) → الاسم يفضل نص على المنتج من غير ربط، ومافيش سطر أساسي.
 * بيرجّع الحالة النهائية.
 */
export async function setPrimarySupplier(conn: Connection, productId: string, ref: PrimaryRef, by: string):
  Promise<{ supplierId: string; supplier: string }> {
  const products = conn.collection('products'), rows = conn.collection('productsuppliers');
  const pid = new Types.ObjectId(productId);
  const now = new Date();
  const resolved = await resolveSupplier(conn, ref);
  // حفظ الكارت بنفس المورد مايغيّرش حاجة ومايكتبش في السجل.
  const [cur, p]: any[] = await Promise.all([
    rows.findOne({ productId, primary: true }, { projection: { supplierId: 1, active: 1 } }),
    products.findOne({ _id: pid }, { projection: { supplier: 1, supplierId: 1 } }),
  ]);
  if (!p) throw new Error('product not found');
  if (resolved && cur?.supplierId === resolved.id && cur.active !== false && p.supplierId === resolved.id && p.supplier === resolved.name) {
    return { supplierId: resolved.id, supplier: resolved.name };
  }
  if (!resolved && !cur && !p.supplierId && String(p.supplier || '') === String(ref?.name || '').trim()) {
    return { supplierId: '', supplier: String(p.supplier || '') };
  }
  const unsetOthers = (keep: string | null) => rows.updateMany(
    { productId, primary: true, ...(keep ? { supplierId: { $ne: keep } } : {}) },
    { $set: { primary: false, updatedAt: now }, $push: { activityLog: { $each: [{ at: now.toISOString(), by, action: 'primary-off' }], $slice: -50 } } } as any,
  );

  if (!resolved) {
    await unsetOthers(null);
    const text = String(ref?.name || '').trim();
    await products.updateOne({ _id: pid }, { $set: { supplier: text, supplierId: '' } });
    return { supplierId: '', supplier: text };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    await unsetOthers(resolved.id);
    try {
      await rows.updateOne(
        { productId, supplierId: resolved.id },
        {
          $set: { primary: true, active: true, supplierName: resolved.name, updatedAt: now },
          $setOnInsert: { price: null, priceSource: 'manual', priceDate: '', priceUpdatedAt: '', priceUpdatedBy: '', lastPurchase: null, createdAt: now },
          $push: { activityLog: { $each: [{ at: now.toISOString(), by, action: 'primary-on' }], $slice: -50 } },
        } as any,
        { upsert: true },
      );
      break;
    } catch (e: any) {
      // طلبين في نفس اللحظة: الـ index بيرفض أساسي تاني — نعيد مرة.
      if (e?.code !== 11000 || attempt === 1) throw e;
    }
  }
  await products.updateOne({ _id: pid }, { $set: { supplier: resolved.name, supplierId: resolved.id } });
  return { supplierId: resolved.id, supplier: resolved.name };
}
