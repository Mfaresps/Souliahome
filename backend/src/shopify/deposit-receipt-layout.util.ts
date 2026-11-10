import { FEE_LABEL, GARBLED_DIGITS, normalizeOcrText, parseReceiptText, ParsedReceipt } from './deposit-receipt-parser.util';
import { parseScreenClock } from './receipt-screen-time.util';

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type OcrLine = { text: string; confidence?: number; bbox?: Box; words?: Array<{ text: string; confidence?: number; bbox?: Box }> };
export type OcrPage = { text?: string; confidence?: number; blocks?: Array<{ paragraphs?: Array<{ lines?: OcrLine[] }>; lines?: OcrLine[] }> | null };

const AMOUNT = /(?<!\d)(\d{1,7}(?:\.\d{1,2})?)(?![\d.])/g;
const TRANSFER = /مبلغ\s*(?:التحويل|العملية|المرسل)|المبلغ\s*(?:المحول|المحوّل|المرسل)|تم\s*تحويل|تحويل\s*(?:مبلغ|بقيمة)|transfer\s*amount|amount\s*(?:transferred|sent)|money\s*transferred|sent\s*amount/i;
const PRIMARY_WALLET_AMOUNT = /[إا]جمال[يى]\s+المبلغ/i;
const WALLET_DETAILS_START = /^(?:من|إلى|الى|from|to|الرسوم|fees?|رقم\s+العملية|transaction\s+id)(?:\s|[:：]|$)/i;
// «cp» only right after a figure («500 cp» — the orange E of EGP lost by OCR).
const CURRENCY = /\b(?:egp|ecp|eop|ep)\b|\d\s*(?:cp|tcp|cece)\b|(?:^|\s)مدع\s*\d|جني[هھة]|ج\.\s*م\./i;
const SUCCESS = /success|approved transaction|بنجاح|بنجاج|تمت العملية|تم الدفع/i;
const EXCLUDE = /fee|fees|total|deducted|balance|remaining|الرسوم|الإجمالي|الاجمالي|المستحق|الكلي|مصاريف|تكلفة|الرصيد|المتبقي/i;
const DATE = /(?:\d{1,2}[\/-]){1,2}\d{2,4}|\d{1,2}:\d{2}|(?:date|التاريخ)\s*[:：]?\s*20\d{2}/i;
const REFERENCE = /reference|ref\b|transaction\s*(?:id|number)|رقم\s*(?:العملية|المرجع)|الرقم\s*المرجعي/i;
const PHONE = /(?<!\d)(?:\+?20|0)?1[0125](?:[\s-]*\d){8}(?!\d)/;

function linesOf(page: OcrPage): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of page.blocks || []) {
    if (Array.isArray(block.lines)) lines.push(...block.lines);
    for (const paragraph of block.paragraphs || []) lines.push(...(paragraph.lines || []));
  }
  return lines.filter(line => line?.text?.trim() && line.bbox && Number.isFinite(line.bbox.y0))
    .sort((a, b) => a.bbox!.y0 - b.bbox!.y0 || a.bbox!.x0 - b.bbox!.x0);
}

function validAmount(token: string): number | null {
  if (token.startsWith('0')) return null;
  const value = Number(token);
  return Number.isFinite(value) && value >= 1 && value <= 1_000_000 ? value : null;
}

function lineConfidence(line: OcrLine, amount: number): number | null {
  const amountWords = (line.words || []).filter(word => normalizeOcrText(word.text).replace(/[^\d.]/g, '') === String(amount)
    && Number.isFinite(word.confidence));
  const words = amountWords.length ? amountWords : (line.words || []).filter(word => Number.isFinite(word.confidence));
  const raw = words.length ? words.reduce((sum, word) => sum + Number(word.confidence), 0) / words.length : line.confidence;
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, Number(raw) / 100)) : null;
}

function adjacentLabel(line: OcrLine, other: OcrLine | undefined): boolean {
  if (!other?.bbox || !line.bbox) return false;
  const height = Math.max(1, line.bbox.y1 - line.bbox.y0, other.bbox.y1 - other.bbox.y0);
  const verticalGap = Math.max(0, line.bbox.y0 - other.bbox.y1, other.bbox.y0 - line.bbox.y1);
  return verticalGap <= height * 2.5;
}

export function receiptLayoutEvidence(page: OcrPage): { amount: number | null; score: number; ambiguous: boolean; source?: ParsedReceipt['amountSource']; screenshotTime?: string } {
  const lines = linesOf(page);
  if (!lines.length) return { amount: null, score: 0, ambiguous: false };
  const detailsStart = lines.findIndex(line => WALLET_DETAILS_START.test(normalizeOcrText(line.text)));
  const candidates: Array<{ amount: number; score: number; source: ParsedReceipt['amountSource'] }> = [];
  for (const [index, line] of lines.entries()) {
    const text = normalizeOcrText(line.text);
    const inHeader = index < 12 && (detailsStart < 0 || index < detailsStart);
    const checkedText = inHeader ? text.replace(PRIMARY_WALLET_AMOUNT, '') : text;
    if (EXCLUDE.test(checkedText) || GARBLED_DIGITS.test(text)
      || REFERENCE.test(text) || DATE.test(text) || PHONE.test(text) || /\d{9,}/.test(text)) continue;
    const numbers = [...text.matchAll(AMOUNT)].map(match => validAmount(match[1])).filter((value): value is number => value != null);
    if (numbers.length !== 1) continue;
    const nearby = [lines[index - 1], lines[index + 1]]
      .filter(other => adjacentLabel(line, other)).map(other => normalizeOcrText(other!.text));
    // A figure labelled «الرسوم» / «المستحق» beside it is the fee or the fee-inclusive total.
    if (nearby.some(label => FEE_LABEL.test(label) && !/\d/.test(label))) continue;
    const sameTransfer = TRANSFER.test(text) || (inHeader && PRIMARY_WALLET_AMOUNT.test(text));
    const sameCurrency = CURRENCY.test(text);
    const adjacentTransfer = nearby.some(label => (TRANSFER.test(label) || (inHeader && PRIMARY_WALLET_AMOUNT.test(label)))
      && !EXCLUDE.test(inHeader ? label.replace(PRIMARY_WALLET_AMOUNT, '') : label) && !/\d/.test(label));
    const adjacentCurrency = nearby.some(label => CURRENCY.test(label) && !EXCLUDE.test(label) && !/\d/.test(label));
    // Figures below From/To or Fees are often the fee-inclusive total. A labelled transfer
    // remains eligible there, but an isolated EGP figure does not.
    if (detailsStart >= 0 && index >= detailsStart && !sameTransfer && !adjacentTransfer) continue;
    const heading = lines.slice(Math.max(0, index - 2), index)
      .some(previous => adjacentLabel(line, previous) && SUCCESS.test(previous.text));
    if (!sameTransfer && !sameCurrency && !adjacentTransfer && !adjacentCurrency && !heading) continue;
    const recognition = lineConfidence(line, numbers[0]);
    const score = Math.min(recognition != null && recognition < .4 ? .59 : 1,
      .28 + (sameTransfer ? .47 : 0) + (sameCurrency ? .35 : 0)
      + (adjacentTransfer ? .34 : 0) + (adjacentCurrency ? .35 : 0) + (heading ? .15 : 0)
      + .12 * (recognition ?? .7));
    candidates.push({ amount: numbers[0], score, source: sameTransfer || adjacentTransfer ? 'sentence' : sameCurrency || adjacentCurrency ? 'currency' : 'heading' });
  }
  // Amount + fee = total. When the Fees / Total labels are lost, «1 EGP» and «1,001 EGP» look like
  // two more amounts beside «1,000 EGP». Three figures where one plus another equals the third are
  // the transfer, its fee and the total: only the transfer is kept.
  const values = [...new Set(candidates.map(c => c.amount))];
  for (const total of values) {
    const parts = values.find(a => a !== total && values.some(f => f !== a && f !== total && Math.abs(a + f - total) < .005 && f < a));
    if (parts == null) continue;
    const fee = Math.round((total - parts) * 100) / 100;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].amount === total || Math.abs(candidates[i].amount - fee) < .005) candidates.splice(i, 1);
    }
    break;
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const conflict = !!best && candidates.some(candidate => candidate.amount !== best.amount && best.score - candidate.score < .12);
  const topClock = lines.slice(0, 2).map(line => normalizeOcrText(line.text)).filter(text => /^\s*\d{1,2}\s*[:：]\s*\d{2}\s*$/.test(text));
  const screenshotTime = topClock.length === 1 ? parseScreenClock(topClock[0]) || undefined : undefined;
  if (!best || conflict) return { amount: null, score: 0, ambiguous: conflict, screenshotTime };
  return { amount: best.amount, score: best.score, ambiguous: false, source: best.source, screenshotTime };
}

/** Uses only Tesseract's recognized text, word confidence and bounding boxes. */
export function parseReceiptRecognition(page: OcrPage, walletLayout = false): ParsedReceipt & { screenshotTime?: string } {
  const base = parseReceiptText(page.text || '', walletLayout);
  const layout = receiptLayoutEvidence(page);
  const baseScore = base.amount == null ? 0 : base.amountSource === 'heading' ? .65 : .82;
  const conflict = layout.ambiguous || (base.amount != null && layout.amount != null && base.amount !== layout.amount
    && baseScore >= .65 && layout.score >= .65);
  const useLayout = layout.amount != null && layout.score >= .65
    && (base.amount == null || (base.amount !== layout.amount && baseScore < layout.score));
  const amount = conflict ? null : useLayout ? layout.amount : base.amount;
  const rawScore = amount == null ? 0 : useLayout ? layout.score : layout.amount === amount
    ? Math.min(baseScore, layout.score) : baseScore;
  const score = Number.isFinite(page.confidence) && Number(page.confidence) < 40
    ? Math.min(rawScore, .59) : rawScore;
  return { ...base, amount, amountSource: amount == null ? undefined : useLayout ? layout.source : base.amountSource,
    amountConfidence: score, confident: amount != null && base.method !== '' && score >= .7,
    ...(layout.screenshotTime ? { screenshotTime: layout.screenshotTime } : {}) };
}
