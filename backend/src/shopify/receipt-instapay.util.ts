import sharp from 'sharp';
import { Box, OcrLine, OcrPage } from './deposit-receipt-layout.util';
import { normalizeOcrText, ParsedReceipt, parseReceiptText } from './deposit-receipt-parser.util';
import { recognizeEgyptianBankName } from './egyptian-bank-names.util';
import { parseScreenClock } from './receipt-screen-time.util';

/** Coordinates belong to the prepared image, never to a particular phone or sample. */
export interface InstapayLayout {
  image: Buffer;
  original: Buffer;
  width: number;
  height: number;
  amountTop: number;
  amountBottom: number;
  divider: number;
}

function bands(rows: number[]): Array<{ top: number; bottom: number }> {
  const result: Array<{ top: number; bottom: number }> = [];
  for (const y of rows) {
    const previous = result[result.length - 1];
    if (previous && y - previous.bottom <= 3) previous.bottom = y;
    else result.push({ top: y, bottom: y });
  }
  return result;
}

/** Orange currency + green success graphic + green section divider + purple footer.
 * The relative anchors cover both receipt generations, Arabic/English and cropped screenshots.
 * A colour alone is never sufficient to activate this path; recognition must confirm it too.
 */
export async function prepareInstapayLayout(input: Buffer): Promise<InstapayLayout | null> {
  const original = await sharp(input).rotate().png().toBuffer();
  const { data, info } = await sharp(original).resize({ width: 400 }).removeAlpha()
    .toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (height < width || height > width * 4) return null;
  const orangeRows: number[] = [], greenRows: number[] = [];
  let purple = 0;
  for (let y = 0; y < height; y++) {
    let orange = 0, green = 0;
    for (let x = Math.floor(width * .2); x < width * .85; x++) {
      const at = (y * width + x) * channels, r = data[at], g = data[at + 1], b = data[at + 2];
      if (r > 180 && g > 45 && g < 190 && b < 140 && r > g * 1.3 && g > b * 1.2) orange++;
      if (x > width * .45 && x < width * .55 && g > 95 && g > r * 1.25 && g > b * 1.08) green++;
      if (y > height * .7 && b > 55 && b > g * 1.4 && r > g * 1.3) purple++;
    }
    if (orange >= 4) orangeRows.push(y);
    if (green >= 2) greenRows.push(y);
  }
  if (purple < 30) return null;
  const greens = bands(greenRows);
  const candidates = bands(orangeRows).filter(band => band.top > height * .08 && band.bottom < height * .55
    && band.bottom - band.top >= 5 && band.bottom - band.top < height * .08
    && greens.some(g => g.bottom < band.top && band.top - g.bottom < height * .3));
  const amount = candidates[0];
  if (!amount) return null;
  const divider = greens.find(g => g.top > amount.bottom + height * .04 && g.top < height * .8
    && g.bottom - g.top < height * .04);
  if (!divider) return null;
  const image = await sharp(original).resize({ width: 1000 }).grayscale().threshold(215).png().toBuffer();
  const scale = 1000 / width, inkHeight = amount.bottom - amount.top + 1;
  return { image, original, width: 1000, height: Math.round(height * scale),
    amountTop: Math.max(0, (amount.top - inkHeight * .65) * scale),
    amountBottom: (amount.bottom + inkHeight * .25) * scale,
    divider: (divider.top + divider.bottom) / 2 * scale };
}

export function instapayLines(page: OcrPage): OcrLine[] {
  return (page.blocks || []).flatMap(block => [
    ...(block.lines || []), ...(block.paragraphs || []).flatMap(p => p.lines || []),
  ]).filter(line => line.bbox && line.text?.trim())
    .sort((a, b) => a.bbox!.y0 - b.bbox!.y0 || a.bbox!.x0 - b.bbox!.x0);
}

const HANDLE = /[a-z0-9][a-z0-9._+-]*\s*\(?@\s*instapay\b/gi;

export function verifiedInstapayReference(readings: Array<{ text: string; confidence: number }>): string {
  const votes = new Map<string, number>();
  for (const reading of readings) {
    const reference = normalizeOcrText(reading.text).trim();
    if (!/^\d{12}$/.test(reference) || !Number.isFinite(reading.confidence) || reading.confidence < 80) continue;
    votes.set(reference, (votes.get(reference) || 0) + 1);
  }
  const agreed = [...votes].filter(([, count]) => count >= 2);
  return agreed.length === 1 ? agreed[0][0] : '';
}

/** Use the divider to keep a missed sender from becoming the recipient's address. */
export function parseInstapayLayout(page: OcrPage, layout: InstapayLayout): (ParsedReceipt & { screenshotTime?: string }) | null {
  const lines = instapayLines(page);
  const text = page.text || '';
  if (!/\bpowered\b|transaction\s+(?:successful|was successful)|approved\s+transaction/i.test(text)) return null;
  const amountLines = lines.filter(l => l.bbox!.y0 < layout.amountBottom && l.bbox!.y1 > layout.amountTop);
  const figures = amountLines.flatMap(l => {
    const clean = normalizeOcrText(l.text);
    const matches = [...clean.matchAll(/(?<![\d.])(\d{1,7}(?:\.\d{1,2})?)(?![\d.])/g)];
    return matches.filter(m => !m[1].startsWith('0')).map(m => ({ amount: Number(m[1]), line: l }));
  }).filter(c => c.amount >= 1 && c.amount <= 1_000_000);
  if (figures.length !== 1) return null;
  const senderLines = lines.filter(l => l.bbox!.y0 > layout.amountBottom && l.bbox!.y1 < layout.divider);
  const senderHandles = [...new Set(senderLines.flatMap(l => [...l.text.matchAll(HANDLE)]
    .map(m => m[0].replace(/[\s(]/g, '').toLowerCase())))];
  // No sender is safer than quietly using a recipient when a section is censored or unreadable.
  if (senderHandles.length !== 1) return null;
  const recipientLines = lines.filter(l => l.bbox!.y0 > layout.divider);
  const canonical = [
    'Transaction Successful', `${figures[0].amount} EGP`, 'Transfer Amount',
    'From', senderHandles[0],
    /\bto\s+instapay\b/i.test(text) ? 'To Instapay' : 'To',
    ...recipientLines.map(l => l.text),
  ].join('\n');
  const parsed = parseReceiptText(canonical);
  // Word confidence of the actual figure, not confidence in the Arabic labels read as English.
  const line = figures[0].line;
  const numericWords = (line.words || []).filter(w => /\d/.test(w.text));
  const confidence = numericWords.length ? Math.min(...numericWords.map(w => w.confidence ?? 0)) : line.confidence ?? 0;
  const score = confidence / 100;
  const banks = [...new Set(senderLines.map(l => recognizeEgyptianBankName(l.text)).filter(Boolean))];
  const clock = lines.filter(l => l.bbox!.y0 < layout.height * .05)
    .map(l => normalizeOcrText(l.text).trim()).find(t => /^\d{1,2}:\d{2}$/.test(t));
  const screenshotTime = clock ? parseScreenClock(clock) : '';
  return { ...parsed, senderHandle: senderHandles[0], amountConfidence: score,
    ...(banks.length === 1 ? { senderBank: banks[0] } : {}),
    ...(screenshotTime ? { screenshotTime } : {}),
    confident: parsed.amount != null && parsed.method !== '' && score >= .7 };
}

/** Currency ink is orange and above threshold 100; the transfer digits are dark.
 * Read only that band, so large display digits cannot merge with EGP or fee figures.
 */
export async function instapayAmountImage(layout: InstapayLayout): Promise<Buffer> {
  const meta = await sharp(layout.original).metadata();
  const scale = meta.width! / layout.width;
  const top = Math.max(0, Math.floor(layout.amountTop * scale));
  const bottom = Math.min(meta.height!, Math.ceil(layout.amountBottom * scale));
  const mask = await sharp(layout.original).extract({ left: Math.floor(meta.width! * .12), top,
    width: Math.floor(meta.width! * .76), height: bottom - top })
    .grayscale().threshold(100).raw().toBuffer({ resolveWithObject: true });
  const rows: number[] = [];
  for (let y = 0; y < mask.info.height; y++) {
    let ink = 0;
    for (let x = 0; x < mask.info.width; x++) if (mask.data[y * mask.info.width + x] < 128) ink++;
    if (ink >= 3) rows.push(y);
  }
  const figure = bands(rows).sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0];
  if (!figure) throw new Error('No dark transfer figure');
  return sharp(mask.data, { raw: { width: mask.info.width, height: mask.info.height, channels: 1 } })
    .extract({ left: 0, top: figure.top, width: mask.info.width, height: figure.bottom - figure.top + 1 })
    .resize({ height: 100 }).extend({ top: 12, bottom: 12, left: 12, right: 12, background: 'white' })
    .png().toBuffer();
}

/** Locate only a standalone reference below the recipient, never an account or phone number. */
export function instapayReferenceBox(page: OcrPage, layout: InstapayLayout): Box | null {
  const lines = instapayLines(page).filter(l => l.bbox!.y0 > layout.divider);
  const references = lines.filter(l => /^\s*\d{12}\s*$/.test(normalizeOcrText(l.text)));
  if (references.length !== 1) return null;
  return references[0].bbox!;
}

/** Re-read the reference from unthresholded pixels: thresholding can change a 9 into a 5. */
export async function instapayReferenceImage(layout: InstapayLayout, box: Box): Promise<Buffer> {
  const meta = await sharp(layout.original).metadata();
  const scale = meta.width! / layout.width;
  const pad = Math.max(5, (box.y1 - box.y0) * .4);
  const left = Math.max(0, Math.floor((box.x0 - pad) * scale));
  const top = Math.max(0, Math.floor((box.y0 - pad) * scale));
  const right = Math.min(meta.width!, Math.ceil((box.x1 + pad) * scale));
  const bottom = Math.min(meta.height!, Math.ceil((box.y1 + pad) * scale));
  return sharp(layout.original).extract({ left, top, width: right - left, height: bottom - top })
    .resize({ height: 70 }).grayscale().normalise().png().toBuffer();
}

export async function instapayDestinationImage(layout: InstapayLayout): Promise<Buffer> {
  const meta = await sharp(layout.original).metadata();
  const scale = meta.width! / layout.width;
  const top = Math.floor(layout.divider * scale);
  return sharp(layout.original).extract({ left: 0, top, width: meta.width!,
    height: Math.min(meta.height! - top, Math.round(meta.height! * .22)) })
    .resize({ width: 1000 }).grayscale().normalise().png().toBuffer();
}
