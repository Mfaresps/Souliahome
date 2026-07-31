/**
 * Backend port of the frontend's STRICT deposit-note parser
 * (frontend/public/index.html: parseNoteAsPayment ~L14084, _spDetectDepositAndMethod ~L56411).
 *
 * Ported verbatim (same regexes, same fallback order) so the one-time backend parse
 * run at order-confirmation time (see shopify.service.ts#approveOrder) agrees with
 * what the frontend already shows for the same note text. The frontend's own parsing
 * functions are NOT touched — this is an independent copy for persisted scoring data.
 */

export interface ParsedPayment {
  isPayment: true;
  amount: number;
  method: string;
}

/** Port of frontend parseNoteAsPayment() at index.html:14084 */
export function parseNoteAsPayment(note: string | null | undefined): ParsedPayment | null {
  if (!note) return null;
  // Strip "جنيه" / "egp" / "ج" anywhere in the string before matching
  const s = note.trim().replace(/\bجنيه\b|\bج\b|\begp\b/gi, '').replace(/\s+/g, ' ').trim();

  // Fuzzy keyword sets — typo-tolerant via multiple variants
  const methodMap: { keywords: RegExp[]; label: string }[] = [
    {
      // Vodafone Cash — all Arabic/English/typo variants
      keywords: [
        /v[ou]d[ao]f[uo]?n[eae]?\s*(?:c[ao]sh?)?/i,
        /فو[اوأ]?[اد]?[وأ]?ف[وأ]?[وا]?ن\s*(?:كاش|cash)?/i,
        /فودا\s*(?:كاش|cash)?/i,
        /فوافون\s*(?:كاش)?/i,
        /\bvoda\b/i,
      ],
      label: 'فودافون كاش',
    },
    {
      // Instapay — insta, instapay, insta pay, انستا, انستاباي, انستباي, انستاي ...
      keywords: [
        /ins?t[ae]?\s*p?[ae]?y?/i,
        /insta\s*pay/i,
        /[اإأ]ن[سص]ت[اه]?\s*(?:ب[اه]?ي|pay)?/i,
        /\binsta?\b/i,
      ],
      label: 'Instapay',
    },
    {
      // Bank transfer — بنك, بنكي, bank, transfer, تحويل, حوالة
      keywords: [
        /ب[نا]?[نك][كي]?/i,
        /b[ae]?n[kc]/i,
        /trans?f[eai]?r?/i,
        /تح[وا]?[يو]?ل/i,
        /ح[وا]?[يو]?[اله]?[هة]/i,
      ],
      label: 'تحويل بنكي',
    },
    {
      // Cash — كاش, نقد, نقدي, cash, csh, kash
      keywords: [
        /[كق][اه][شس]ه?/i,
        /نق[دذ][يى]?/i,
        /c[ao]?sh?/i,
        /k[ae]sh?/i,
      ],
      label: 'كاش',
    },
  ];

  // Extract the first number found (handles 1000, 1,000, 1.5, ١٢٣ Arabic-Indic)
  const toWestern = (str: string) => str.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632));
  const numMatch = toWestern(s).match(/\d[\d,.]*/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[0].replace(/,/g, ''));
  if (!amount || amount <= 0) return null;

  // Remove the number from string to isolate keyword part
  const withoutNum = toWestern(s).replace(numMatch[0], '').trim();

  for (const { keywords, label } of methodMap) {
    if (keywords.some((rx) => rx.test(withoutNum) || rx.test(s))) {
      return { isPayment: true, amount, method: label };
    }
  }
  return null;
}

export interface DetectedDeposit {
  deposit: number;
  payment: string;
}

/** Port of frontend _spDetectDepositAndMethod() at index.html:56411 — the STRICT variant */
export function detectDepositAndMethod(order: {
  notes?: string;
  tags?: string;
  total?: number;
}): DetectedDeposit {
  const notes = order.notes || '';
  const cleanTags = (order.tags || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F9FF}✅❌💲📥💸🎉]/gu, '')
    .toLowerCase();
  const searchIn = (notes + ' ' + (order.tags || '')).toLowerCase();
  const fullPaidKeywords = ['تم دفع الاوردر بالكامل', 'paid in full', 'fully paid', 'دفع كامل', 'تم الدفع بالكامل'];
  const isFullPaid = fullPaidKeywords.some((k) => cleanTags.includes(k) || notes.toLowerCase().includes(k));
  let autoMethod = 'كاش';
  if (/voda|فودا|فون/.test(searchIn)) autoMethod = 'فودافون كاش';
  else if (/insta|انستا|إنستا/.test(searchIn)) autoMethod = 'Instapay';
  else if (/bank|بنك|تحويل|transfer/.test(searchIn)) autoMethod = 'تحويل بنكي';
  else if (/cash|كاش/.test(searchIn)) autoMethod = 'كاش';
  const np = parseNoteAsPayment(notes);
  if (np) return { deposit: np.amount, payment: autoMethod };
  if (isFullPaid) return { deposit: order.total || 0, payment: autoMethod };
  return { deposit: 0, payment: 'كاش' };
}

export interface ComputedDepositFields {
  depositAmount: number;
  depositMethod: string;
  depositStatus: 'full' | 'partial' | 'none';
  depositPercentage: number;
}

/** Derives the persisted ShopifyOrder deposit fields from detectDepositAndMethod's output + order.total. */
export function computeDepositFields(order: {
  notes?: string;
  tags?: string;
  total?: number;
}): ComputedDepositFields {
  const { deposit, payment } = detectDepositAndMethod(order);
  const total = order.total || 0;
  const percentage = total > 0 ? Math.min(100, Math.round((deposit / total) * 100)) : 0;
  const status: ComputedDepositFields['depositStatus'] =
    deposit <= 0 ? 'none' : percentage >= 100 ? 'full' : 'partial';

  return {
    depositAmount: deposit,
    depositMethod: payment,
    depositStatus: status,
    depositPercentage: percentage,
  };
}
