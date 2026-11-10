import sharp from 'sharp';
import { InstapayLayout, parseInstapayLayout, prepareInstapayLayout, instapayReferenceBox, instapayAmountImage, verifiedInstapayReference } from '../../src/shopify/receipt-instapay.util';

const layout: InstapayLayout = { image: Buffer.alloc(0), original: Buffer.alloc(0), width: 1000, height: 1800,
  amountTop: 200, amountBottom: 300, divider: 700 };
const line = (text: string, y: number, confidence = 95) => ({ text, confidence,
  bbox: { x0: 100, y0: y, x1: 600, y1: y + 25 }, words: [{ text, confidence }] });
const page = (lines: ReturnType<typeof line>[]) => ({ text: lines.map(l => l.text).join('\n'),
  blocks: [{ paragraphs: [{ lines }] }] });
const normal = () => [line('Transaction Successful', 100), line('1,000 EGP', 240),
  line('sender.test@instapay', 500), line('receiver.test@instapay', 820),
  line('Reference', 1050), line('123456789012', 1100), line('Date 09 Nov 2026 01:13 PM', 1200)];

describe('InstaPay relative receipt anchors', () => {
  it('reads sender before the divider, not the recipient, fees or total', () => {
    const data = page([...normal(), line('Fees 1 EGP', 950), line('Total Amount 1,001 EGP', 1000)]);
    expect(parseInstapayLayout(data, layout)).toMatchObject({ amount: 1000, senderHandle: 'sender.test@instapay',
      method: 'Instapay', reference: '123456789012', dateText: '09 Nov 2026 01:13 PM' });
    expect(instapayReferenceBox(data, layout)?.y0).toBe(1100);
  });

  it('uses geometry when Arabic labels cannot be read by the English model', () => {
    const lines = normal(); lines[0] = line('POWERED BY', 1600); lines[1] = line('300¢€eGP', 240);
    expect(parseInstapayLayout(page(lines), layout)).toMatchObject({ amount: 300, senderHandle: 'sender.test@instapay' });
  });

  it('accepts an OCR parenthesis adjacent to @ without changing the address', () => {
    const lines = normal(); lines[2] = line('sender.test(@instapay', 500);
    expect(parseInstapayLayout(page(lines), layout)?.senderHandle).toBe('sender.test@instapay');
  });

  it('does not promote the recipient when the sender is missing or censored', () => {
    expect(parseInstapayLayout(page(normal().filter(l => !l.text.startsWith('sender'))), layout)).toBeNull();
  });

  it('rejects multiple sender addresses and multiple figures in the amount band', () => {
    expect(parseInstapayLayout(page([...normal(), line('other@instapay', 560)]), layout)).toBeNull();
    expect(parseInstapayLayout(page([...normal(), line('500', 260)]), layout)).toBeNull();
  });

  it('requires receipt branding as well as image anchors', () => {
    expect(parseInstapayLayout(page(normal().slice(1)), layout)).toBeNull();
  });

  it('keeps absent details empty and never treats a recipient phone as a reference', () => {
    const lines = normal().slice(0, 4).concat(line('01012345678', 900));
    expect(parseInstapayLayout(page(lines), layout)).toMatchObject({ reference: '', dateText: '' });
    expect(instapayReferenceBox(page(lines), layout)).toBeNull();
  });

  it('refuses an ambiguous reference instead of picking one of two ids', () => {
    expect(instapayReferenceBox(page([...normal(), line('987654321098', 1150)]), layout)).toBeNull();
  });

  it('requires two confident reference readings, with a third chance for a compressed image', () => {
    const good = { text: '123456789012', confidence: 95 };
    expect(verifiedInstapayReference([good, { ...good, confidence: 67 }])).toBe('');
    expect(verifiedInstapayReference([good, { ...good, confidence: 67 }, good])).toBe(good.text);
    expect(verifiedInstapayReference([good, { text: '123456789512', confidence: 95 }])).toBe('');
    expect(verifiedInstapayReference([good, { text: '01012345678', confidence: 95 }])).toBe('');
    expect(verifiedInstapayReference([good, { ...good, confidence: NaN }])).toBe('');
  });

  it('keeps the status-bar clock separate from the transaction date', () => {
    expect(parseInstapayLayout(page([line('5:23', 10), ...normal()]), layout)).toMatchObject({
      screenshotTime: '05:23', dateText: '09 Nov 2026 01:13 PM' });
  });

  it('does not activate on an ordinary blank or wallet screenshot', async () => {
    const blank = await sharp({ create: { width: 400, height: 800, channels: 3, background: 'white' } }).png().toBuffer();
    expect(await prepareInstapayLayout(blank)).toBeNull();
  });

  it('isolates the dark amount when a clipped success heading touches the crop edge', async () => {
    const original = await sharp({ create: { width: 400, height: 800, channels: 3, background: 'white' } })
      .composite([{ input: Buffer.from('<svg width="400" height="800"><path d="M60 81h260v2H60z M150 105h80v30h-80z"/></svg>') }])
      .png().toBuffer();
    const mask = await instapayAmountImage({ ...layout, original, amountTop: 200, amountBottom: 350 });
    const { data, info } = await sharp(mask).grayscale().raw().toBuffer({ resolveWithObject: true });
    const firstInk = data.findIndex(v => v < 128);
    expect(Math.floor(firstInk / info.width)).toBe(12);
    expect(info.height).toBe(124);
  });
});
