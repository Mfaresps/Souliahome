import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import sharp from 'sharp';
import { createWorker, Worker } from 'tesseract.js';
import { mergeReceiptPasses, parseReceiptText, ParsedReceipt } from './deposit-receipt-parser.util';
import { receiptOcrRegion, receiptTealAmount } from './receipt-image.util';
import { readArabicTealAmount } from './receipt-digit.util';
import { compressReceipt } from './receipt-upload-policy.util';
import { parseScreenClock, screenClockCrops } from './receipt-screen-time.util';

const OCR_TIMEOUT_MS = 20_000;

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
 *   also runs the API. The queue and 20-second deadline cover all preparation passes.
 *
 * The original two preparation passes were measured against 17 real screenshots (most are a
 *   receipt dialog over a dimmed chat): raw images gave the amount on 6/17; A alone 13/17; A+B
 *   14/17 with the parser rejecting the rest rather than guessing. See
 *   test/unit/deposit-receipt-parser.spec.ts.
 *     A — grayscale, 3× upscale, contrast-normalised, thresholded (dark and light dialogs both)
 *     B — grayscale, 2× upscale, contrast-normalised (Arabic Instapay layout)
 * A light-card crop now removes dimmed chat backgrounds before A/B. A third, lighter threshold
 * recovers pale recipient addresses. When the result is incomplete or lacks a currency anchor,
 * English-only recognition checks the light threshold and, if needed, a contrast-enhanced pass.
 * Original image storage is independent of these OCR-only filters.
 *
 * ⚠ A timeout terminates the worker. Leaving a stuck job in place would block every later
 *   upload behind it in the queue.
 */
@Injectable()
export class DepositReceiptOcrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DepositReceiptOcrService.name);
  private worker: Promise<Worker> | null = null;
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
      const cachePath = process.env.OCR_CACHE_DIR || path.join(process.cwd(), 'tessdata-cache');
      this.worker = createWorker(['ara', 'eng'], 1, {
        cachePath,
        // Tesseract also reports rejections from a worker event callback. Without this
        // handler it throws outside our promise catch and terminates the API process.
        errorHandler: error => this.logger.warn(`OCR worker failed: ${String(error)}`),
      }).then(async (w) => {
        // Sparse-text segmentation: a receipt is scattered labels and figures, not paragraphs.
        await w.setParameters({ tessedit_pageseg_mode: '11' as any });
        return w;
      });
      this.worker.catch(() => { this.worker = null; });
    }
    return this.worker;
  }

  private async dropWorker(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    try { await (await w).terminate(); } catch { /* already gone */ }
  }

  /**
   * Re-encodes an upload for storage: EXIF orientation applied, longest side capped, JPEG.
   * Also strips metadata (a phone photo can carry GPS) — the stored copy is the receipt only.
   */
  async prepareForStorage(input: Buffer): Promise<Buffer> {
    return compressReceipt(input);
  }

  private async passes(input: Buffer): Promise<Buffer[]> {
    input = await receiptOcrRegion(input);
    const meta = await sharp(input).metadata();
    const width = meta.width || 800;
    const a = await sharp(input)
      .grayscale()
      .resize({ width: Math.min(width * 3, 2600), kernel: 'lanczos3' })
      .normalise()
      .threshold(150)
      .png()
      .toBuffer();
    const b = await sharp(input)
      .grayscale()
      .resize({ width: Math.min(width * 2, 2400) })
      .normalise()
      .png()
      .toBuffer();
    // Pale recipient addresses are lost at 150; a lighter threshold preserves them.
    const c = await sharp(input).grayscale()
      .resize({ width: Math.min(Math.max(width * 4, 1400), 2600), kernel: 'lanczos3' })
      .normalise().threshold(235).png().toBuffer();
    const latin = await sharp(input).grayscale()
      .resize({ width: Math.min(Math.max(width * 5, 2000), 2600), kernel: 'lanczos3' })
      .linear(3, -510).png().toBuffer();
    return [a, b, c, latin];
  }

  /** Never throws: a failed read is an empty suggestion, never a failed upload. */
  read(image: Buffer): Promise<OcrResult> {
    const job = this.queue.then(() => this.readNow(image));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async readNow(image: Buffer): Promise<OcrResult> {
    const started = Date.now();
    const empty: OcrResult = {
      amount: null, method: '', pattern: '', reference: '', dateText: '', confident: false, ran: false, ms: 0,
    };
    let timer: NodeJS.Timeout | undefined;
    let receiptResult: ParsedReceipt | undefined;
    try {
      const work = (async () => {
        const worker = await this.getWorker();
        const parsed: ParsedReceipt[] = [];
        const texts: string[] = [];
        const preparedPasses = await this.passes(image);
        for (const prepared of preparedPasses.slice(0, 3)) {
          const { data } = await worker.recognize(prepared);
          texts.push(data.text || '');
          parsed.push(parseReceiptText(data.text || ''));
        }
        const walletLayout = parsed.some(p => p.pattern === 'wallet-app') && !parsed.some(p => p.pattern === 'instapay' || p.pattern === 'ussd');
        if (walletLayout) {
          texts.forEach((text,i)=>{parsed[i]=parseReceiptText(text,true);});
          const teal = await receiptTealAmount(image);
          const amount = teal ? await readArabicTealAmount(teal) : null;
          if (amount != null) parsed.push({ amount, method:'فودافون كاش', pattern:'wallet-app', reference:'', dateText:'', confident:true, amountSource:'currency' });
        }
        if (!mergeReceiptPasses(parsed).confident || !parsed.some(p => p.amountSource === 'currency' || p.amountSource === 'sentence')) {
          // Arabic recognition can corrupt pale Latin recipient handles and EGP digits.
          // Reuse the same worker and cached languages; the queue still has one worker.
          try {
            await worker.reinitialize('eng');
            await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
            for (const prepared of [preparedPasses[2], preparedPasses[3]]) {
              const { data } = await worker.recognize(prepared);
              parsed.push(parseReceiptText(data.text || '', walletLayout));
              if (mergeReceiptPasses(parsed).confident && parsed.some(p => p.amountSource === 'currency' || p.amountSource === 'sentence')) break;
            }
          } finally {
            await worker.reinitialize('ara+eng');
            await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
          }
        }
        const merged = mergeReceiptPasses(parsed);
        receiptResult = merged;
        // Keep receipt OCR independent; clock crops must never contribute an amount or reference.
        try {
          const {crops,source}=await screenClockCrops(image);
          const clocks: string[]=[];
          await worker.reinitialize('eng');
          await worker.setParameters({ tessedit_pageseg_mode: '7' as any, tessedit_char_whitelist: '0123456789٠١٢٣٤٥٦٧٨٩:：' });
          for(const crop of crops){
            const {data}=await worker.recognize(crop);
            const clock=parseScreenClock(data.text || '');if(clock)clocks.push(clock);
          }
          if(clocks.length && new Set(clocks).size===1)return {...merged,screenshotTime:clocks[0],screenshotTimeSource:source};
        } catch { /* An unreadable clock does not invalidate the transfer receipt. */ }
        finally {
          await worker.reinitialize('ara+eng');
          await worker.setParameters({ tessedit_pageseg_mode: '11' as any, tessedit_char_whitelist: '' });
        }
        return merged;
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OCR timeout')), OCR_TIMEOUT_MS);
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
