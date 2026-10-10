import sharp from 'sharp';

export const MAX_STORED_RECEIPT_BYTES = 180 * 1024;
const MAX_PIXELS = 16_000_000;

/** Decode the actual file, bound memory use, remove metadata and preserve legible receipts. */
export async function compressReceipt(input: Buffer): Promise<Buffer> {
  const options = { failOn: 'error' as const, limitInputPixels: MAX_PIXELS };
  const meta = await sharp(input, options).metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1) {
    throw new Error('Unsupported or animated receipt image');
  }
  for (const side of [1600, 1280, 1000]) {
    for (const quality of [82, 70, 60, 50]) {
      const output = await sharp(input, options).rotate().flatten({ background: '#fff' })
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true }).toBuffer();
      if (output.length <= MAX_STORED_RECEIPT_BYTES) return output;
    }
  }
  throw new Error('Receipt cannot fit the storage limit at readable resolution');
}

/** A warning is evidence for human review, never proof that a transfer is genuine or fake. */
export function receiptContentWarnings(ocr: { ran?: boolean; pattern?: string }):
  Array<{ code: 'not-transfer' | 'ocr-unavailable'; orderRef: string }> {
  if (!ocr.ran) return [{ code: 'ocr-unavailable', orderRef: '' }];
  if (!ocr.pattern) return [{ code: 'not-transfer', orderRef: '' }];
  return [];
}
