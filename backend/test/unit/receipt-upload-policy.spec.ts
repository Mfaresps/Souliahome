import sharp from 'sharp';
import { randomBytes } from 'crypto';
import { compressReceipt, MAX_STORED_RECEIPT_BYTES, receiptContentWarnings } from '../../src/shopify/receipt-upload-policy.util';

describe('receipt upload protection', () => {
  it('compresses a large detailed image below the hard limit without changing its input', async () => {
    const input = await sharp(randomBytes(2000 * 1500 * 3), { raw: { width: 2000, height: 1500, channels: 3 } }).png().toBuffer();
    const copy = Buffer.from(input);
    const stored = await compressReceipt(input);
    const meta = await sharp(stored).metadata();
    expect(stored.length).toBeLessThanOrEqual(MAX_STORED_RECEIPT_BYTES);
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeGreaterThanOrEqual(1000);
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(input.equals(copy)).toBe(true);
  });

  it('keeps small screenshots small and removes private metadata', async () => {
    const input = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#fff' } })
      .withMetadata().png().toBuffer();
    const output = await compressReceipt(input);
    const meta = await sharp(output).metadata();
    expect([meta.width, meta.height]).toEqual([400, 800]);
    expect(meta.exif).toBeUndefined();
    expect(output.length).toBeLessThan(20 * 1024);
  });

  it('rejects fake files, disguised SVG and excessive decoded dimensions', async () => {
    await expect(compressReceipt(Buffer.from('not an image'))).rejects.toThrow();
    await expect(compressReceipt(Buffer.from('<svg width="100" height="100"></svg>'))).rejects.toThrow();
    const huge = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(compressReceipt(huge)).rejects.toThrow();
  });

  it('distinguishes missing transfer indicators from analysis failure', () => {
    expect(receiptContentWarnings({ ran: true, pattern: '' })).toEqual([{ code: 'not-transfer', orderRef: '' }]);
    expect(receiptContentWarnings({ ran: false, pattern: '' })).toEqual([{ code: 'ocr-unavailable', orderRef: '' }]);
    expect(receiptContentWarnings({ ran: true, pattern: 'instapay' })).toEqual([]);
    expect(receiptContentWarnings({ ran: true, pattern: 'wallet-app' })).toEqual([]);
  });
});
