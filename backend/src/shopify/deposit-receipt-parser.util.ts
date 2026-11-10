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
import { recognizeEgyptianBankName } from './egyptian-bank-names.util';
import { normalizeReceiptPhone } from './receipt-phone.util';

export type ReceiptVault = '' | 'Instapay' | 'فودافون كاش';
export type ReceiptPattern = '' | 'instapay' | 'wallet-app' | 'ussd';

export interface ParsedReceipt {
  senderPhone?: string;
  senderName?: string;
  senderBank?: string;
  senderHandle?: string;
  amount: number | null;
  method: ReceiptVault;
  pattern: ReceiptPattern;
  /** Transfer reference / transaction id — used to warn on a receipt reused twice. */
  reference: string;
  dateText: string;
  confident: boolean;
  /** Currency / transfer-sentence anchors outrank isolated digits near decorative icons. */
  amountSource?: 'currency' | 'sentence' | 'heading';
  /** Confidence in the selected amount after text and layout validation (0–1). */
  amountConfidence?: number;
}

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 1_000_000;

const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;

/**
 * Digits glued to symbols («8800©», «001/0», «)1», «.88», «+:86») are a misread font — typically
 * Arabic-Indic digits in a wallet app's display face — never a clean amount. A line carrying them
 * is not trusted for the amount: a blank field costs five seconds, a wrong figure gets approved.
 *
 * A standalone «م» glued to a digit run («م7006» for «700 EGP», «م5000» for «500 EGP», Nov 2026
 * #3078) is the orange EGP read by the Arabic model as «م» + one digit, stuck onto the figure.
 * Which digit is the E cannot be known, so the line is not read; the English pass sees «700 ecp».
 * Only a «م» that does not end an Arabic word — «لرقم01012345678» is a phone, not a currency.
 */
export const GARBLED_DIGITS = /\d[\/\\©®()\[\]+]|[\/\\©®()\[\]+]\d|(?<!\d)[.:]\d|(?<![\u0600-\u06ff])م\d{2,}/;

/**
 * A fee / fee-inclusive-total label standing alone on its line. Its figure, on the line above or
 * below, is never the transfer amount. Narrower than FEE_LINE on purpose: InstaPay's own amount
 * label «المبلغ الإجمالي المحول» must not count, while a bare «الإجمالي» (after the fees) does.
 */
export const FEE_LABEL = /الرسوم|^رسوم|\bfees?\b|المستحق|deducted|تكل[فغ][هة]|مصاريف|^\s*ال[إا]جمال[يى]\s*$|^\s*total\s*$/i;

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
const TRANSFER_LABEL_AMOUNT = new RegExp(`(?:transfer\\s*amount|amount\\s*(?:transferred|sent)|sent\\s*amount|مبلغ\\s*التحويل|المبلغ\\s*المحو[لّ])\\s*[:：-]?\\s*${NUM}(?![\\d/])`, 'i');

// `EGP` and its observed misreadings. «م0 500» is EGP rendered in orange and read as Arabic.
// «500 cp» / «600 tcp» / «500 cece» (Nov 2026, InstaPay → wallet): the orange EGP read badly.
// Accepted only directly after the figure, never as a free-standing word.
const CURRENCY_AFTER = new RegExp(`(?:^|[^A-Za-z])(?:egp|ecp|eop|ep)\\s*${NUM}(?![\\d])`, 'i');
const CURRENCY_BEFORE = new RegExp(`(?<![\\d.])${NUM}\\s*(?:[¢€]\\s*){0,2}(?:[e€][gco]p|ep|cp|tcp|cece)\\b`, 'i');
const CURRENCY_MEEM = new RegExp(`م\\d\\s+${NUM}(?![\\d])`);
// «مدع 1,000» — the orange EGP read by the Arabic model, before the figure in RTL order.
const CURRENCY_MDA = new RegExp(`(?:^|\\s)مدع\\s+${NUM}(?![\\d.])`);
const CURRENCY_AR_AFTER = new RegExp(`جني[هھة]\\s*${NUM}(?![\\d.])`);
const CURRENCY_AR_BEFORE = new RegExp(`(?<![\\d.])${NUM}\\s*جني[هھة]`);
const CURRENCY_JM_AFTER = new RegExp(`ج\\s*\\.\\s*م\\.?\\s*${NUM}(?![\\d.])`);
const CURRENCY_JM_BEFORE = new RegExp(`(?<![\\d.])${NUM}\\s*ج\\s*\\.\\s*م\\.?`);

// A line that states a fee or a fee-inclusive total — its figure is never the transfer amount.
const FEE_LINE = /fee|total|deducted|الرسوم|الإجمالي|الاجمالي\b|المستحق|الكلي|مصاريف|تكل[فغ][هة]\s*المعاملة/i;
// On some Arabic wallet receipts this is the transfer figure above "من / إلى";
// the later "الإجمالي" is the fee-inclusive amount.
const PRIMARY_WALLET_AMOUNT = /[إا]جمال[يى]\s+المبل[غع]/i;
const PAYMENT_AMOUNT_LABEL = /قيمة\s*ال(?:دفع|دقع|اقع)\s*[:：]?/;
const WALLET_DETAILS_START = /^(?:من|إلى|الى|from|to|الرسوم|fees?|رقم\s+العملية|transaction\s+id)(?:\s|[:：]|$)/i;

const SUCCESS_LINE = /success|approved transaction|your transaction|بنجاح|بنجاج|تمت العملية|تم الدفع/i;

const USSD_MARKER = /مصاريف\s*ال?خد?مة|اطلب\s*9#|9#\*|send\s+(?:instructions|command)|إرسال التعليمات|معلومات شركة الاتصالات|(?:^|\s)0\s*[:：]\s*مزيد|مزيد\s*[:：]\s*0/i;
const INSTAPAY_MARKER = /insta\s*pay|mnstapay|\bipn\b|powered\s*by|approved transaction|transfer amount|living exp|نفقات المعيشة|مصاريف المعيشة|مصازيف/i;
const WALLET_APP_MARKER = /تحويل\s*[اأ]موال|money transferred|total amount deducted|transaction id|transaction date|رقم العملية|تاريخ العملية|المبلغ الكلي|[اإ]جمالي المبل[غع]|تم الدفع بنجاح|تم بنجاح|تم بنجاج|نوع العملية|حالة العملية|تكلفة المعاملة|قيمة\s*ال(?:دفع|دقع|اقع)/i;
const WALLET_DESTINATION = /\bmobile\s*wa[l1][l1i]?e?t\b|\bwallet\b|(?:ال)?محفظ[هة](?:\s*[اإإ]لكتروني[هة])?/i;
const INSTAPAY_HANDLE = /[\w.?’'-]+@\w*pay\b/gi;
const PHONE = /(?<!\d)01\d{9}(?!\d)/;

const MONTHS = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر/i;

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function fromTransferSentence(lines: string[]): { amount: number | null; ambiguous: boolean } {
  const amounts: number[] = [];
  for (const l of lines) {
    if (GARBLED_DIGITS.test(l)) continue;
    const m = l.match(TRANSFER_LABEL_AMOUNT) || l.match(TRANSFER_AFTER) || l.match(TRANSFER_BEFORE);
    if (m) {
      const preceding = l.slice(0, m.index || 0);
      if (FEE_LINE.test(preceding) || /\b(?:reference|ref|transaction id)\b|رقم\s*(?:العملية|المرجع)/i.test(preceding)) continue;
      const v = asAmount(m[1]);
      if (v != null) amounts.push(v);
    }
  }
  const ambiguous = amounts.some(amount => amount !== amounts[0]);
  return { amount: amounts.length && !ambiguous ? amounts[0] : null, ambiguous };
}

function fromPrimaryWalletAmount(lines: string[]): { amount: number | null; ambiguous: boolean } {
  const boundary = lines.findIndex(line => WALLET_DETAILS_START.test(line));
  const header = lines.slice(0, Math.min(12, boundary < 0 ? lines.length : boundary));
  const amounts: number[] = [];
  for (const [index, line] of header.entries()) {
    if (!PRIMARY_WALLET_AMOUNT.test(line)) continue;
    for (const candidate of [line, header[index - 1], header[index + 1]]) {
      if (!candidate) continue;
      const withoutLabel = candidate.replace(PRIMARY_WALLET_AMOUNT, '').trim();
      if (FEE_LINE.test(withoutLabel) || PHONE.test(withoutLabel) || MONTHS.test(withoutLabel) || GARBLED_DIGITS.test(withoutLabel)) continue;
      const match = withoutLabel.match(/^[\s.,،]*(\d+(?:\.\d{1,2})?)\s*(?:جني[هھة]|egp)?[\s.!،]*$/i);
      const amount = match ? asAmount(match[1]) : null;
      if (amount != null) amounts.push(amount);
    }
  }
  const ambiguous = amounts.some(amount => amount !== amounts[0]);
  return { amount: amounts.length && !ambiguous ? amounts[0] : null, ambiguous };
}

function fromCurrencyMarker(lines: string[], stopAtDetails = false): number | null {
  for (const [index, l] of lines.entries()) {
    // Receipt amounts precede the recipient and fee breakdown. Labels can be on their own line.
    if (FEE_LINE.test(l) || PHONE.test(l)) break;
    // On InstaPay receipts a later currency figure may be the fee-inclusive total.
    // Without an explicit transfer label, do not read past the From/To section.
    if (stopAtDetails && WALLET_DETAILS_START.test(l)) break;
    if (GARBLED_DIGITS.test(l)) continue;
    // «1 جنيه» with «الرسوم» on the next line is the fee, read before its own label.
    const nextLine = lines[index + 1] || '';
    if (FEE_LABEL.test(nextLine) && !/\d/.test(nextLine)) continue;
    // Sparse-text OCR can put the prominent figure and "جنيه" on adjacent lines.
    // Keep the same header and fee boundaries as the single-line currency rules.
    if (index <= 7 && (lines[index - 1] || lines[index + 1])) {
      const standalone = l.match(/^(\d{1,7}(?:\.\d{1,2})?)[.!]?$/);
      const adjacentCurrency = [lines[index - 1], lines[index + 1]]
        .some(neighbor => /^جني[هھة][.!]?$/.test(neighbor || ''));
      if (standalone && adjacentCurrency) {
        const value = asAmount(standalone[1]);
        if (value != null && (value >= 10 || index <= 1)) return value;
      }
    }
    for (const re of [CURRENCY_AFTER, CURRENCY_BEFORE, CURRENCY_MEEM, CURRENCY_MDA, CURRENCY_AR_AFTER, CURRENCY_AR_BEFORE, CURRENCY_JM_AFTER, CURRENCY_JM_BEFORE]) {
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
  for (const [offset, l] of lines.slice(start + 1, start + 3).entries()) {
    if (FEE_LINE.test(l) || PHONE.test(l) || MONTHS.test(l) || /\d:\d/.test(l) || GARBLED_DIGITS.test(l)) continue;
    const below = lines[start + 2 + offset] || '';
    if (FEE_LABEL.test(below) && !/\d/.test(below)) continue;
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
  const recipientStart = recipientLines.findIndex(line => /^(?:to\b|إلى|الى|إلي|الي)(?:\s|[:：]|$)/i.test(line));
  const destinationText = recipientStart >= 0 ? recipientLines.slice(recipientStart).join('\n') : recipientText;
  // «vkswr3420@@instapay» — a black/white pass can read the @ twice.
  const handleText = recipientText.replace(/\s*@[\s@]*/g, '@').replace(/insta\s+pay/gi, 'instapay');
  const handles = handleText.match(INSTAPAY_HANDLE) || [];
  const brandedInstapay = /insta\s*pay|mnstapay|\bipn\b|powered\s*by|living exp|نفقات المعيشة|مصاريف المعيشة/i.test(text) || handles.length > 0;
  const walletDetails = /transaction\s*(?:id|date)|total amount deducted|رقم العملية|تاريخ العملية|تكلفة المعاملة|نوع العملية|حالة العملية/i.test(text)
    || (/الرسوم/.test(text) && /تم الدفع بنجا/.test(text));
  // The Vodafone Cash app's own receipt is recognisable by its labels even when its Arabic-Indic
  // digits (phone included) are unreadable: «تم الدفع» + «اجمالي المبلغ» + «الرسوم».
  const vodafoneAppLabels = /تم\s*الدفع/.test(text) && PRIMARY_WALLET_AMOUNT.test(text) && /الرسوم/.test(text);
  const bankWalletDestination = /(?:[إا]ل[يى]\s+(?:ال)?محفظ[هة]|طريقة\s+الدفع\s*[:：.]?\s*محفظ[تن][يى]|محفظ[تن][يى]\s+طريقة\s+الدفع)/i.test(text);
  if (!brandedInstapay && bankWalletDestination) return { method: 'فودافون كاش', pattern: 'wallet-app' };
  if (walletDetails && !brandedInstapay) return { method: PHONE.test(text) || vodafoneAppLabels ? 'فودافون كاش' : '', pattern: 'wallet-app' };
  if (INSTAPAY_MARKER.test(text) || handles.length) {
    if (WALLET_DESTINATION.test(destinationText)) return { method: 'فودافون كاش', pattern: 'instapay' };
    // A photographed screen can split the destination label or read its I as l/1.
    // Require the To label: a sender's @instapay address cannot identify the receiving vault.
    if (/^to(?:\s+|[ \t]*[:：]\s*)(?:[il1]nsta\s*pay|mnstapay)\b|[إا]ل[يى]\s+[إا]نستا\s*با[يى]/im.test(destinationText)) return { method: 'Instapay', pattern: 'instapay' };
    // «Send Money» is InstaPay's address-to-address transfer; a wallet transfer reads «To Mobile
    // Wallet» instead (checked just above). The address itself is often too faint to read.
    if (/send\s*money/i.test(text)) return { method: 'Instapay', pattern: 'instapay' };
    // Sender AND receiver handles both read → the destination is an Instapay address.
    if (handles.length >= 2) return { method: 'Instapay', pattern: 'instapay' };
    // A censored sender need not have a readable handle. A labelled recipient does.
    const to = recipientLines.findIndex(line => /^(?:to|إلى|الى)(?:\s|[:：]|$)/i.test(line));
    if (to >= 0) {
      const afterTo = recipientLines.slice(to, to + 11);
      const end = afterTo.findIndex(line => /^(?:from|من)(?:\s|:|$)/i.test(line));
      const destination = (end < 0 ? afterTo : afterTo.slice(0, end)).join('\n')
        .replace(/\s*@[\s@]*/g, '@').replace(/insta\s+pay/gi, 'instapay');
      if (/@\s*\w*pay\b|\b[\w.-]{2,}[:.]\s*(?:a\s*)?instapay\b/i.test(destination)) {
        return { method: 'Instapay', pattern: 'instapay' };
      }
    }
    return { method: '', pattern: 'instapay' };
  }
  if (hasTransferSentence || (WALLET_APP_MARKER.test(text) && PHONE.test(text))) {
    return { method: 'فودافون كاش', pattern: 'wallet-app' };
  }
  // «تم تحويل ٤٠٠ جنيه الي ٠١٠…» — the wallet's success popup, recognised by its shape even when
  // the figure is unreadable (the amount stays blank; only the vault is suggested). A bank app's
  // «إلى حساب» is excluded.
  if (/[تثن]م\s*تحو[يبى]ل\s+\S+\s+جن\S{1,4}/.test(text) && !/حساب|بنك|\bbank\b|account/i.test(text)) {
    return { method: 'فودافون كاش', pattern: 'wallet-app' };
  }
  if (WALLET_APP_MARKER.test(text)) return { method: '', pattern: 'wallet-app' };
  return { method: '', pattern: '' };
}

function fromWalletFigure(lines: string[]): number | null {
  for (const line of lines.slice(0, 10)) {
    if (PHONE.test(line) || FEE_LINE.test(line) || MONTHS.test(line) || /\d:\d/.test(line)) break;
    const clean = line.replace(/^[p0][.-][2c]\s+(?=\d+\.\d{2}\b)/i, '');
    const numbers = clean.match(/\d+(?:\.\d{1,2})?/g) || [];
    if (numbers.length !== 1 || /\d[A-Za-z@]/.test(clean) || GARBLED_DIGITS.test(clean)) continue;
    const amount = asAmount(numbers[0]);
    if (amount != null && amount >= 10) return amount;
  }
  return null;
}

function referenceOf(lines: string[]): string {
  const reference = /(?:reference|transaction\s*(?:id|number)|رقم\s*(?:العملية|المرجع)|الرقم\s*المرجعي)/i;
  const labelledNumber = /(?<!\d)\d{10,16}(?!\d)/g;
  const unlabelledNumber = /(?<!\d)\d{12}(?!\d)/g;
  for (const [index, line] of lines.entries()) {
    if (!reference.test(line)) continue;
    const labelled = [line, lines[index + 1] || ''].join(' ');
    const values = [...labelled.matchAll(labelledNumber)].map(match => match[0]);
    if (values.length === 1) return values[0];
    // RTL OCR sometimes emits the value on the line before its Arabic label.
    // Require a standalone long id so the nearby sender/recipient phones cannot match.
    const previous = lines[index - 1] || '';
    if (!values.length && /^\d{12,16}$/.test(previous)) return previous;
  }
  const unlabelled = lines.filter(line => !/\b(?:phone|mobile)\b|هاتف|موبايل/i.test(line))
    .flatMap(line => [...line.matchAll(unlabelledNumber)].map(match => match[0]))
    .filter(value => !/^201[0125]\d{8}$/.test(value));
  return new Set(unlabelled).size === 1 ? unlabelled[0] : '';
}

function dateTextOf(lines: string[]): string {
  const date = /(?:\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+20\d{2}|\b\d{1,2}\s+(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)\s+20\d{2}|\b\d{1,2}[\/-]\d{1,2}[\/-]20\d{2})(?:[\s،,]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|ص|م)?)?/i;
  for (const [index, line] of lines.entries()) {
    if (!/^(?:date|transaction date|التاريخ|تاريخ العملية)(?=\s|[:：]|$)/i.test(line)) continue;
    const match = [line, lines[index + 1] || ''].join(' ').match(date);
    if (match) return match[0].trim().slice(0, 48);
  }
  for (const line of lines) {
    const match = line.match(date);
    if (match && (MONTHS.test(line) || /\d{1,2}[\/-]\d{1,2}[\/-]20\d{2}/.test(line))) return match[0].trim().slice(0, 48);
  }
  return '';
}

/** Some InstaPay receipts omit "From" in OCR but keep sender, then destination, in order. */
function unlabelledInstapaySender(lines: string[], pattern: ReceiptPattern): { senderBank?: string; senderHandle?: string } {
  if (pattern !== 'instapay') return {};
  const success = lines.findIndex((line, index) => index < 12 && SUCCESS_LINE.test(line));
  if (success < 0) return {};
  const handlePattern = /[a-z0-9._+-]+\s*@\s*instapay\b/i;
  const senderIndex = lines.findIndex((line, index) => index > success && handlePattern.test(line));
  if (senderIndex < 0) return {};
  const destination = /^(?:to\b|إلى|الى|إلي|الي|mobile\s+wallet\b|المحفظ[هة])/i;
  if (lines.slice(success + 1, senderIndex + 1).some(line => destination.test(line))) return {};
  const after = lines.slice(senderIndex + 1, senderIndex + 7);
  const end = after.findIndex(line => destination.test(line) || handlePattern.test(line));
  if (end < 0) return {};
  const senderHandle = lines[senderIndex].match(handlePattern)![0].replace(/\s/g, '').toLowerCase();
  const bankLines = lines.slice(Math.max(success + 1, senderIndex - 1), senderIndex + 1 + end);
  const banks = [...new Set(bankLines.map(recognizeEgyptianBankName).filter(Boolean))];
  const logo = bankLines.map(line => line.match(/^([A-Z]{3,4})(?=\s*[▶►▸]|\s+[\w.-]+@|$)/)?.[1])
    .find(code => code && !/^(?:FROM|BANK|PHONE|MONEY|EGP)$/.test(code));
  const senderBank = banks.length === 1 ? banks[0] : banks.length ? '' : logo || '';
  return { senderHandle, ...(senderBank ? { senderBank } : {}) };
}

/** Read a labelled sender section, or an ordered InstaPay sender before the destination. */
function senderOf(text: string, pattern: ReceiptPattern): { senderName?: string; senderBank?: string; senderHandle?: string; senderPhone?: string } {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const label = /^(?:from|من)(?:\s*[:：]\s*|\s+|$)/i;
  const reverseLabel = /\s+(?:from|من)\s*[:：]?$/i;
  const index = lines.findIndex(s => label.test(s) || reverseLabel.test(s));
  if (index < 0) return unlabelledInstapaySender(lines, pattern);
  const anchor = lines[index].replace(label, '').replace(reverseLabel, '').trim();
  const before = lines[index - 1] || '';
  // RTL OCR can put the number before its standalone label. Keep that row alone.
  const precedingPhone = !anchor && normalizeReceiptPhone(before);
  let section = precedingPhone ? before : anchor;
  if (!precedingPhone) {
    for (let i = index + 1; i < Math.min(lines.length, index + 5); i++) {
      if (/^(?:to\b|إلى|الى|إلي|الي|account\b|الحساب|حالة العملية|تاريخ العملية|الرسوم)/i.test(lines[i]) || /\s+(?:to|إلى|الى|إلي|الي)\s*$/i.test(lines[i])) break;
      section += '\n' + lines[i];
    }
  }
  const senderHandle = section.match(/[a-z0-9._+-]+\s*@\s*instapay\b/i)?.[0].replace(/\s/g, '').toLowerCase();
  const phones = [...new Set((section.match(/(?:\+20|0020|20|0)[\s-]*1[0125](?:[\s-]*\d){8}(?!\d)/g) || []).map(normalizeReceiptPhone).filter(Boolean))];
  if (phones.length > 1) return {};
  const senderPhone = phones.length === 1 ? phones[0] : '';
  const sectionLines = section.split('\n').map(s => s.trim()).filter(Boolean);
  const logo = sectionLines.map(line => line.match(/^([A-Z]{3,4})(?=\s*[▶►▸]|\s+[\w.-]+@|$)/)?.[1])
    .find(code => code && !/^(?:FROM|BANK|PHONE|MONEY)$/.test(code));
  const recognizedBanks = [...new Set(sectionLines.map(recognizeEgyptianBankName).filter(Boolean))];
  const explicitBank = sectionLines.filter(line => !line.includes('@'))
    .map(line => line.match(/(?:\bbank\b|بنك)\s*[:：-]?\s*([\p{L}][\p{L}\s]{2,35})/iu)?.[1]?.trim()).find(Boolean);
  const senderBank = recognizedBanks.length === 1 ? recognizedBanks[0] : recognizedBanks.length ? '' : explicitBank || logo || '';
  const senderName = sectionLines.map(s => logo ? s.replace(new RegExp(`^${logo}(?:\\s*[▶►▸]\\s*|\\s+|$)`), '').trim() : s)
    .find(s => s && !recognizeEgyptianBankName(s) && !/@|\baccount\b|الحساب|vodafone|فودافون|\bbank\b|بنك|^[\d\s*+()\-]+$/i.test(s)
      && !/^[A-Z]{2,6}$/.test(s) && /[a-z\u0600-\u06ff]/i.test(s));
  return { ...(senderName ? { senderName: senderName.slice(0, 120) } : {}),
    ...(senderBank ? { senderBank: senderBank.slice(0, 80) } : {}),
    ...(senderHandle ? { senderHandle } : {}), ...(senderPhone ? { senderPhone } : {}) };
}

/** Parses one OCR pass. */
export function parseReceiptText(rawText: string, walletLayout = false): ParsedReceipt {
  const text = normalizeOcrText(rawText);
  const lines = linesOf(text);
  const { amount: transfer, ambiguous } = fromTransferSentence(lines);
  const primaryWallet = fromPrimaryWalletAmount(lines);
  const paymentLabel = lines.findIndex(line => PAYMENT_AMOUNT_LABEL.test(line));
  const paymentLines = paymentLabel < 0 ? [] : [lines[paymentLabel].replace(PAYMENT_AMOUNT_LABEL, '').trim(), lines[paymentLabel + 1] || ''];
  const payment = paymentLines.map(line => /^\d{1,7}(?:\.\d{1,2})?$/.test(line) ? asAmount(line) : null).find(value => value != null) ?? null;
  const currency = fromCurrencyMarker(lines, INSTAPAY_MARKER.test(text) || /@\s*insta\s*pay\b/i.test(text));
  const amountConflict = transfer != null && primaryWallet.amount != null && transfer !== primaryWallet.amount;
  const amount = ambiguous || primaryWallet.ambiguous || amountConflict ? null : transfer ?? primaryWallet.amount ?? payment ?? currency ?? fromSuccessHeading(lines) ?? (walletLayout ? fromWalletFigure(lines) : null);
  const { method, pattern } = detectVault(text, transfer != null);
  return {
    amount,
    method,
    pattern,
    ...senderOf(text, pattern),
    reference: referenceOf(lines),
    dateText: dateTextOf(lines),
    confident: amount != null && method !== '',
    ...(amount != null ? { amountSource: transfer != null || primaryWallet.amount != null || payment != null ? 'sentence' as const : currency != null ? 'currency' as const : 'heading' as const } : {}),
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
  const senders: any = {};
  for (const field of ['senderName', 'senderBank', 'senderHandle', 'senderPhone'] as const) {
    const values = [...new Set(passes.map(p => p[field]).filter(Boolean))];
    if (values.length === 1) senders[field] = values[0];
  }
  return { amount, method, pattern, reference, dateText, ...senders, confident: amount != null && method !== '' };
}
