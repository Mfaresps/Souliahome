import sharp from 'sharp';
import { normalizeOcrText, parseReceiptText } from '../../src/shopify/deposit-receipt-parser.util';
import { ARABIC_MESSAGE_DIGITS } from '../../src/shopify/receipt-digit-templates';
import { readArabicMessageAmount } from '../../src/shopify/receipt-digit.util';
import { walletUssdFigure, walletMessageAmount, walletUssdContext } from '../../src/shopify/receipt-wallet.util';

const wallet = 'فودافون كاش';
const line = (text: string, y = 200, words?: any[]) => ({ text, bbox: { x0: 20, y0: y, x1: 370, y1: y + 20 }, words });
const page = (lines: ReturnType<typeof line>[]) => ({ text: lines.map(l => l.text).join('\n'), blocks: [{ paragraphs: [{ lines }] }] });
const word = (text: string, x: number) => ({ text, bbox: { x0: x, y0: 200, x1: x + 40, y1: 220 }, confidence: 95 });

describe('wallet destination and currency labels', () => {
  it.each(['Mobile Wallet', 'MOBILE WALLT', 'Mobile Walet', 'المحفظة الإلكترونية', 'المحفظه الالكترونيه'])(
    'routes an InstaPay receipt to the destination vault: %s', destination => {
      expect(parseReceiptText(`500 EGP\nFrom\nsender@instapay\nTo ${destination}\n01012345678`))
        .toMatchObject({ amount: 500, pattern: 'instapay', method: wallet });
    });

  it('does not treat a wallet in the sender section as the recipient vault', () => {
    expect(parseReceiptText('500 EGP\nFrom Mobile Wallet\nsender@instapay\nTo Instapay\nreceiver@instapay').method).toBe('Instapay');
  });

  it('does not let a note mentioning a wallet change the destination', () => {
    expect(parseReceiptText('500 EGP\nFrom\nsender@instapay\nTo Instapay\nreceiver@instapay\nNote\nMobile Wallet').method).toBe('Instapay');
  });

  it.each(['500 جنيه', '500 جنية', 'EGP 500', '500 EGP', '500 ج.م.', 'ج.م. 500', '٥٠٠ جنيه'])(
    'reads the currency anchor %s and excludes the later fee/total', amount => {
      expect(parseReceiptText(`${amount}\nFrom\n01011112222\nTo Mobile Wallet\n01012345678\nFees 1 EGP\nTotal Amount deducted 501 EGP`).amount).toBe(500);
    });

  it('reads a bank-wallet payment label without choosing the fee-inclusive total', () => {
    expect(parseReceiptText('قيمة الدقع:\n500.00\nمن حساب محفظة بنك\n01111112222\nالى محفظة رقم\n01012345678\nتكلفة العملية 2.50\nإجمالي الدفع 502.50'))
      .toMatchObject({ amount: 500, method: wallet, amountSource: 'sentence' });
  });

  it.each(['طريقة الدفع\nمحفظتى', 'محفظتى\nطريقة الدفع'])(
    'recognises the bank-wallet payment method in either RTL line order', labels => {
      expect(parseReceiptText(labels).method).toBe(wallet);
    });

  it('recognises the observed typo in the primary amount label', () => {
    expect(parseReceiptText('لقد تم الدفع بنجام!\n٢٠٠ جنيه\nاجمالي المبلع\nمن\n01011112222\nالى\n01012345678\nالرسوم\n١ جنيه\nالإجمالي\n٢٠١ جنيه'))
      .toMatchObject({ amount: 200, method: wallet });
  });

  it('does not read the Egyptian currency OCR prefix as a second figure in a known wallet layout', () => {
    expect(parseReceiptText('p.2 500.00\n01211112222', true).amount).toBe(500);
    expect(parseReceiptText('p.2 500.00\n01211112222').amount).toBeNull();
  });

  it('normalises Arabic grouping and decimal separators before extracting numbers', () => {
    expect(normalizeOcrText('١٬٥٠٠٫٥٠ جنيه')).toBe('1500.50 جنيه');
  });
});

async function messageInk(digits: string): Promise<Buffer> {
  let left = 10; const overlays = [];
  for (const digit of digits) {
    const template = ARABIC_MESSAGE_DIGITS.find(t => t.digit === digit)!;
    const height = Math.round(template.relativeHeight * 90), width = Math.round(template.aspect * height);
    const input = await sharp(Buffer.from([...template.pixels].map(p => p === '1' ? 0 : 255)), { raw: { width: 16, height: 24, channels: 1 } })
      .resize(width, height, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
    overlays.push({ input, left, top: 100 - height }); left += width + 12;
  }
  return sharp({ create: { width: left + 10, height: 120, channels: 3, background: 'white' } }).composite(overlays).png().toBuffer();
}

describe('isolated wallet figures', () => {
  it.each(['50', '55', '500', '5000'])('reads new combinations of learned message glyphs: %s', async digits => {
    expect(await readArabicMessageAmount(await messageInk(digits))).toBe(Number(digits));
  });

  it('rejects leading zeroes instead of suggesting a truncated amount', async () => {
    expect(await readArabicMessageAmount(await messageInk('0500'))).toBeNull();
  });

  it('takes a short transfer figure beside a complete phone, excluding fees and reference ids', () => {
    expect(walletUssdFigure(page([line('01012345678 abc 500', 200, [word('01012345678', 20), word('500', 200)]),
      line('Fee 1', 250, [word('1', 250)]), line('123456789012', 300, [word('123456789012', 20)])]))?.value).toBe(500);
  });

  it('refuses two plausible figures on the recipient-phone line', () => {
    expect(walletUssdFigure(page([line('01012345678 500 600', 200,
      [word('01012345678', 20), word('500', 200), word('600', 260)])]))).toBeNull();
  });

  it('never learns a message amount from a recipient phone or fee alone', async () => {
    const image = await messageInk('500');
    expect(await walletMessageAmount(image, page([line('الى 01012345678', 20), line('مصاريف الخدمة 1 جنيه', 40)]))).toBeNull();
  });

  it('requires both fee and More anchors before cropping a photographed dialog', async () => {
    const image = await sharp({ create: { width: 400, height: 800, channels: 3, background: 'white' } }).png().toBuffer();
    expect(await walletUssdContext(image, page([line('مصاريف', 400)]))).toBeNull();
    const crop = await walletUssdContext(image, page([line('مصاريف', 400), line('0:مزيد', 450)]));
    expect(crop).not.toBeNull();
    expect((await sharp(crop!).metadata()).width).toBe(1200);
  });
});
