/** Bank names and unambiguous logo codes seen on Egyptian transfer receipts. */
const BANK_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['البنك الأهلي المصري (NBE)', ['NBE', 'National Bank of Egypt', 'البنك الأهلي المصري', 'الاهلي المصري']],
  ['بنك مصر', ['BM', 'Banque Misr', 'Bank Misr', 'بنك مصر']],
  ['البنك التجاري الدولي (CIB)', ['CIB', 'Commercial International Bank', 'CIB Bank', 'البنك التجاري الدولي']],
  ['بنك القاهرة', ['BDC', 'Banque du Caire', 'Bank of Cairo', 'بنك القاهرة']],
  ['بنك الإسكندرية', ['BOA', 'AlexBank', 'Bank of Alexandria', 'بنك الإسكندرية']],
  ['بنك قطر الوطني الأهلي (QNB)', ['QNB', 'QNB Alahli', 'QNB Egypt', 'بنك قطر الوطني الأهلي']],
  ['البنك العربي الأفريقي الدولي (AAIB)', ['AAIB', 'Arab African International Bank', 'البنك العربي الأفريقي الدولي']],
  ['مصرف أبو ظبي الإسلامي (ADIB)', ['ADIB', 'Abu Dhabi Islamic Bank', 'Abu Dhabi Islamic Bank Egypt', 'مصرف أبو ظبي الإسلامي']],
  ['البنك الزراعي المصري (ABE)', ['ABE', 'Agricultural Bank of Egypt', 'البنك الزراعي المصري']],
  ['بنك ABC', ['ABC', 'Bank ABC', 'Arab Banking Corporation', 'بنك المؤسسة العربية المصرفية']],
  ['بنك HSBC مصر', ['HSBC', 'HSBC Egypt', 'HSBC Bank Egypt', 'بنك اتش اس بي سي مصر']],
  ['بنك أبوظبي التجاري مصر (ADCB)', ['ADCB', 'Abu Dhabi Commercial Bank Egypt', 'بنك أبوظبي التجاري مصر']],
  ['بنك الإمارات دبي الوطني مصر', ['Emirates NBD', 'Emirates NBD Egypt', 'بنك الإمارات دبي الوطني مصر']],
  ['بنك كريدي أجريكول مصر', ['Credit Agricole Egypt', 'Crédit Agricole Egypt', 'كريدي أجريكول مصر']],
  ['بنك التعمير والإسكان (HDB)', ['HDB', 'Housing and Development Bank', 'بنك التعمير والإسكان']],
  ['البنك المصري الخليجي (EGBANK)', ['EGBANK', 'EG Bank', 'Egyptian Gulf Bank', 'البنك المصري الخليجي']],
  ['بنك أبوظبي الأول مصر (FABMISR)', ['FABMISR', 'First Abu Dhabi Bank Misr', 'بنك أبوظبي الأول مصر']],
];

function normalizeBankText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const BY_ALIAS = new Map(BANK_ALIASES.flatMap(([name, aliases]) =>
  aliases.map(alias => [normalizeBankText(alias), name] as const)));

/** Exact aliases only: a partial or uncertain OCR reading should stay editable. */
export function recognizeEgyptianBankName(line: string): string | undefined {
  const bankText = line
    .replace(/[a-z0-9._+-]+\s*@\s*instapay\b.*$/i, '')
    .replace(/^(?:bank|بنك)\s*[:：]\s*/iu, '')
    .replace(/^[\s▶►▸|:-]+|[\s▶►▸|:-]+$/g, '');
  const normalized = normalizeBankText(bankText);
  const acronym = /^(?:[a-z] ){2,}[a-z]$/.test(normalized) ? normalized.replace(/ /g, '') : normalized;
  return BY_ALIAS.get(acronym);
}
