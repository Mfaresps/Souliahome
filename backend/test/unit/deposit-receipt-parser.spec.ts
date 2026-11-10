import * as fs from 'fs';
import * as path from 'path';
import {
  parseReceiptText,
  mergeReceiptPasses,
  normalizeOcrText,
} from '../../src/shopify/deposit-receipt-parser.util';

export {};

/**
 * The receipt parser suggests the amount and vault an employee then confirms. Its one forbidden
 * failure is a WRONG confident suggestion — a blank field costs five seconds, a wrong figure gets
 * approved into the vault.
 *
 * The fixture is the real Tesseract (ara+eng) output of 17 customer screenshots, two preparation
 * passes each (A: 3× + threshold, B: 2× grayscale), with customer handles, sender phones, a full
 * name and transfer references replaced. The noise is kept exactly as OCR produced it.
 */
const OCR: Record<string, { a: string; b: string }> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/deposit-receipts-ocr.json'), 'utf8'),
);

const W = 'فودافون كاش';
const both = (i: number) => mergeReceiptPasses([parseReceiptText(OCR[i].a), parseReceiptText(OCR[i].b)]);

describe('real receipts — amount and vault', () => {
  const CASES: Array<[number, number | null, string, string]> = [
    // [fixture, amount, vault, why]
    [3, 2000, W, 'Instapay sender, «Mobile Wallet» destination → the money is in Vodafone Cash'],
    [4, 500, '', 'Instapay, receiver handle unreadable → destination unknown, vault left blank'],
    [5, 400, 'Instapay', 'Instapay → Instapay (both handles read)'],
    [6, 500, 'Instapay', 'Arabic Instapay receipt; one pass read «م5000», the other «500»'],
    [8, 500, W, 'wallet app (Arabic); fee-inclusive total 501 must not win'],
    [9, 500, W, 'wallet app (English); «Total Amount deducted EGP 501» must not win'],
    [12, 1250, W, 'Instapay → «المحفظه الالكترونية»'],
    [13, 120, W, 'Instapay → Mobile Wallet'],
    [14, 800, W, 'USSD dialog'],
    [15, 500, W, 'USSD dialog, dark theme'],
    [16, 2000, W, 'USSD «Send command»'],
    [17, 3000, W, 'USSD — one pass reverses the line order'],
    [18, 400, W, 'USSD over the home screen, «ثم تحوبل» misread'],
    [19, 1020, W, 'USSD; the other pass read «00»'],
  ];
  it.each(CASES)('#%i → %p / %p (%s)', (i, amount, vault) => {
    const r = both(i);
    expect(r.amount).toBe(amount);
    expect(r.method).toBe(vault);
  });

  it('the three receipts OCR cannot read produce NO amount rather than a wrong one', () => {
    // 7 / 10: «٥٠٠» in a display font read as «098٠٠» / «000» / «086»; 11: stylized «١٢٧٠».
    for (const i of [7, 10, 11]) {
      expect(both(i).amount).toBeNull();
      expect(both(i).confident).toBe(false);
    }
  });

  it('never makes a wrong suggestion across the whole set', () => {
    const expected: Record<number, number | null> = {
      3: 2000, 4: 500, 5: 400, 6: 500, 7: null, 8: 500, 9: 500, 10: null, 11: null,
      12: 1250, 13: 120, 14: 800, 15: 500, 16: 2000, 17: 3000, 18: 400, 19: 1020,
    };
    for (const [i, amount] of Object.entries(expected)) {
      const r = both(Number(i));
      if (r.amount != null) expect(r.amount).toBe(amount);
    }
  });

  it('confident only when both an amount and a vault are known', () => {
    expect(both(4).confident).toBe(false); // amount read, destination unknown
    expect(both(14).confident).toBe(true);
  });

  it('recognizes a USSD send dialog when OCR splits the fee and service words', () => {
    const receipt = parseReceiptText('تم تحويل 3000 جنيه لرقم 01008835575 مصاريف\n9 *O# dbl LAs 1 الخدمة\n0:مزيد\nإلغاء\nإرسال');
    expect(receipt).toMatchObject({ amount: 3000, method: W, pattern: 'ussd' });
  });

  it('extracts the 12-digit transfer reference (used to warn on a reused receipt)', () => {
    expect(both(5).reference).toBe('700000000002');
    expect(both(9).reference).toBe('020000000005');
  });
});

describe('rules on synthetic text', () => {
  it('reads the pictured wallet receipt amount, sender phone and transaction number without using its fee', () => {
    const receipt = parseReceiptText([
      'جنيه 300.00',
      'تكلفة المعاملة 1.50 جنيهات',
      'من',
      '01275030836',
      'إلى',
      'Mohamed F I*****',
      '01008835575',
      'حالة العملية ناجحة',
      'نوع العملية تحويل أموال',
      'التاريخ 11 سبتمبر 2026',
      'الوقت 01:03:37',
      'رقم العملية 25000143088423',
    ].join('\n'));
    expect(receipt).toMatchObject({ amount: 300, method: W, senderPhone: '01275030836',
      reference: '25000143088423' });
  });
  it.each(['300.00\nجنيه', 'جنيه\n300.00'])('reads the pictured amount when OCR splits it as %s', amountLines => {
    const receipt = parseReceiptText(`${amountLines}\nتكلفة المعاملة 1.50 جنيهات\nمن\n01275030836\nإلى\n01008835575\nرقم العملية 25000143088423`);
    expect(receipt).toMatchObject({ amount: 300, method: W, reference: '25000143088423' });
  });
  it('does not use a split fee as the wallet transfer amount', () => {
    const receipt = parseReceiptText('تكلفة المعاملة\n1.50\nجنيه\nمن\n01275030836\nرقم العملية 25000143088423');
    expect(receipt.amount).toBeNull();
  });
  it('reads the pictured transaction number when RTL OCR puts it before its label', () => {
    const receipt = parseReceiptText('300.00 جنيه\nمن\n01275030836\nإلى\n01008835575\n25000143088423\nرقم العملية');
    expect(receipt.reference).toBe('25000143088423');
  });
  it('reads an Arabic Vodafone Cash receipt without taking its fee-inclusive total', () => {
    const receipt = parseReceiptText('لقد تم الدفع بنجاح!\nإجمالي المبلغ\n١٬٢٧٠ جنيه\nمن\n٠١٠٩٧٨٥٣١٥٨\nإلى\n٠١٠٠٨٨٣٥٥٧٥\nالرسوم\n١ جنيه\nالإجمالي\n١٬٢٧١ جنيه\nرقم العملية\n٢٣٥٠٧٤٩١٦٥٨\nتاريخ العملية\n٨ سبتمبر ٢٠٢٦، ٠٨:٣٥');
    expect(receipt).toMatchObject({ amount: 1270, method: 'فودافون كاش', senderPhone: '01097853158',
      reference: '23507491658', dateText: '8 سبتمبر 2026، 08:35' });
  });
  it('does not use the later fee-inclusive total as a transfer amount', () => {
    expect(parseReceiptText('تم الدفع بنجاح\nمن\n01097853158\nإلى\n01008835575\nالرسوم\n١ جنيه\nالإجمالي\n١٬٢٧١ جنيه').amount).toBeNull();
  });
  it('separates a bank logo from the sender and reads the labelled date and reference', () => {
    const receipt = parseReceiptText('Your transaction was successful\n500 EGP\nFrom\nABCD ▶ rabi8ul@instapay\nACCOUNT XXX00101\nTo\nMobile Wallet\nReference 957372239566\nDate 25 Sep 2026 03:44 PM');
    expect(receipt.senderName).toBeUndefined();
    expect(receipt.senderBank).toBe('ABCD');
    expect(receipt.senderHandle).toBe('rabi8ul@instapay');
    expect(receipt.reference).toBe('957372239566');
    expect(receipt.dateText).toBe('25 Sep 2026 03:44 PM');
  });
  it('reads the sender address and bank from a real InstaPay receipt without a From label', () => {
    expect(both(3)).toMatchObject({ senderHandle: 'customer1@instapay', senderBank: 'البنك التجاري الدولي (CIB)' });
    expect(both(5).senderHandle).toBe('customer3@instapay');
  });
  it('does not take an unlabelled recipient address or recipient bank as the sender', () => {
    expect(parseReceiptText('Transaction Successful\n500 EGP\nTo\nrecipient@instapay\nCIB')).not.toHaveProperty('senderHandle');
    const receipt = parseReceiptText('Transaction Successful\n500 EGP\ncustomer@instapay\nTo\nrecipient@instapay\nCIB');
    expect(receipt.senderHandle).toBe('customer@instapay');
    expect(receipt).not.toHaveProperty('senderBank');
  });
  it('keeps a real two-word sender name beside a bank code', () => {
    const receipt = parseReceiptText('From\nABCD\nAhmed Ali\nahmed@instapay\nTo\nMobile Wallet');
    expect(receipt.senderBank).toBe('ABCD');
    expect(receipt.senderName).toBe('Ahmed Ali');
  });
  it.each([
    ['CIB ▶ sender@instapay', 'البنك التجاري الدولي (CIB)'],
    ['NBE', 'البنك الأهلي المصري (NBE)'],
    ['بنك مصر', 'بنك مصر'],
    ['QNB Alahli', 'بنك قطر الوطني الأهلي (QNB)'],
    ['A.D.I.B', 'مصرف أبو ظبي الإسلامي (ADIB)'],
    ['Bank: AAIB', 'البنك العربي الأفريقي الدولي (AAIB)'],
  ])('identifies the sender bank from %s', (bankLine, expected) => {
    const receipt = parseReceiptText(`From\n${bankLine}\nAhmed Ali\nTo\nMobile Wallet`);
    expect(receipt.senderBank).toBe(expected);
    expect(receipt.senderName).toBe('Ahmed Ali');
  });
  it('does not infer the sender bank from a recipient, handle, or conflicting logos', () => {
    expect(parseReceiptText('From\nAhmed Ali\nTo\nCIB').senderBank).toBeUndefined();
    expect(parseReceiptText('From\ncib_customer@instapay\nTo\nMobile Wallet').senderBank).toBeUndefined();
    expect(parseReceiptText('From\nCIB\nNBE\nTo\nMobile Wallet').senderBank).toBeUndefined();
  });
  it('prefers a labelled transfer reference over an unrelated 12-digit identifier', () => {
    const receipt = parseReceiptText('Account 123456789012\nReference\n957372239566\nDate\n25 Sep 2026 03:44 PM');
    expect(receipt.reference).toBe('957372239566');
    expect(receipt.dateText).toBe('25 Sep 2026 03:44 PM');
  });
  it.each(['١٬٢٧٠ جنيه', 'جنيه ۴۰۰', '300.00 جنيه'])('reads Arabic/Latin/Persian currency amount %s', text => {
    expect(parseReceiptText(text).amount).toBe(text.includes('١')?1270:text.includes('۴')?400:300);
  });
  it('ignores a transaction fee with the observed OCR spelling error', () => {
    expect(parseReceiptText('0 جنيه\nتكلغة المعاملة 1.50 جنيهات').amount).toBeNull();
  });
  it('does not take an Arabic fee on the line after its label', () => {
    expect(parseReceiptText('تم الدفع بنجاح\n[unreadable]\nالرسوم\n١ جنيه\nالإجمالي\n٤٠١ جنيه').amount).toBeNull();
  });
  it('does not treat a late one-digit Arabic fee as a primary amount when its label is lost', () => {
    expect(parseReceiptText('تم التحويل بنجاح\n[unreadable]\nمن\n[unreadable]\nإلى\n[unreadable]\n١ جنيه').amount).toBeNull();
    expect(parseReceiptText('٥ جنيه').amount).toBe(5);
  });
  it('rejects an amount broken into separate digits', () => {
    expect(parseReceiptText('0 0 4 جنيه').amount).toBeNull();
  });
  it('a wallet transaction panel supports its amount without a textual success heading', () => {
    expect(parseReceiptText('400.00 جنيه\nتكلفة المعاملة 2.00 جنيهات\nنوع العملية\nتحويل أموال',true).amount).toBe(400);
    expect(parseReceiptText('400.00 جنيه\nتكلفة المعاملة 2.00 جنيهات\nنوع العملية\nتحويل أموال').pattern).toBe('wallet-app');
  });
  it('extra symbols misread before EGP cannot hide the amount', () => {
    expect(parseReceiptText('500¢€ecp').amount).toBe(500);
    expect(parseReceiptText('500€EGP').amount).toBe(500);
  });
  it('decorative success-icon digits do not override a currency-anchored amount', () => {
    const r = mergeReceiptPasses([
      parseReceiptText('Transaction Successful\n2\nsender@instapay\nreceiver@instapay'),
      parseReceiptText('Transaction Successful\n680 ep\nsender@instapay\nreceiver@instapay'),
    ]);
    expect(r.amount).toBe(680);
  });
  it('requires a currency anchor for a one-digit amount near the success graphic', () => {
    expect(parseReceiptText('Transaction Successful\n9\nsender@instapay\nreceiver@instapay').amount).toBeNull();
    expect(parseReceiptText('Transaction Successful\n5 EGP').amount).toBe(5);
  });

  it.each(['500 €cP', '700 ecp', '680 ep', '500 cp'])('reads pale EGP OCR variant %s', text => {
    expect(parseReceiptText(text).amount).toBe(Number(text.split(' ')[0]));
  });

  it('reads the InstaPay → wallet receipt whose orange EGP OCR returns as «cp» (#3018)', () => {
    const text = '«© © | 500 cp\ni.\nAsha!\n=\nnada2501@instapay\nv\nالمحفظة الالكترونية\n343636563643\n09 Nov 2026 06:32 PM\nنفقات المعيشة';
    expect(parseReceiptText(text).amount).toBe(500);
  });
  it('does not treat a free-standing «cp» word as a currency', () => {
    expect(parseReceiptText('cp 12\nsender@instapay').amount).toBeNull();
  });

  // ── Nov 9, 2026 — real Vodafone Cash / USSD receipts; text is the exact OCR output ──
  it('never takes the fee read just before its «الرسوم» label (Vodafone Cash app, 1600 read as «0 0 6 1»)', () => {
    const text = 'ثم بنجاج\nتم التحويل بنجاح\n0 0 6 1 جنيه\nمبلغ التحويل\nمل\n01001110017\n01008835 575 5\n1 جنيه\nالرسوم\n1 جنيه\nالمبلغ اللي المستحق\n08 سبتمبر 2026 01:20\nتاريخ العملية\n023485673449\nرقم العملية';
    expect(parseReceiptText(text).amount).toBeNull();
    expect(parseReceiptText(text).method).toBe(W);
  });
  it('a currency figure followed by «المستحق» / «الإجمالي» alone is the total, not the transfer', () => {
    expect(parseReceiptText('تم الدفع بنجاح\n1271 جنيه\nالإجمالي').amount).toBeNull();
    expect(parseReceiptText('تم الدفع بنجاح\n1601 جنيه\nالمبلغ الكلي المستحق').amount).toBeNull();
  });
  it('InstaPay\'s own «المبلغ الإجمالي المحول» label still anchors the amount', () => {
    expect(parseReceiptText('تمت العملية بنجاح\n500 EGP\nالمبلغ الإجمالي المحول\nnada@instapay').amount).toBe(500);
  });
  it.each([
    ['digits glued to ©, and a garbled phone (٤٠٠ read as 8800)', 'تم\nتم تحويل 8800© جنبيه انين 001/0 ١٠٠١/0/1'],
    ['a figure glued to a bracket (١٢٧١ read as «)1»)', 'تم الدفع\nالا)1 جنيه'],
    ['a decimal point with no integer (٤٠٠ read as «.88»)', 'تم تحويل .88 جنيه ني م لادد'],
    ['a figure glued to «+:» (half-size misread)', 'تم تحويل +:86 جنيه ابي 661/0 1/81'],
  ])('a line of misread Arabic-Indic digits suggests no amount: %s', (_label, text) => {
    expect(parseReceiptText(text).amount).toBeNull();
  });
  it('the wallet popup «تم تحويل … جنيه الي …» names the Vodafone Cash vault even when its figure is unreadable', () => {
    const r = parseReceiptText('تم\nتم تحويل 8800© جنبيه انين 001/0 ١٠٠١/0/1');
    expect(r).toMatchObject({ amount: null, method: W, pattern: 'wallet-app' });
    expect(parseReceiptText('تم تحويل 8800© جنيه إلى حساب').method).not.toBe(W);
  });
  it('the Vodafone Cash app labels name the vault when its Arabic-Indic phone is unreadable', () => {
    const text = 'lela تم الدفع ag)\n٠١ )اجنيه\nاجمالي المبلغ\nملا\n٠.9 1//01010\nالرسوم\narin |\nالإجمالي\nالا)ا جنيه\nرقم العملية\n0169110\nتاريخ العملية';
    expect(parseReceiptText(text)).toMatchObject({ amount: null, method: W, pattern: 'wallet-app' });
  });
  it('the dark USSD dialog, once read, gives the amount and the vault', () => {
    expect(parseReceiptText('ثم تحويل 2000 جنيه لرقم 01008835575 مصاريف\nالخدمة 1 جنيه . اطلب 9#* و')).toMatchObject({ amount: 2000, method: W, pattern: 'ussd' });
  });

  it.each(['600 tcp', '500 cece'])('reads the orange-EGP misreading %s right after the figure', text => {
    expect(parseReceiptText(`Your transaction was successful\n${text}\nnancy@instapay\nMobile Wallet`).amount).toBe(Number(text.split(' ')[0]));
  });
  it('«تحويل اموال» marks the Vodafone Cash app receipt', () => {
    expect(parseReceiptText('0 جنيه\n01211449112\nMohamed F |\n01008835575\nتحويل اموال\n04 أكتوير 2026')).toMatchObject({ amount: null, method: W, pattern: 'wallet-app' });
  });

  it('still rejects conflicting currency-anchored amounts', () => {
    expect(mergeReceiptPasses([parseReceiptText('500 EGP'), parseReceiptText('5000 EGP')]).amount).toBeNull();
  });

  it('uses a labelled recipient handle when the sender is censored', () => {
    expect(parseReceiptText('Transaction Successful\n500 EGP\nFrom\n[censored]\nTo\nreceiver@instapay\nMore Details').method).toBe('Instapay');
  });
  it('recognizes a spaced InstaPay destination on the To line', () => {
    const receipt = 'Approved Transaction\n1,000 EGP\nTransfer Amount\nFrom\n[censored]\nTo: vkswr3420 @ insta pay\nFees\n1 EGP\nTotal Amount\n1,001 EGP';
    expect(parseReceiptText(receipt)).toMatchObject({ amount: 1000, method: 'Instapay', confident: true });
  });
  it('reads a recipient handle whose @ a black/white pass doubled (Nov 2026, #3040)', () => {
    const receipt = 'Your transaction was successful\n200 ecp\nTransfer Amount\nFrom\nbasmalaasabry@instapay\nTo\nvkswr3420@@instapay\nMore Details +';
    expect(parseReceiptText(receipt)).toMatchObject({ amount: 200, method: 'Instapay', pattern: 'instapay' });
  });
  it('does not use an InstaPay fee-inclusive total when the transfer figure is unreadable', () => {
    const receipt = 'Approved Transaction\nTransfer Amount\nFrom\n[censored]\nTo: vkswr3420 @ insta pay\nFees\n1 EGP\nTotal Amount\n1,001 EGP';
    expect(parseReceiptText(receipt)).toMatchObject({ amount: null, method: 'Instapay', confident: false });
  });
  it('a handle in a receipt note cannot supply the missing destination', () => {
    expect(parseReceiptText('500 EGP\nFrom\nsender@instapay\nTo\n[unreadable]\nNote\nreceiver@instapay').method).toBe('');
    expect(parseReceiptText('500 EGP\nFrom\nsender@instapay\nTo\n[unreadable]\nNote\nreceiver:a instapay').method).toBe('');
  });

  it('supports a misread separator only in the labelled recipient section', () => {
    expect(parseReceiptText('Your transaction was successful\n710 EGP\nFrom\nsender@instapay\nTo\nreceiver:a instapay').method).toBe('Instapay');
    expect(parseReceiptText('Your transaction was successful\n710 EGP\nFrom\nsender:a instapay').method).toBe('');
  });

  it('a transfer amount label alone does not identify a wallet', () => {
    expect(parseReceiptText('تم التحويل بنجاج\n120 EGP\nمبلغ التحويل\nsender@instapay').method).toBe('');
    expect(parseReceiptText('تم التحويل بنجاج\n120 EGP\nمبلغ التحويل').method).toBe('');
  });
  it('Arabic-Indic digits and thousands separators are normalised', () => {
    expect(normalizeOcrText('تم تحويل ١٬٢٥٠ جنيه')).toContain('1250');
    expect(parseReceiptText('تم تحويل ١٢٥٠ جنيه لرقم ٠١٠٠٨٨٣٥٥٧٥\nمصاريف الخدمة ١ جنيه').amount).toBe(1250);
    expect(parseReceiptText('Your transaction was successful\n2,000 EGP').amount).toBe(2000);
  });

  it('a leading-zero number is never an amount', () => {
    expect(parseReceiptText('تم تحويل 086 جنيه الي 01008835575').amount).toBeNull();
  });

  it('status-bar digits above the heading are ignored', () => {
    const r = parseReceiptText('7%\n4G\n6:51\nYour transaction was successful\n120\nmariam@instapay\nMobile Wallet');
    expect(r.amount).toBe(120);
    expect(r.method).toBe(W);
  });

  it('a fee or total line never supplies the amount', () => {
    expect(parseReceiptText('Fees EGP 1\nTotal Amount deducted EGP 501').amount).toBeNull();
  });

  it('two passes that disagree on the amount give no amount', () => {
    const m = mergeReceiptPasses([
      { amount: 500, method: 'Instapay', pattern: 'instapay', reference: '', dateText: '', confident: true },
      { amount: 5000, method: 'Instapay', pattern: 'instapay', reference: '', dateText: '', confident: true },
    ]);
    expect(m.amount).toBeNull();
    expect(m.confident).toBe(false);
  });

  it('two passes that disagree on the vault give no vault', () => {
    const m = mergeReceiptPasses([
      { amount: 500, method: 'Instapay', pattern: 'instapay', reference: '', dateText: '', confident: true },
      { amount: 500, method: W, pattern: 'instapay', reference: '', dateText: '', confident: true },
    ]);
    expect(m.method).toBe('');
  });

  it('random text yields nothing', () => {
    const r = parseReceiptText('hello world\n12:30\nBattery 80%');
    expect(r.amount).toBeNull();
    expect(r.method).toBe('');
  });
});
