/**
 * Reads a transfer receipt's OCR text and suggests the deposit amount and the vault it landed in.
 *
 * It is an ASSISTANT, not an authority: the employee always confirms or edits, and the manager
 * approves. So every rule here prefers "no suggestion" over a wrong one — a blank field is
 * typed in five seconds, a wrong confident figure gets approved.
 *
 * Built against real Tesseract output (ara+eng) of 17 customer screenshots, which are noisy:
 * status-bar numbers (battery %, clock) come first, `EGP` is often read as «م0» / «ecp»,
 * Arabic-Indic ٥٠٠ in display fonts is read as «086» / «000», and a USSD line can come out with
 * its parts reversed. See test/unit/deposit-receipt-parser.spec.ts for the fixtures.
 *
 * Three receipt families:
 *   • ussd       — «تم تحويل N جنيه لرقم 010… مصاريف الخدمة …» (carrier dialog). Always a mobile
 *                  wallet (Vodafone Cash) — confirmed by the owner.
 *   • wallet-app — the wallet app's own confirmation screen (Arabic or English). Mobile wallet.
 *   • instapay   — IPN/Instapay receipt. ⚠ The vault is decided by the DESTINATION: Instapay is
 *                  often only the sender's rail, and a «Mobile Wallet / المحفظة» destination
 *                  means the money landed in Vodafone Cash. When the destination cannot be
 *                  told, the method is left blank.
 */
import { toLatinDigits } from '../shared/digits.util';

export type ReceiptVault = '' | 'Instapay' | 'فودافون كاش';
export type ReceiptPattern = '' | 'instapay' | 'wallet-app' | 'ussd';

export interface ParsedReceipt {
  amount: number | null;
  method: ReceiptVault;
  pattern: ReceiptPattern;
  /** Transfer reference / transaction id (12 digits) — used to warn on a receipt reused twice. */
  reference: string;
  dateText: string;
  confident: boolean;
  /** Currency / transfer-sentence anchors outrank isolated digits near decorative icons. */
  amountSource?: 'currency' | 'sentence' | 'heading';
}

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 1_000_000;

const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;

/** Latin digits, no bidi marks, thousands separators removed («2,000» → «2000»). */
export function normalizeOcrText(text: string): string {
  return toLatinDigits(String(text || ''))
    .replace(BIDI_MARKS, '')
    .replace(/(\d{1,3})((?:,\d{3})+)(?!\d)/g, (_m, head: string, rest: string) => head + rest.replace(/,/g, ''));
}

/**
 * A digit run is a plausible amount only if it could not be anything else:
 *   - ⚠ a leading zero is rejected — OCR reads Arabic-Indic ٥٠٠ in display fonts as «086»/«000»,
 *     and no amount is written with a leading zero; accepting it suggests 86 with confidence.
 *   - 9+ digits is a reference or a phone, never an amount here.
 */
function asAmount(tok: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(tok)) return null;
  if (tok.startsWith('0')) return null;
  const n = Number(tok);
  if (!Number.isFinite(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) return null;
  return n;
}

const NUM = '(\\d+(?:\\.\\d{1,2})?)';

// «تم تحويل» — tolerant of the OCR swaps seen in the fixtures (ثم / نم, تحوبل).
const TRANSFER_AFTER = new RegExp(`تحو[يبى]ل\\s+${NUM}(?![\\d/])`);
const TRANSFER_BEFORE = new RegExp(`(?<![\\d/])${NUM}\\s+[تثن]م\\s*تحو[يبى]ل`);

// `EGP` and its observed misreadings. «م0 500» is EGP rendered in orange and read as Arabic.
const CURRENCY_AFTER = new RegExp(`(?:^|[^A-Za-z])(?:egp|ecp|eop|ep)\\s*${NUM}(?![\\d])`, 'i');
const CURRENCY_BEFORE = new RegExp(`(?<![\\d.])${NUM}\\s*(?:[¢€]\\s*){0,2}(?:[e€][gco]p|ep)\\b`, 'i');
const CURRENCY_MEEM = new RegExp(`م\\d\\s+${NUM}(?![\\d])`);
const CURRENCY_AR_AFTER = new RegExp(`جني[هھة]\\s*${NUM}(?![\\d.])`);
const CURRENCY_AR_BEFORE = new RegExp(`(?<![\\d.])${NUM}\\s*جني[هھة]`);

// A line that states a fee or a fee-inclusive total — its figure is never the transfer amount.
const FEE_LINE = /fee|total|deducted|الرسوم|الإجمالي|الاجمالي\b|المستحق|الكلي|مصاريف|تكل[فغ][هة]\s*المعاملة/i;

const SUCCESS_LINE = /success|approved transaction|your transaction|بنجاح|بنجاج|تمت العملية|تم الدفع/i;

const USSD_MARKER = /مصاريف\s*ال?خد?مة|اطلب\s*9#|9#\*|send\s+(?:instructions|command)|إرسال التعليمات|معلومات شركة الاتصالات/i;
const INSTAPAY_MARKER = /insta\s*pay|mnstapay|\bipn\b|powered\s*by|approved transaction|transfer amount|living exp|نفقات المعيشة|مصاريف المعيشة|مصازيف/i;
const WALLET_APP_MARKER = /money transferred|total amount deducted|transaction id|transaction date|رقم العملية|تاريخ العملية|المبلغ الكلي|اجمالي المبلغ|تم الدفع بنجاح|تم بنجاح|تم بنجاج|نوع العملية|حالة العملية|تكلفة المعاملة/i;
const WALLET_DESTINATION = /mobile\s*wallet|المحفظ[هة]|wallet/i;
const INSTAPAY_HANDLE = /[\w.?’'-]+@\w*pay\b/gi;
const PHONE = /(?<!\d)01\d{9}(?!\d)/;

const MONTHS = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر/i;

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function fromTransferSentence(lines: string[]): number | null {
  for (const l of lines) {
    const m = l.match(TRANSFER_AFTER) || l.match(TRANSFER_BEFORE);
    if (m) {
      const v = asAmount(m[1]);
      if (v != null) return v;
    }
  }
  return null;
}

function fromCurrencyMarker(lines: string[]): number | null {
  for (const [index, l] of lines.entries()) {
    // Receipt amounts precede the recipient and fee breakdown. Labels can be on their own line.
    if (FEE_LINE.test(l) || PHONE.test(l)) break;
    for (const re of [CURRENCY_AFTER, CURRENCY_BEFORE, CURRENCY_MEEM, CURRENCY_AR_AFTER, CURRENCY_AR_BEFORE]) {
      const m = l.match(re);
      if (m) {
        if ((re === CURRENCY_AR_AFTER || re === CURRENCY_AR_BEFORE) && (index > 7 || (l.match(/\d+(?:\.\d+)?/g) || []).length !== 1)) continue;
        const v = asAmount(m[1]);
        if ((re === CURRENCY_AR_AFTER || re === CURRENCY_AR_BEFORE) && v != null && v < 10 && index > 1) continue;
        if (v != null) return v;
      }
    }
  }
  return null;
}

/**
 * The big standalone figure right under the success heading («Your transaction was successful /
 * 500»). Only the two lines after the last heading line near the top are looked at: everything
 * above is the phone's status bar (battery, clock) and everything further down is fees, ids and
 * dates — a wider window read a stray «77» four lines down as the amount.
 */
function fromSuccessHeading(lines: string[]): number | null {
  let start = -1;
  lines.slice(0, 12).forEach((l, i) => { if (SUCCESS_LINE.test(l)) start = i; });
  if (start < 0) return null;
  for (const l of lines.slice(start + 1, start + 3)) {
    if (FEE_LINE.test(l) || PHONE.test(l) || MONTHS.test(l) || /\d:\d/.test(l)) continue;
    const tokens = l.split(/\s+/).filter(Boolean);
    if (tokens.length > 3) continue;
    const nums = tokens.map((t) => t.replace(/[^\d.]/g, '')).filter((t) => t && /^\d/.test(t));
    const mixed = tokens.some((t) => /\d/.test(t) && /[^\d.,:]/.test(t));
    if (nums.length !== 1 || mixed) continue;
    const v = asAmount(nums[0]);
    // A lone one-digit glyph here is usually the success arrow/check, not money.
    // Genuine small transfers remain supported when a currency/sentence anchors them.
    if (v != null && v >= 10) return v;
  }
  return null;
}

function detectVault(text: string, hasTransferSentence: boolean): { method: ReceiptVault; pattern: ReceiptPattern } {
  if (USSD_MARKER.test(text) && (hasTransferSentence || PHONE.test(text))) {
    return { method: 'فودافون كاش', pattern: 'ussd' };
  }
  const lines = linesOf(text);
  const footer = lines.findIndex(line => /^(?:reference|date|note|more details|الرقم المرجعي|التاريخ|ملاحظة)(?:\s|:|$)/i.test(line));
  const recipientLines = footer < 0 ? lines : lines.slice(0, footer);
  const recipientText = recipientLines.join('\n');
  const handles = recipientText.match(INSTAPAY_HANDLE) || [];
  const brandedInstapay = /insta\s*pay|mnstapay|\bipn\b|powered\s*by|living exp|نفقات المعيشة|مصاريف المعيشة/i.test(text) || handles.length > 0;
  const walletDetails = /transaction\s*(?:id|date)|total amount deducted|رقم العملية|تاريخ العملية|تكلفة المعاملة|نوع العملية|حالة العملية/i.test(text)
    || (/الرسوم/.test(text) && /تم الدفع بنجا/.test(text));
  if (walletDetails && !brandedInstapay) return { method: PHONE.test(text) ? 'فودافون كاش' : '', pattern: 'wallet-app' };
  if (INSTAPAY_MARKER.test(text) || handles.length) {
    if (WALLET_DESTINATION.test(recipientText)) return { method: 'فودافون كاش', pattern: 'instapay' };
    // Sender AND receiver handles both read → the destination is an Instapay address.
    if (handles.length >= 2) return { method: 'Instapay', pattern: 'instapay' };
    // A censored sender need not have a readable handle. A labelled recipient does.
    const to = recipientLines.findIndex(line => /^(?:to|إلى|الى)\s*$/i.test(line));
    if (to >= 0) {
      const afterTo = recipientLines.slice(to + 1, to + 11);
      const end = afterTo.findIndex(line => /^(?:from|من)(?:\s|:|$)/i.test(line));
      const destination = (end < 0 ? afterTo : afterTo.slice(0, end)).join('\n');
      if (/@\s*\w*pay\b|\b[\w.-]{2,}[:.]\s*(?:a\s*)?instapay\b/i.test(destination)) {
        return { method: 'Instapay', pattern: 'instapay' };
      }
    }
    return { method: '', pattern: 'instapay' };
  }
  if (hasTransferSentence || (WALLET_APP_MARKER.test(text) && PHONE.test(text))) {
    return { method: 'فودافون كاش', pattern: 'wallet-app' };
  }
  if (WALLET_APP_MARKER.test(text)) return { method: '', pattern: 'wallet-app' };
  return { method: '', pattern: '' };
}

function fromWalletFigure(lines: string[]): number | null {
  for (const line of lines.slice(0, 10)) {
    if (PHONE.test(line) || FEE_LINE.test(line) || MONTHS.test(line) || /\d:\d/.test(line)) break;
    const numbers = line.match(/\d+(?:\.\d{1,2})?/g) || [];
    if (numbers.length !== 1 || /\d[A-Za-z@]/.test(line)) continue;
    const amount = asAmount(numbers[0]);
    if (amount != null && amount >= 10) return amount;
  }
  return null;
}

function referenceOf(text: string): string {
  const m = text.match(/(?<!\d)\d{12}(?!\d)/);
  return m ? m[0] : '';
}

function dateTextOf(lines: string[]): string {
  const l = lines.find((x) => MONTHS.test(x) && /20\d{2}/.test(x));
  return l ? l.slice(0, 48) : '';
}

/** Parses one OCR pass. */
export function parseReceiptText(rawText: string, walletLayout = false): ParsedReceipt {
  const text = normalizeOcrText(rawText);
  const lines = linesOf(text);
  const transfer = fromTransferSentence(lines);
  const currency = fromCurrencyMarker(lines);
  const amount = transfer ?? currency ?? fromSuccessHeading(lines) ?? (walletLayout ? fromWalletFigure(lines) : null);
  const { method, pattern } = detectVault(text, transfer != null);
  return {
    amount,
    method,
    pattern,
    reference: referenceOf(text),
    dateText: dateTextOf(lines),
    confident: amount != null && method !== '',
    ...(amount != null ? { amountSource: transfer != null ? 'sentence' as const : currency != null ? 'currency' as const : 'heading' as const } : {}),
  };
}

/**
 * Merges several OCR passes of the same image (different preparations).
 *
 * Currency/transfer-sentence anchors outrank isolated figures near the success graphic.
 * ⚠ Disagreement among anchored readings means NO suggestion. One fixture read «500» in one pass and «5000» in the
 * other; picking either would be a coin toss presented as a fact. A value read by only one pass
 * is kept — that is the normal case, since each preparation suits different screenshots.
 */
export function mergeReceiptPasses(passes: ParsedReceipt[]): ParsedReceipt {
  const anchored = passes.filter(p => p.amount != null && (p.amountSource === 'currency' || p.amountSource === 'sentence'));
  const amounts = (anchored.length ? anchored : passes).map((p) => p.amount).filter((a): a is number => a != null);
  const amountAgrees = amounts.every((a) => Math.abs(a - amounts[0]) < 0.005);
  const amount = amounts.length && amountAgrees ? amounts[0] : null;

  const methods = passes.map((p) => p.method).filter(Boolean) as ReceiptVault[];
  const method: ReceiptVault = methods.length && methods.every((m) => m === methods[0]) ? methods[0] : '';

  const pattern = (passes.find((p) => p.pattern)?.pattern || '') as ReceiptPattern;
  const reference = passes.find((p) => p.reference)?.reference || '';
  const dateText = passes.find((p) => p.dateText)?.dateText || '';
  return { amount, method, pattern, reference, dateText, confident: amount != null && method !== '' };
}
