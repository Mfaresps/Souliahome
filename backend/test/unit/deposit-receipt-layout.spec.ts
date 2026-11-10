import { parseReceiptRecognition } from '../../src/shopify/deposit-receipt-layout.util';

function page(rows: Array<[string, number, number?]>) {
  const lines = rows.map(([text, y, confidence]) => ({ text, confidence,
    bbox: { x0: 10, x1: 220, y0: y, y1: y + 15 },
    words: [{ text, confidence }] }));
  return { text: rows.map(row => row[0]).join('\n'), blocks: [{ paragraphs: [{ lines }] }] };
}

describe('receipt amount extraction from OCR text and layout', () => {
  it('confidently reads 300 جنيه when OCR splits the pictured wallet amount across lines', () => {
    const result = parseReceiptRecognition(page([
      ['300.00', 60, 93], ['جنيه', 82, 92], ['تكلفة المعاملة 1.50 جنيهات', 110, 90],
      ['من', 165], ['01275030836', 190], ['إلى', 230], ['01008835575', 250],
      ['رقم العملية', 400], ['25000143088423', 425],
    ]));
    expect(result).toMatchObject({ amount: 300, method: 'فودافون كاش',
      senderPhone: '01275030836', reference: '25000143088423', confident: true });
  });
  it('associates the top Arabic amount with إجمالي المبلغ before sender details', () => {
    const result = parseReceiptRecognition(page([
      ['لقد تم الدفع بنجاح!', 10], ['إجمالي المبلغ', 30], ['١٬٢٧٠ جنيه', 50, 92],
      ['من', 90], ['٠١٠٩٧٨٥٣١٥٨', 110], ['إلى', 145], ['٠١٠٠٨٨٣٥٥٧٥', 165],
      ['الرسوم', 210], ['١ جنيه', 230], ['الإجمالي', 250], ['١٬٢٧١ جنيه', 270],
    ]));
    expect(result).toMatchObject({ amount: 1270, method: 'فودافون كاش', confident: true });
  });
  it('extracts a labelled amount from text when Tesseract omits boxes', () => {
    const result = parseReceiptRecognition({ text: 'InstaPay\nTransfer Amount: ۱۲۵۰\nFees 5 EGP\nsender@instapay\nreceiver@instapay', blocks: null });
    expect(result).toMatchObject({ amount: 1250, method: 'Instapay', confident: true });
  });

  it('keeps the transfer when the Fees / Total labels are lost: amount + fee = total (InstaPay Send Money, Nov 2026)', () => {
    // Exact English-pass lines of the real receipt; the receiver address was too faint to read.
    const result = parseReceiptRecognition(page([
      ['Approved Transaction', 10], ['0,', 40], ['1,000 cp', 70, 91], ['(7) Send Money', 95],
      ['@', 130], ['Sab sas Dla aul pia', 150], ['@ ad', 190], ['Send Money', 230],
      ['1 EGP', 330, 90], ['1,001 EGP', 370, 90], ['Back', 420],
    ]));
    expect(result).toMatchObject({ amount: 1000, method: 'Instapay', pattern: 'instapay' });
  });
  it('never reads «م7006» as 7006: the orange EGP glued to 700 as «م» + «6» (Nov 2026, #3078)', () => {
    // Exact Arabic-pass lines; «مبلغ التحويل» right under it used to anchor the wrong figure.
    const result = parseReceiptRecognition(page([
      ['معاملة ناجحة', 10], ['تم التحويل بنجاح', 40], ['م7006', 70, 91], ['مبلغ التحويل', 95],
      ['zahrsayasser2024@instapay', 150], ['vkswr3420@instapay', 230],
    ]));
    expect(result.amount).toBeNull();
    expect(result.method).toBe('Instapay');
    expect(result.confident).toBe(false);
  });
  it('a phone glued to «لرقم» is not mistaken for the glued EGP', () => {
    const result = parseReceiptRecognition({ text: 'تم تحويل 500 جنيه لرقم01008835575 مصاريف الخدمة 1 جنيه', blocks: null });
    expect(result.amount).toBe(500);
  });
  it('the amount + fee = total rule never invents a figure: two unrelated amounts stay a conflict', () => {
    const result = parseReceiptRecognition(page([
      ['Approved Transaction', 10], ['500 EGP', 70, 94], ['700 EGP', 110, 94], ['1 EGP', 150, 94],
    ]));
    expect(result.amount).toBeNull();
  });
  it('reads «مدع» before the figure as EGP (Arabic model on the orange currency)', () => {
    const result = parseReceiptRecognition(page([
      ['Approved Transaction', 10], ['مدع 1,000', 70, 90], ['Send Money', 95], ['1 EGP', 330], ['1,001 EGP', 370],
    ]));
    expect(result).toMatchObject({ amount: 1000, method: 'Instapay' });
  });

  it('uses transfer amount and ignores a later fee-inclusive total in an InstaPay receipt', () => {
    const result = parseReceiptRecognition(page([
      ['Approved Transaction', 10], ['1,000 EGP', 70, 94], ['Transfer Amount', 90],
      ['From', 130], ['censored', 150], ['To: vkswr3420 @ insta pay', 190],
      ['Fees', 310], ['1 EGP', 330], ['Total Amount', 350], ['1,001 EGP', 370, 96],
    ]));
    expect(result).toMatchObject({ amount: 1000, method: 'Instapay', confident: true });
  });

  it('leaves the amount empty if only the fee-inclusive total has a readable currency', () => {
    const result = parseReceiptRecognition(page([
      ['Approved Transaction', 10], ['Transfer Amount', 90], ['From', 130],
      ['To: vkswr3420 @ insta pay', 190], ['Fees', 310], ['1 EGP', 330],
      ['Total Amount', 350], ['1,001 EGP', 370, 96],
    ]));
    expect(result).toMatchObject({ amount: null, method: 'Instapay', confident: false });
  });

  it('rejects conflicting transfer labels without bounding boxes', () => {
    const result = parseReceiptRecognition({ text: 'InstaPay\nTransfer Amount: 500 EGP\nTransfer Amount: 600 EGP\nsender@instapay\nreceiver@instapay', blocks: null });
    expect(result.amount).toBeNull();
    expect(result.confident).toBe(false);
  });

  it('marks a low confidence whole-page reading for manual validation', () => {
    const result = parseReceiptRecognition({ text: 'Transfer Amount 500 EGP\nsender@instapay\nreceiver@instapay',
      confidence: 22, blocks: null });
    expect(result).toMatchObject({ amount: 500, confident: false });
    expect(result.amountConfidence).toBeLessThan(.7);
  });

  it('normalizes Arabic and Persian digits with Arabic grouping', () => {
    const result = parseReceiptRecognition(page([
      ['InstaPay', 10], ['مبلغ التحويل', 30], ['١٬۲۵۰ جنيه', 50, 92],
      ['رسوم الخدمة ٥ جنيه', 80], ['رقم العملية ١٢٣٤٥٦٧٨٩٠١٢', 110],
      ['sender@instapay', 130], ['receiver@instapay', 150],
    ]));
    expect(result).toMatchObject({ amount: 1250, method: 'Instapay', confident: true });
    expect(result.amountConfidence).toBeGreaterThanOrEqual(.7);
  });

  it('uses a nearby transfer label and ignores fees, dates, phone numbers, and references', () => {
    const result = parseReceiptRecognition(page([
      ['money transferred', 10], ['750', 30, 94], ['fees 12 EGP', 50],
      ['01012345678', 70], ['08/11/2026', 90], ['reference 123456789012', 110],
    ]));
    expect(result.amount).toBe(750);
    expect(result.amountConfidence).toBeGreaterThanOrEqual(.7);
  });

  it('does not discard a valid transfer merely because it resembles a year', () => {
    const result = parseReceiptRecognition(page([
      ['Transfer amount 2026 EGP', 10, 95], ['sender@instapay', 30], ['receiver@instapay', 50],
      ['transaction date 08/11/2026', 80],
    ]));
    expect(result.amount).toBe(2026);
    expect(result.confident).toBe(true);
  });

  it('does not link a distant amount to a transfer label', () => {
    const result = parseReceiptRecognition(page([
      ['transfer amount', 10], ['500', 400, 90], ['sender@instapay', 430], ['receiver@instapay', 450],
    ]));
    expect(result.amount).toBeNull();
    expect(result.confident).toBe(false);
  });

  it('rejects a low confidence amount even when its label is clear', () => {
    const result = parseReceiptRecognition(page([
      ['transfer amount 500 EGP', 10, 15], ['sender@instapay', 30], ['receiver@instapay', 50],
    ]));
    expect(result.amount).toBe(500);
    expect(result.confident).toBe(false);
    expect(result.amountConfidence).toBeLessThan(.7);
  });

  it('leaves conflicting transfer figures unselected', () => {
    const result = parseReceiptRecognition(page([
      ['transfer amount 500 EGP', 10, 93], ['transfer amount 600 EGP', 35, 90],
      ['sender@instapay', 60], ['receiver@instapay', 80],
    ]));
    expect(result.amount).toBeNull();
    expect(result.confident).toBe(false);
  });

  it('reads only a standalone clock near the top as screenshot time', () => {
    const result = parseReceiptRecognition(page([
      ['9:06', 3], ['120 EGP', 40, 90], ['sender@instapay', 60], ['Mobile Wallet', 80],
      ['transaction date 13:55:09', 130],
    ]));
    expect(result).toMatchObject({ amount: 120, screenshotTime: '09:06' });
  });
});
