import sharp from 'sharp';
import { receiptOcrRegion, receiptTealAmount } from '../../src/shopify/receipt-image.util';

const canvas = (background: string) => sharp({ create: { width: 400, height: 800, channels: 3, background } });
const card = async (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#fafafa' } }).png().toBuffer();

describe('receipt isolation for OCR', () => {
  it('crops a receipt over a dimmed chat, preserving the original buffer', async () => {
    const input = await canvas('#101010').composite([{ input: await card(220, 420), left: 90, top: 250 }]).jpeg().toBuffer();
    const copy = Buffer.from(input);
    const meta = await sharp(await receiptOcrRegion(input)).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(220);
    expect(meta.width).toBeLessThan(250);
    expect(meta.height).toBeGreaterThanOrEqual(420);
    expect(meta.height).toBeLessThan(450);
    expect(input.equals(copy)).toBe(true);
  });
  it('ignores a separate notification above the receipt', async () => {
    const input = await canvas('#101010').composite([
      { input: await card(360, 90), left: 20, top: 20 },
      { input: await card(220, 420), left: 90, top: 250 },
    ]).png().toBuffer();
    expect((await sharp(await receiptOcrRegion(input)).metadata()).height).toBeLessThan(450);
  });
  it('chooses the central dialog instead of a larger keyboard at the bottom', async () => {
    const input = await canvas('#aaa').composite([
      { input: await card(290, 300), left: 55, top: 150 },
      { input: await card(400, 260), left: 0, top: 540 },
    ]).png().toBuffer();
    const meta=await sharp(await receiptOcrRegion(input)).metadata();
    expect(meta.width).toBeLessThan(320);expect(meta.height).toBeLessThan(330);
  });
  it('does not treat a green success mark as a teal amount', async () => {
    const input = await canvas('#fff').composite([
      {input:await sharp({create:{width:90,height:90,channels:3,background:'#00c040'}}).png().toBuffer(),left:155,top:170},
    ]).png().toBuffer();
    expect(await receiptTealAmount(input)).toBeNull();
  });
  it.each(['#fafafa', '#101010'])('keeps full-screen or dark receipts (%s)', async background => {
    const meta = await sharp(await receiptOcrRegion(await canvas(background).png().toBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([400, 800]);
  });
});
