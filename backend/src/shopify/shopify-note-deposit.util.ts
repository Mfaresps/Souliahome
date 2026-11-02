/** A Shopify customer note can state a deposit already received by the team. */
export function depositFromShopifyNote(note: string): { amount: number; method: string } | null {
  const text = String(note || '').replace(/[٠-٩۰-۹]/g, digit =>
    String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit) >= 0 ? '٠١٢٣٤٥٦٧٨٩'.indexOf(digit) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  if (!text.trim()) return null;
  const label = '(?:ديبوزت|عربون|مقدم|مقدّم|deposit|down[ -]?payment)';
  const amount = '(?<!\\d)(\\d{1,7}(?:[.,]\\d{1,3})?)(?![\\d.,])';
  const hits: number[] = [];
  for (const line of text.split(/[\r\n;]+/)) {
    if (/(?:بدون|من غير|لا يوجد|مفيش|لم يدفع|لم يتم دفع|without|no)\s*(?:دفع\s*)?(?:ديبوزت|عربون|مقدم|مقدّم|deposit|down[ -]?payment)/i.test(line) || /(?:رد|استرداد|مسترد|refunded?)\s*(?:ال)?(?:ديبوزت|عربون|مقدم|مقدّم|deposit)/i.test(line)) continue;
    const after = new RegExp(`${label}\\s*(?:مدفوع|تم دفع|paid|amount|قيمته|بقيمة)?\\s*[:=–]?\\s*${amount}`, 'gi');
    const before = new RegExp(`${amount}\\s*(?:ج(?:\\.?م)?|egp|جنيه)?\\s*${label}`, 'gi');
    for (const pattern of [after, before]) {
      for (const match of line.matchAll(pattern)) {
        const raw = match[1];
        const value = Number(/[.,]\d{3}$/.test(raw) ? raw.replace(/[.,]/g, '') : raw.replace(',', '.'));
        if (Number.isFinite(value) && value > 0) hits.push(value);
      }
    }
  }
  // Several different figures in a free-text note are ambiguous; never guess which was paid.
  if (!hits.length || hits.some(value => value !== hits[0])) return null;
  const method = /instapay|إنستاباي|انستاباي/i.test(text) ? 'Instapay'
    : /vodafone|فودافون|fawry|فوري/i.test(text) ? 'فودافون كاش'
    : /bank|transfer|تحويل بنكي/i.test(text) ? 'تحويل بنكي'
    : /(?:^|\s)(?:كاش|cash)(?:\s|$)/i.test(text) ? 'كاش' : '';
  return { amount: hits[0], method };
}
