import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import sharp from 'sharp';
import { createWorker, Worker } from 'tesseract.js';
import { normalizeOcrText, ParsedReceipt, parseReceiptText } from './deposit-receipt-parser.util';
import { parseReceiptRecognition, OcrPage } from './deposit-receipt-layout.util';
import { receiptOcrRegion, receiptTealAmount } from './receipt-image.util';
import { readArabicTealAmount } from './receipt-digit.util';
import { walletMessageAmount, walletUssdContext, walletUssdFigure, walletWordImage } from './receipt-wallet.util';
import { compressReceipt } from './receipt-upload-policy.util';
import { prepareInstapayLayout, parseInstapayLayout, instapayReferenceBox, instapayReferenceImage,
  instapayAmountImage, instapayDestinationImage, verifiedInstapayReference } from './receipt-instapay.util';

const OCR_TIMEOUT_MS = 20_000;

/** The first line of an English pass that carries digits, when it is one clean figure with at most
    a few stray glyphs before it (««400», ««> 400.00», «a> 300.00»). Anything else: null. */
export function englishHeadlineFigure(text: string): number | null {
  const first = normalizeOcrText(text).split('\n').map(l => l.trim()).find(l => /\d/.test(l));
  const m = first?.match(/^[^\w\s]{0,3}\s*[A-Za-z]{0,2}[^\w\s]{0,3}\s*([1-9]\d{0,5}(?:\.\d{2})?)$/);
  const value = m ? Number(m[1]) : NaN;
  return Number.isFinite(value) && value >= 10 ? value : null;
}

export interface OcrResult extends ParsedReceipt {
  screenshotTime?: string;
  screenshotTimeSource?: 'screen-status-bar' | 'embedded-status-bar';
  /** false when OCR could not run (timeout / worker failure) — the employee types the figure. */
  ran: boolean;
  ms: number;
}

/**
 * Local OCR for deposit receipts (Tesseract, Arabic + English together).
 *
 * ⚠ ONE worker, a strict queue. A worker holds ~150 MB of language data and Tesseract processes
 *   one image at a time anyway; parallel workers would only multiply memory on a server that
 *   also runs the API. The queue and 20-second deadline cover receipt isolation and recognition.
 * Small receipts inside screenshots are cropped and enlarged for OCR; the original upload is
 * still used for storage preparation and is never modified in place.
 *
 * ⚠ A timeout terminates the worker. Leaving a stuck job in place would block every later
 *   upload behind it in the queue.
 */
@Injectable()
export class DepositReceiptOcrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DepositReceiptOcrService.name);
  private worker: Promise<Worker> | null = null;
  private workerInstance: Worker | null = null;
  private startup: Promise<Worker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  onModuleInit(): void {
    // Warm the worker off the boot path, so the first upload after a deploy is not the one that
    // waits for the language data. Never in tests.
    if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test' || process.env.SKIP_OCR_WARMUP === 'true') return;
    setTimeout(() => {
      this.getWorker().catch((err) => this.logger.warn(`OCR warm-up failed: ${(err as Error).message}`));
    }, 15_000);
  }

  async onModuleDestroy(): Promise<void> {
    await this.dropWorker();
  }

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      // Tesseract can leave its startup promise pending on a language-load error.
      // Do not spawn another worker on every subsequent upload in that state.
      if (this.startup) throw new Error('OCR initialization is still pending; manual entry is available');
      const localLanguages = ['ara', 'eng'].every(lang => existsSync(path.join(process.cwd(), `${lang}.traineddata`)));
      const cachePath = process.env.OCR_CACHE_DIR || (localLanguages ? process.cwd() : path.join(process.cwd(), 'tessdata-cache'));
      mkdirSync(cachePath, { recursive: true });
      const startup = createWorker(['ara', 'eng'], 1, {
        cachePath,
        // Tesseract also reports rejections from a worker event callback. Without this
        // handler it throws outside our promise catch and terminates the API process.
        errorHandler: error => this.logger.warn(`OCR worker failed: ${String(error)}`),
      });
      this.startup = startup;
      const ready = startup.then(async (w) => {
        if (this.startup === startup) this.startup = null;
        if (this.worker !== ready) {
          void w.terminate().catch(() => undefined);
          throw new Error('OCR worker initialization expired');
        }
        this.workerInstance = w;
        // Sparse-text segmentation: a receipt is scattered labels and figures, not paragraphs.
        await w.setParameters({ tessedit_pageseg_mode: '11' as any });
        return w;
      });
      this.worker = ready;
      ready.catch(() => {
        if (this.startup === startup) this.startup = null;
        if (this.worker === ready) { this.worker = null; this.workerInstance = null; }
      });
    }
    return this.worker;
  }

  private async dropWorker(): Promise<void> {
    const w = this.workerInstance;
    this.worker = null;
    this.workerInstance = null;
    if (!w) return;
    // A pending createWorker() or terminate() must not defeat the OCR deadline.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([w.terminate().catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * Re-encodes an upload for storage: EXIF orientation applied, longest side capped, JPEG.
   * Also strips metadata (a phone photo can carry GPS) — the stored copy is the receipt only.
   */
  async prepareForStorage(input: Buffer): Promise<Buffer> {
    return compressReceipt(input);
  }

  /** Never throws: a failed read is an empty suggestion, never a failed upload. */
  read(image: Buffer): Promise<OcrResult> {
    const started = Date.now();
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const fallback = (): OcrResult => ({ amount: null, method: '', pattern: '', reference: '', dateText: '', confident: false, ran: false, ms: Date.now() - started });
    // The caller's budget includes time waiting behind other receipts.
    const deadline = new Promise<OcrResult>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(fallback()); }, OCR_TIMEOUT_MS + 1000);
    });
    const job = this.queue.then(() => {
      const remaining = OCR_TIMEOUT_MS - (Date.now() - started);
      return expired || remaining <= 0 ? fallback() : this.readNow(image, remaining);
    });
    this.queue = job.catch(() => undefined);
    return Promise.race([job, deadline]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * Second chance when neither language pass found an anchored amount. Two more preparations of
   * the SAME upload, each suited to a failure seen on real receipts:
   *   - black/white threshold: light text on a dark USSD dialog («تم تحويل 2000 جنيه لرقم …»)
   *     reads as nothing in colour;
   *   - half size: an oversized headline figure («1600 جنيه») reads as loose, reversed glyphs.
   * ⚠ Only an anchored (currency / transfer-sentence) amount of 10 or more counts, and two
   *   preparations that disagree cancel each other out. A wrong figure is worse than a blank one.
   */
  private async recoverAmount(worker: Worker, image: Buffer, expired: () => boolean): Promise<ParsedReceipt | null> {
    const width = (await sharp(image).metadata()).width || 0;
    const variants: Array<() => Promise<Buffer>> = [
      () => sharp(image).rotate().grayscale().normalise().threshold(150).png().toBuffer(),
      () => sharp(image).rotate().resize({ width: Math.max(320, Math.round(width / 2)) }).grayscale().normalise().png().toBuffer(),
    ];
    const found: ParsedReceipt[] = [];
    for (const make of variants) {
      if (expired()) return null;
      try {
        const reading = parseReceiptRecognition((await worker.recognize(await make(), undefined, { blocks: true })).data);
        if (reading.amount != null && reading.amount >= 10 && ['currency', 'sentence'].includes(reading.amountSource || '')) found.push(reading);
      } catch { /* One preparation failing leaves the others. */ }
    }
    if (!found.length || found.some(r => Math.abs(Number(r.amount) - Number(found[0].amount)) > .005)) return null;
    return found.sort((a, b) => (b.amountConfidence || 0) - (a.amountConfidence || 0))[0];
  }

  /**
   * An InstaPay receipt whose destination could not be read. InstaPay prints the recipient's
   * address in light grey («vkswr3420@instapay»), which colour OCR returns as fragments, so only
   * the sender's address is seen and the vault stays blank. Photographed screens need contrast
   * normalization before thresholding; a fixed threshold can erase their entire grey background.
   * First retain the grey detail, then try a black/white pass. Only the vault is taken — never the
   * amount — and only when the pass recognises the same InstaPay receipt.
   */
  private async recoverInstapayDestination(worker: Worker, image: Buffer, expired: () => boolean): Promise<ParsedReceipt['method']> {
    for (const level of [null, 215]) {
      if (expired()) return '';
      try {
        const preparation = sharp(image).rotate().resize({ width: 1200 }).grayscale().normalise();
        const prepared = await (level == null ? preparation : preparation.threshold(level)).png().toBuffer();
        const reading = parseReceiptRecognition((await worker.recognize(prepared, undefined, { blocks: true })).data);
        if (reading.pattern === 'instapay' && reading.method) return reading.method;
      } catch { /* One preparation failing leaves the next. */ }
    }
    return '';
  }

  /** The wallet's teal headline is separate ink from its black fees, totals and phone numbers. */
  private async recoverWalletFigure(worker: Worker, image: Buffer, expired: () => boolean): Promise<{ amount: number | null; confidence: number; ambiguous?: boolean } | null> {
    const mask = await receiptTealAmount(image);
    if (!mask || expired()) return null;
    const arabic = await readArabicTealAmount(mask);
    if (arabic != null && arabic === await readArabicTealAmount(await sharp(mask).resize({ height: 140 }).png().toBuffer())) {
      return { amount: arabic, confidence: .9 };
    }
    try {
      await worker.reinitialize('eng');
      await worker.setParameters({ tessedit_pageseg_mode: '7' as any, tessedit_char_whitelist: '0123456789,.' });
      const first = (await worker.recognize(mask)).data;
      if (expired()) return null;
      const second = (await worker.recognize(await sharp(mask).resize({ height: 120 }).png().toBuffer())).data;
      const figure = normalizeOcrText(first.text).trim();
      const alternate = normalizeOcrText(second.text).trim();
      if (/^[1-9]\d{0,6}(?:\.\d{1,2})?$/.test(figure) && /^[1-9]\d{0,6}(?:\.\d{1,2})?$/.test(alternate)
        && first.confidence >= 80 && second.confidence >= 80 && Number(figure) !== Number(alternate)) {
        return { amount: null, confidence: 0, ambiguous: true };
      }
      if (!/^[1-9]\d{0,6}(?:\.\d{1,2})?$/.test(figure) || figure !== normalizeOcrText(second.text).trim()
        || !Number.isFinite(first.confidence) || !Number.isFinite(second.confidence)
        || first.confidence < 80 || second.confidence < 80 || Number(figure) > 1_000_000) return null;
      return { amount: Number(figure), confidence: Math.min(first.confidence, second.confidence) / 100 };
    } finally {
      await worker.reinitialize('ara+eng');
      await worker.setParameters({ tessedit_pageseg_mode: '11' as any, tessedit_char_whitelist: '' });
    }
  }

  private async recoverUssdPhoto(worker: Worker, image: Buffer, page: OcrPage, expired: () => boolean): Promise<number | null> {
    const context = await walletUssdContext(image, page);
    if (!context || expired()) return null;
    try {
      await worker.reinitialize('eng');
      await worker.setParameters({ tessedit_pageseg_mode: '6' as any });
      const figure = walletUssdFigure((await worker.recognize(context, undefined, { blocks: true })).data);
      if (!figure || expired()) return null;
      await worker.setParameters({ tessedit_pageseg_mode: '7' as any, tessedit_char_whitelist: '0123456789,.' });
      const crop = await walletWordImage(context, figure.box);
      const readings = [];
      for (const level of [140, 180]) {
        if (expired()) return null;
        readings.push((await worker.recognize(await sharp(crop).threshold(level).png().toBuffer())).data);
      }
      return readings.every(r => Number.isFinite(r.confidence) && r.confidence >= 80 && Number(normalizeOcrText(r.text).trim()) === figure.value)
        ? figure.value : null;
    } finally {
      await worker.reinitialize('ara+eng');
      await worker.setParameters({ tessedit_pageseg_mode: '11' as any, tessedit_char_whitelist: '' });
    }
  }

  private async readNow(image: Buffer, timeoutMs = OCR_TIMEOUT_MS): Promise<OcrResult> {
    const started = Date.now();
    const empty: OcrResult = {
      amount: null, method: '', pattern: '', reference: '', dateText: '', confident: false, ran: false, ms: 0,
    };
    let timer: NodeJS.Timeout | undefined;
    let receiptResult: ParsedReceipt | undefined;
    let cancelled = false;
    try {
      const work = (async () => {
        const worker = await this.getWorker();
        if (cancelled) throw new Error('OCR request expired');
        // Latin fields in both Arabic/English InstaPay templates share the same visual anchors.
        // One English pass avoids the mixed-language pass confusing EGP and sender addresses.
        let fast: (ParsedReceipt & { screenshotTime?: string }) | null = null;
        try {
          const layout = await prepareInstapayLayout(image);
          if (layout && !cancelled) {
            try {
              await worker.reinitialize('eng');
              await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
              const page = (await worker.recognize(layout.image, undefined, { blocks: true })).data;
              if (cancelled) throw new Error('OCR request expired');
              fast = parseInstapayLayout(page, layout);
              if (fast) {
                await worker.setParameters({ tessedit_pageseg_mode: '7' as any, tessedit_char_whitelist: '0123456789,.' });
                const amountData = (await worker.recognize(await instapayAmountImage(layout))).data;
                const figure = normalizeOcrText(amountData.text).trim();
                const agrees = /^[1-9]\d{0,6}(?:\.\d{1,2})?$/.test(figure) && Number(figure) === fast.amount;
                fast.amountConfidence = agrees ? amountData.confidence / 100 : 0;
                if (!agrees) { fast.amount = null; fast.amountSource = undefined; }
                fast.confident = agrees && fast.method !== '' && fast.amountConfidence >= .7;
                const box = instapayReferenceBox(page, layout);
                fast.reference = '';
                if (box && !cancelled) {
                  await worker.setParameters({ tessedit_pageseg_mode: '7' as any, tessedit_char_whitelist: '0123456789' });
                  const referenceImage = await instapayReferenceImage(layout, box);
                  const first = (await worker.recognize(referenceImage)).data;
                  const second = (await worker.recognize(await sharp(referenceImage).threshold(150).png().toBuffer())).data;
                  // Independent source-pixel readings must agree; conflicting ids stay blank.
                  fast.reference = verifiedInstapayReference([first, second]);
                  if (!fast.reference && !cancelled) {
                    const third = (await worker.recognize(await sharp(referenceImage).resize({ height: 50 })
                      .threshold(200).png().toBuffer())).data;
                    fast.reference = verifiedInstapayReference([first, second, third]);
                  }
                }
                receiptResult = fast;
              }
            } finally {
              await worker.reinitialize('ara+eng');
              await worker.setParameters({ tessedit_pageseg_mode: '11' as any, tessedit_char_whitelist: '' });
            }
            if (fast && !fast.method && !cancelled) {
              const destination = (await worker.recognize(await instapayDestinationImage(layout), undefined, { blocks: true })).data;
              const method = parseReceiptText(`Transaction Successful\n${fast.amount} EGP\nFrom\n${fast.senderHandle}\nTo\n${destination.text}`).method;
              fast.method = method;
              fast.confident = method !== '' && (fast.amountConfidence || 0) >= .7;
            }
            if (fast && fast.method && (fast.amount == null || (fast.amountConfidence || 0) >= .7)) {
              return { ...fast, ...(fast.screenshotTime ? { screenshotTimeSource: 'screen-status-bar' as const } : {}) };
            }
          }
        } catch { /* Unknown templates and low-quality inputs retain the general receipt reader. */ }
        if (cancelled) throw new Error('OCR request expired');
        let recognitionImage = image;
        try {
          const region = await receiptOcrRegion(image);
          const [source, card] = await Promise.all([sharp(image).metadata(), sharp(region).metadata()]);
          if ((card.width || 0) * (card.height || 0) < (source.width || 0) * (source.height || 0) * .9) {
            // A small light receipt inside a dimmed chat needs its own pixels and scale.
            // Full-screen receipts still use the original upload unchanged.
            recognitionImage = await sharp(region).grayscale().normalise()
              .resize({ width: Math.min(Math.max((card.width || 0) * 3, 900), 2400) })
              .png().toBuffer();
          }
        } catch { /* Unsupported OCR preparation keeps the original upload as the fallback. */ }
        if (cancelled) throw new Error('OCR request expired');
        const { data } = await worker.recognize(recognitionImage, undefined, { blocks: true });
        if (cancelled) throw new Error('OCR request expired');
        let parsed = parseReceiptRecognition(data);
        receiptResult = parsed;
        let walletFigureConflict = false;
        // Arabic display/message fonts can be read as 5, 000 or 600. Read their actual glyphs
        // before any general recovery can promote such a truncated or substituted figure.
        try {
          const messageAmount = await walletMessageAmount(recognitionImage, data);
          const walletFigure = parsed.pattern === 'wallet-app' && messageAmount == null
            ? await this.recoverWalletFigure(worker, recognitionImage, () => cancelled) : null;
          if (walletFigure?.ambiguous) {
            walletFigureConflict = true;
            parsed = { ...parsed, amount: null, amountSource: undefined, amountConfidence: 0, confident: false };
          }
          const amount = messageAmount ?? walletFigure?.amount;
          if (amount != null) {
            const method = parsed.method || (messageAmount != null ? 'فودافون كاش' : '');
            parsed = { ...parsed, amount, amountSource: 'currency', amountConfidence: walletFigure?.confidence ?? .9,
              method, pattern: parsed.pattern || 'wallet-app', confident: method !== '' };
          }
          if (parsed.amount == null && !parsed.method && Number(data.confidence) < 60 && !cancelled) {
            const photoAmount = await this.recoverUssdPhoto(worker, recognitionImage, data, () => cancelled);
            if (photoAmount != null) parsed = { ...parsed, amount: photoAmount, method: 'فودافون كاش', pattern: 'ussd',
              amountSource: 'sentence', amountConfidence: .9, confident: true };
          }
        } catch { /* Unsupported colour/word crops keep the general reader available. */ }
        if (cancelled) throw new Error('OCR request expired');
        if (walletFigureConflict) {
          receiptResult = parsed;
          return { ...parsed, ...(parsed.screenshotTime ? { screenshotTimeSource: 'screen-status-bar' as const } : {}) };
        }
        // Any figure read by any pass — including two passes that disagreed and were blanked on
        // purpose. The recovery pass below is for receipts where nothing was read at all; it must
        // never break a tie that was refused for being a tie.
        let anyReading = parsed.amount != null;
        // A large receipt figure can lose its trailing zeroes in OCR (500 EGP -> 5 EGP).
        // A single-digit InstaPay amount must be corroborated by the English pass before
        // it can be suggested to the employee.
        const tinyInstapayAmount = parsed.pattern === 'instapay' && parsed.amount != null && parsed.amount < 10;
        receiptResult = tinyInstapayAmount
          ? { ...parsed, amount: null, amountConfidence: 0, confident: false }
          : parsed;
        // A second language reading may recover Latin labels from the same OCR region.
        const needsDetails = /\b(?:reference|transaction date|date)\b/i.test(data.text || '')
          && (!parsed.reference || !parsed.dateText);
        const needsSender = parsed.pattern === 'instapay' && !parsed.senderHandle
          && /success|approved transaction|بنجاح|(?:^|\n)\s*(?:from|من)(?:\s|:|$)/i.test(data.text || '');
        if (tinyInstapayAmount || !parsed.confident || !['currency', 'sentence'].includes(parsed.amountSource || '') || needsDetails || needsSender) {
          try {
            await worker.reinitialize('eng');
            await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
            const englishData = (await worker.recognize(recognitionImage, undefined, { blocks: true })).data;
            const bankReceipt = /من\s+حساب\s+رقم|قيمة\s*ال(?:دفع|دقع|اقع)/.test(data.text || '');
            let english = parseReceiptRecognition(englishData, bankReceipt);
            if (english.amount != null) anyReading = true;
            // A Vodafone Cash app receipt whose «جنيه» the Arabic pass lost: the English pass still
            // sees the figure («a> 300.00»). Trusted only in the wallet's own «300.00» shape, and
            // never confident — the employee confirms it.
            // Vodafone Cash app: the Arabic model reads its light headline «400 جنيه» as «0 جنيه»
            // while the English model reads the figure (««400», ««> 400.00»). The zero headline
            // proves a currency figure stood there, so the English figure fills it — only when it
            // is the first figure on the English page, alone on its line and 10 or more.
            const zeroHeadline = normalizeOcrText(data.text || '').split('\n').map(l => l.trim()).filter(Boolean)
              .slice(0, 4).some(l => /^0(?:\.0+)?\s*جني[هھة]/.test(l));
            if (english.amount == null && parsed.amount == null && zeroHeadline) {
              const figure = englishHeadlineFigure(englishData.text || '');
              if (figure != null) {
                const banked = /حساب|بنك|\bbank\b|account|insta\s*pay/i.test(`${data.text}\n${englishData.text}`);
                english = { ...english, amount: figure, amountSource: 'currency', amountConfidence: .65,
                  method: english.method || parsed.method || (banked ? '' : 'فودافون كاش'),
                  pattern: english.pattern || parsed.pattern || 'wallet-app', confident: false };
              }
            }
            if (english.amount == null && parsed.amount == null && parsed.pattern === 'wallet-app') {
              const figure = parseReceiptRecognition(englishData, true);
              const exact = figure.amount != null
                && new RegExp(`(?:^|\\s)${figure.amount.toFixed(2).replace('.', '\\.')}(?:\\s|$)`, 'm').test(normalizeOcrText(englishData.text || ''));
              if (exact) english = { ...figure, amountSource: 'heading', amountConfidence: Math.min(figure.amountConfidence || .65, .65), confident: false };
            }
            const primary = parsed;
            const recoveredTinyAmount = tinyInstapayAmount && english.amount != null
              && [10, 100, 1000].includes(english.amount / Number(primary.amount))
              && ['currency', 'sentence'].includes(english.amountSource || '')
              && (english.amountConfidence || 0) >= .65;
            if (recoveredTinyAmount) {
              parsed = { ...english, method: english.method || primary.method, pattern: english.pattern || primary.pattern,
                senderName: english.senderName || primary.senderName,
                senderBank: english.senderBank || primary.senderBank,
                senderHandle: english.senderHandle || primary.senderHandle,
                senderPhone: english.senderPhone || primary.senderPhone,
                reference: english.reference || primary.reference,
                dateText: english.dateText || primary.dateText,
                screenshotTime: english.screenshotTime || primary.screenshotTime };
              parsed.confident = parsed.amount != null && parsed.method !== '' && (parsed.amountConfidence || 0) >= .7;
            } else if (tinyInstapayAmount) {
              parsed = { ...primary, amount: null, amountSource: undefined, amountConfidence: 0, confident: false };
            } else if (parsed.amount != null && english.amount != null && parsed.amount !== english.amount
              && (parsed.amountConfidence || 0) >= .6 && (english.amountConfidence || 0) >= .6) {
              parsed = { ...parsed, amount: null, amountConfidence: 0, confident: false };
            } else if (english.amount != null && (parsed.amount == null || (english.amountConfidence || 0) > (parsed.amountConfidence || 0))) {
              parsed = { ...english, method: english.method || parsed.method, pattern: english.pattern || parsed.pattern };
              parsed.confident = parsed.amount != null && parsed.method !== '' && (parsed.amountConfidence || 0) >= .7;
            } else if (parsed.amount != null && english.amount === parsed.amount && !parsed.method && english.method) {
              parsed = { ...parsed, method: english.method, pattern: english.pattern || parsed.pattern,
                confident: (parsed.amountConfidence || 0) >= .7 };
            }
            if (parsed.amount != null && (english.amount == null || primary.amount == null || english.amount === primary.amount)) {
              const referenceConflict = !!primary.reference && !!english.reference && primary.reference !== english.reference;
              const dateConflict = !!primary.dateText && !!english.dateText && primary.dateText !== english.dateText;
              const handleConflict = !!primary.senderHandle && !!english.senderHandle && primary.senderHandle !== english.senderHandle;
              const bankConflict = !!primary.senderBank && !!english.senderBank && primary.senderBank !== english.senderBank;
              const phoneConflict = !!primary.senderPhone && !!english.senderPhone && primary.senderPhone !== english.senderPhone;
              parsed = { ...parsed,
                senderName: parsed.senderName || primary.senderName || english.senderName,
                senderBank: bankConflict ? undefined : parsed.senderBank || primary.senderBank || english.senderBank,
                senderHandle: handleConflict ? undefined : parsed.senderHandle || primary.senderHandle || english.senderHandle,
                senderPhone: phoneConflict ? undefined : parsed.senderPhone || primary.senderPhone || english.senderPhone,
                reference: referenceConflict ? '' : parsed.reference || primary.reference || english.reference,
                dateText: dateConflict ? '' : parsed.dateText || primary.dateText || english.dateText,
                screenshotTime: parsed.screenshotTime || primary.screenshotTime || english.screenshotTime };
            }
          } finally {
            await worker.reinitialize('ara+eng');
            await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
          }
        }
        if (parsed.amount == null && !anyReading && !cancelled) {
          const recovered = await this.recoverAmount(worker, image, () => cancelled);
          if (recovered && recovered.amount != null) {
            const method = parsed.method || recovered.method;
            parsed = { ...parsed, amount: recovered.amount, amountSource: recovered.amountSource,
              amountConfidence: recovered.amountConfidence, method, pattern: parsed.pattern || recovered.pattern,
              reference: parsed.reference || recovered.reference, dateText: parsed.dateText || recovered.dateText,
              senderPhone: parsed.senderPhone || recovered.senderPhone,
              confident: method !== '' && (recovered.amountConfidence || 0) >= .7 };
          }
        }
        if (parsed.pattern === 'instapay' && !parsed.method && !cancelled) {
          const method = await this.recoverInstapayDestination(worker, recognitionImage, () => cancelled);
          if (method) {
            parsed = { ...parsed, method,
              confident: parsed.amount != null && (parsed.amountConfidence || 0) >= .7 };
          }
        }
        if (!parsed.method && /من\s+حساب\s+رقم/.test(data.text || '') && !cancelled) {
          // Some bank-wallet photos only reveal "Payment method: My Wallet" after contrast recovery.
          const original = await sharp(image).rotate().png().toBuffer();
          const meta = await sharp(original).metadata();
          const top = Math.floor(meta.height! * .68);
          const prepared = await sharp(original).extract({ left: 0, top, width: meta.width!, height: meta.height! - top })
            .resize({ width: 1000 }).grayscale().normalise().png().toBuffer();
          const recovered = parseReceiptText((await worker.recognize(prepared)).data.text);
          if (recovered.method) parsed = { ...parsed, method: recovered.method, pattern: recovered.pattern || parsed.pattern,
            confident: parsed.amount != null && (parsed.amountConfidence || 0) >= .7 };
        }
        if (fast && fast.amount === parsed.amount && (fast.amountConfidence || 0) >= .7) {
          parsed = { ...parsed, senderHandle: fast.senderHandle,
            reference: fast.reference, dateText: fast.dateText || parsed.dateText };
        }
        receiptResult = parsed;
        return { ...parsed, ...(parsed.screenshotTime ? { screenshotTimeSource: 'screen-status-bar' as const } : {}) };
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { cancelled = true; reject(new Error('OCR timeout')); }, timeoutMs);
      });
      const merged = await Promise.race([work, timeout]);
      return { ...merged, ran: true, ms: Date.now() - started };
    } catch (err) {
      this.logger.warn(`Receipt OCR failed after ${Date.now() - started}ms: ${(err as Error).message}`);
      await this.dropWorker();
      if (receiptResult) return { ...receiptResult, ran: true, ms: Date.now() - started };
      return { ...empty, ms: Date.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
