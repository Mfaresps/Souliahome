import sharp from 'sharp';
import { Box, OcrPage } from './deposit-receipt-layout.util';
import { normalizeOcrText } from './deposit-receipt-parser.util';
import { readArabicMessageAmount } from './receipt-digit.util';
import { instapayLines } from './receipt-instapay.util';

/** Crop an OCR word in that recognition's coordinate system, with room for its edge strokes. */
export async function walletWordImage(image: Buffer, box: Box): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const pad = Math.max(3, Math.ceil((box.y1 - box.y0) * .2));
  const left = Math.max(0, box.x0 - pad), top = Math.max(0, box.y0 - pad);
  const right = Math.min(meta.width!, box.x1 + pad), bottom = Math.min(meta.height!, box.y1 + pad);
  return sharp(image).extract({ left, top, width: right - left, height: bottom - top })
    .resize({ height: 120 }).grayscale().normalise().png().toBuffer();
}

/** A transfer sentence anchors the glyphs; never learn digits from a phone, fee or whole screenshot. */
export async function walletMessageAmount(image: Buffer, page: OcrPage): Promise<number | null> {
  for (const line of instapayLines(page)) {
    if (!/تحو[يبى]ل/.test(line.text) || !/جني[هھة]/.test(line.text) || /مصاريف|رسوم/.test(line.text)) continue;
    const words = line.words || [];
    const anchor = words.findIndex(word => /تحو[يبى]ل/.test(word.text));
    const number = words[anchor + 1];
    if (anchor < 0 || !number?.bbox || !/^\d{2,7}$/.test(normalizeOcrText(number.text).trim())) continue;
    const crop = await walletWordImage(image, number.bbox);
    const readings = await Promise.all([150, 170].map(level => sharp(crop).threshold(level).png().toBuffer().then(readArabicMessageAmount)));
    if (readings[0] != null && readings[0] === readings[1]) return readings[0];
  }
  return null;
}

/** A photographed USSD dialog may be too dim to form a white connected component.
 * Its fee and More labels anchor a small text region, avoiding screen glare and keyboards.
 */
export async function walletUssdContext(image: Buffer, page: OcrPage): Promise<Buffer | null> {
  const lines = instapayLines(page);
  const fee = lines.find(line => /مصاريف/.test(line.text));
  const more = lines.find(line => /مزيد/.test(line.text));
  if (!fee?.bbox || !more?.bbox || more.bbox.y0 <= fee.bbox.y0) return null;
  const meta = await sharp(image).metadata();
  const height = Math.max(12, fee.bbox.y1 - fee.bbox.y0);
  const top = Math.max(0, fee.bbox.y0 - height * 6);
  const bottom = Math.min(meta.height!, more.bbox.y1 + height * 2);
  return sharp(image).extract({ left: Math.floor(meta.width! * .05), top,
    width: Math.floor(meta.width! * .9), height: bottom - top })
    .resize({ width: 1200 }).grayscale().normalise().png().toBuffer();
}

/** Only a short figure on the same line as a complete recipient phone is eligible. */
export function walletUssdFigure(page: OcrPage): { value: number; box: Box } | null {
  const candidates = instapayLines(page).filter(line => /(?<!\d)01\d{9}(?!\d)/.test(normalizeOcrText(line.text)))
    .flatMap(line => (line.words || []).filter(word => word.bbox && /^[1-9]\d{1,6}(?:\.\d{1,2})?$/.test(normalizeOcrText(word.text).trim())));
  if (candidates.length !== 1) return null;
  return { value: Number(normalizeOcrText(candidates[0].text).trim()), box: candidates[0].bbox! };
}
