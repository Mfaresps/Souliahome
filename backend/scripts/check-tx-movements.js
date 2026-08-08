/**
 * تشخيص: هل اتسجلت حركة مخزون للمعاملات دي؟
 *
 * بيقارن أصناف المعاملة بصفوف سجل حركة المخزون، وبيقول السبب الدقيق
 * لو مفيش حركة — تجاوز approveOrder، ولا كود صنف مش متطابق.
 *
 * التشغيل من مجلد backend:
 *   node scripts/check-tx-movements.js 2273 2296
 *
 * بيقرأ MONGODB_URI من البيئة، وبيرجع لـ localhost:27017 لو مش موجود.
 * قراءة فقط — لا يكتب أي شيء.
 */
const mongoose = require('mongoose');

const refs = process.argv.slice(2).map((r) => String(r).replace(/^#+/, '').trim()).filter(Boolean);
if (!refs.length) {
  console.error('استخدام: node scripts/check-tx-movements.js 2273 2296');
  process.exit(1);
}

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia';

(async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  console.log(`متصل بـ: ${db.databaseName}\n`);

  const txCol = db.collection('transactions');
  const mvCol = db.collection('inventorymovements');
  const prCol = db.collection('products');

  for (const ref of refs) {
    console.log('='.repeat(64));
    const tx = await txCol.findOne({ ref });
    if (!tx) {
      console.log(`#${ref}: المعاملة غير موجودة`);
      continue;
    }

    const isShopify = tx.source === 'shopify' || !!tx.shopifyOrderId;
    console.log(`#${ref} — ${tx.type} | ${tx.client || ''}`);
    console.log(`  المصدر    : ${isShopify ? 'Shopify' : (tx.source || 'يدوي')}`);
    console.log(`  الموظف    : ${tx.employee || '—'}`);
    console.log(`  أنشئت في  : ${tx.createdAt || tx.date || '—'}`);
    console.log(`  ملغاة/مؤرشفة: ${tx.cancelled ? 'نعم' : 'لا'} / ${tx.archived ? 'نعم' : 'لا'}`);

    const movements = await mvCol.find({ sourceTransactionRef: ref }).toArray();
    console.log(`\n  صفوف سجل حركة المخزون: ${movements.length}`);
    for (const m of movements) {
      console.log(`    • ${m.type} | ${m.productCode} | ${m.qtyDelta > 0 ? '+' : ''}${m.qtyDelta} | ${m.qtyBefore} → ${m.qtyAfter} | ${m.sourceType}`);
    }

    console.log(`\n  أصناف المعاملة: ${(tx.items || []).length}`);
    let unmatched = 0;
    for (const it of tx.items || []) {
      const code = String(it.code || '').trim();
      // نفس المطابقة الحرفية المستخدمة في getInventory / كتلة تسجيل الحركة
      const product = code ? await prCol.findOne({ code }) : null;
      const hasMovement = movements.some((m) => String(m.productCode).trim() === code);
      if (!product) unmatched++;
      const flag = !product ? '❌ كود غير مطابق لأي منتج' : (hasMovement ? '✅ مسجّلة' : '⚠️ منتج موجود لكن بدون حركة');
      console.log(`    • ${it.name || '?'} | كود="${code || '(فارغ)'}" | كمية=${it.qty} → ${flag}`);
    }

    // الحكم
    console.log('');
    if (movements.length) {
      console.log('  ✅ الحركة اتسجلت — الإصلاح شغّال على المعاملة دي.');
    } else if (unmatched === (tx.items || []).length && unmatched > 0) {
      console.log('  ❌ مفيش حركة، وكل الأكواد غير مطابقة.');
      console.log('     السبب: أكواد أصناف شوبيفاي (SKU) لا تطابق أكواد المنتجات — مش مشكلة الكود القديم.');
      console.log('     لاحظ: الرصيد كمان مش هينقص، لأن getInventory بيطابق بنفس الكود.');
    } else if (!isShopify) {
      console.log('  ⚠️ مفيش حركة ومصدرها مش شوبيفاي — سبب مختلف، يحتاج فحص.');
    } else {
      console.log('  ❌ مفيش حركة — الباك-إند لسه بيشغّل النسخة القديمة (قبل الإصلاح).');
      console.log('     الحل: أعد بناء/تشغيل الباك-إند، ثم استخدم backfill للمعاملة دي.');
    }
  }

  console.log('='.repeat(64));
  await mongoose.disconnect();
})().catch((e) => {
  console.error('فشل:', e.message);
  process.exit(1);
});
