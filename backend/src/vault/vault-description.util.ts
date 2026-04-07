/**
 * Smart Description & Accounting Justification Generator
 * Generates Arabic descriptions and accounting justifications for vault entries
 * based on transaction source type, amount, and entity context
 */

interface EntityContext {
  customer?: string;
  supplier?: string;
  category?: string;
  itemCount?: number;
}

interface GeneratedTexts {
  desc: string;
  justification: string;
}

export function generateVaultTexts(
  amount: number,
  method: string,
  rawDesc: string,
  source: string,
  ref: string,
  ctx?: EntityContext,
): GeneratedTexts {
  const absAmount = Math.abs(amount);
  const customer = ctx?.customer || 'العميل';
  const supplier = ctx?.supplier || 'المورد';
  const category = ctx?.category || '';
  const methodLabel = method || 'الخزنة';

  // If rawDesc is already a rich description (longer than 20 chars), keep it as-is
  // and only generate the justification
  if (rawDesc && rawDesc.length > 20) {
    const justification = generateJustification(source, amount, method, ref);
    return {
      desc: rawDesc,
      justification,
    };
  }

  // Generate description based on source type
  let desc = '';
  let justification = '';

  switch (source) {
    case 'ديبوزت مبيعات':
      desc = `تم استلام عربون بيع فاتورة #${ref} من ${customer} بقيمة ${absAmount} ج عبر ${methodLabel}`;
      justification = `الخزنة (${methodLabel}) ترتفع ${absAmount} ج — الإيراد المحتمل يرتفع — المخزون لم يُخصم بعد (مرحلة الشحن)`;
      break;

    case 'تحصيل':
      desc = `تحصيل متبقي فاتورة #${ref} من ${customer} بقيمة ${absAmount} ج عبر ${methodLabel}`;
      justification = `الخزنة (${methodLabel}) ترتفع ${absAmount} ج — الفاتورة #${ref} مكتملة — الإيراد المحقق يُسجَّل الآن`;
      break;

    case 'مشتريات':
      desc = `دفع عربون مشتريات فاتورة #${ref} للمورد ${supplier} بقيمة ${absAmount} ج عبر ${methodLabel}`;
      justification = `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — المخزون سيرتفع عند الاستلام — تكلفة الشراء تزداد`;
      break;

    case 'دفع مشتريات':
      desc = `سداد متبقي مشتريات فاتورة #${ref} للمورد ${supplier} بقيمة ${absAmount} ج عبر ${methodLabel}`;
      justification = `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — الفاتورة مكتملة — تكلفة الشراء محققة`;
      break;

    case 'مصروف':
      const categoryLabel = category ? ` (${category})` : '';
      desc = `صرف ${absAmount} ج — ${rawDesc || 'مصروف تشغيل'}${categoryLabel} — عبر ${methodLabel}`;
      justification = `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — مصاريف التشغيل ترتفع — الربح الصافي ينخفض`;
      break;

    case 'رد مرتجع':
      desc = `رد مبلغ للعميل ${customer} بقيمة ${absAmount} ج على مرتجع فاتورة #${ref} عبر ${methodLabel}`;
      justification = `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — المخزون يرتفع بالأصناف المعادة — الإيراد ينخفض`;
      break;

    case 'إلغاء':
      const action = amount > 0 ? 'استرداد' : 'خصم';
      desc = `${action} مبلغ إلغاء فاتورة #${ref} — ${absAmount} ج`;
      justification = `عكس قيد سابق — الخزنة (${methodLabel}) تعود لوضعها قبل الحركة`;
      break;

    case 'خصم بعدي':
      desc = `خصم بعدي ${absAmount} ج على فاتورة #${ref} للعميل ${customer}`;
      justification = `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — الخصم يُطبَّق على الفاتورة الأصلية — الإيراد الفعلي ينخفض`;
      break;

    case 'تجميد':
      desc = `عكس قيد تجميد حركة #${ref} — ${absAmount} ج من ${methodLabel}`;
      justification = `استرجاع الحركة المجمدة — الخزنة (${methodLabel}) ترتفع بالمبلغ المجمد`;
      break;

    case 'يدوي':
    default:
      // For manual entries or unknown sources, use the raw description as-is
      desc = rawDesc || 'تعديل يدوي';
      justification = ''; // No standard justification for manual entries
      break;
  }

  return { desc, justification };
}

/**
 * Generate accounting justification based on source type
 * Helper function for when description is already provided
 */
function generateJustification(
  source: string,
  amount: number,
  method: string,
  ref: string,
): string {
  const absAmount = Math.abs(amount);
  const methodLabel = method || 'الخزنة';

  switch (source) {
    case 'ديبوزت مبيعات':
      return `الخزنة (${methodLabel}) ترتفع ${absAmount} ج — الإيراد المحتمل يرتفع — المخزون لم يُخصم بعد`;

    case 'تحصيل':
      return `الخزنة (${methodLabel}) ترتفع ${absAmount} ج — الفاتورة مكتملة — الإيراد المحقق`;

    case 'مشتريات':
      return `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — المخزون سيرتفع — التكلفة تزداد`;

    case 'دفع مشتريات':
      return `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — الفاتورة مكتملة — التكلفة محققة`;

    case 'مصروف':
      return `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — المصاريف ترتفع — الربح الصافي ينخفض`;

    case 'رد مرتجع':
      return `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — المخزون يرتفع — الإيراد ينخفض`;

    case 'إلغاء':
      return `عكس قيد سابق — الخزنة (${methodLabel}) تعود لحالتها السابقة`;

    case 'خصم بعدي':
      return `الخزنة (${methodLabel}) تنخفض ${absAmount} ج — الخصم يُطبَّق على الفاتورة`;

    case 'تجميد':
      return `استرجاع الحركة المجمدة — الخزنة (${methodLabel}) ترتفع`;

    default:
      return '';
  }
}
