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

  it('extracts the 12-digit transfer reference (used to warn on a reused receipt)', () => {
    expect(both(5).reference).toBe('700000000002');
    expect(both(9).reference).toBe('020000000005');
  });
});

describe('rules on synthetic text', () => {
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

  it.each(['500 €cP', '700 ecp', '680 ep'])('reads pale EGP OCR variant %s', text => {
    expect(parseReceiptText(text).amount).toBe(Number(text.split(' ')[0]));
  });

  it('still rejects conflicting currency-anchored amounts', () => {
    expect(mergeReceiptPasses([parseReceiptText('500 EGP'), parseReceiptText('5000 EGP')]).amount).toBeNull();
  });

  it('uses a labelled recipient handle when the sender is censored', () => {
    expect(parseReceiptText('Transaction Successful\n500 EGP\nFrom\n[censored]\nTo\nreceiver@instapay\nMore Details').method).toBe('Instapay');
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
