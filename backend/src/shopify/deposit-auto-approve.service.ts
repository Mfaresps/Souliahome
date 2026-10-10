import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { ShopifyOrder, ShopifyOrderDocument, DepositReceipt } from './schemas/shopify-order.schema';
import { DepositReceiptsService } from './deposit-receipts.service';
import { SettingsService } from '../settings/settings.service';
import { DEPOSIT_TOLERANCE } from './deposit-receipts.util';

export interface AutoApproveRunResult {
  scanned: number;
  approved: number;
  failed: number;
}

/**
 * Auto-approves ONLY the deposit receipts the manager review queue exists to filter out noise
 * from: a confident, unambiguous match between what OCR read off the transfer image and what the
 * employee typed in, with no duplicate-image / duplicate-reference / unclear-image warning.
 *
 * ⚠ THE ONE RULE: this service never writes a vault entry itself. It calls
 *   `DepositReceiptsService.approve()` — the exact same path a manager's click takes, with the
 *   exact same single-flight claim (`findOneAndUpdate` matching only «معلق»), the exact same
 *   room-left-on-the-order check, and the exact same vault write. Duplicating any of that here
 *   would let the two paths drift and double-book a receipt. The only thing added here is the
 *   DECISION of which receipts qualify — see `isClean()`.
 *
 * ⚠ "Clean" is a pure function of data already written by upload/submit, never re-derived from
 *   the image: `needsReview === false` (set by `DepositReceiptsService.needsReviewFor` at submit
 *   time — OCR was confident AND its amount/method agreed with what the employee entered, within
 *   `DEPOSIT_TOLERANCE`) and zero warnings of ANY kind (duplicate image, duplicate reference,
 *   non-transfer image, OCR unavailable). A receipt whose warning was explicitly acknowledged by
 *   its uploader (`warningAcknowledgedAt`) is still NOT auto-approved — an employee skipping their
 *   own warning is not the same signal as the system finding nothing wrong at all.
 */
@Injectable()
export class DepositAutoApproveService {
  private readonly logger = new Logger(DepositAutoApproveService.name);
  private running = false;

  constructor(
    @InjectModel(ShopifyOrder.name) private readonly orderModel: Model<ShopifyOrderDocument>,
    private readonly depositReceipts: DepositReceiptsService,
    private readonly settingsService: SettingsService,
  ) {}

  /** Pure — used by the cron, the manual "run now" endpoint, and the tests. */
  static isClean(r: DepositReceipt): boolean {
    if (r.status !== 'معلق') return false;
    if (r.needsReview) return false;
    if ((r.warnings || []).length > 0) return false;
    if (r.ocr?.amount == null || !r.ocr?.confident) return false;
    if (Math.abs((Number(r.ocr.amount) || 0) - (Number(r.amount) || 0)) > DEPOSIT_TOLERANCE) return false;
    if (!r.ocr.method || r.ocr.method !== r.method) return false;
    return true;
  }

  private async run(): Promise<AutoApproveRunResult> {
    const orders = await this.orderModel
      .find({ status: 'pending', cancelled: { $ne: true }, 'depositReceipts.status': 'معلق' })
      .select('depositReceipts')
      .lean()
      .exec();
    let scanned = 0;
    let approved = 0;
    let failed = 0;
    for (const o of orders as any[]) {
      for (const r of (o.depositReceipts || []) as DepositReceipt[]) {
        if (r.status !== 'معلق') continue;
        scanned++;
        if (!DepositAutoApproveService.isClean(r)) continue;
        try {
          await this.depositReceipts.approve(String(o._id), r.id, {
            id: '', username: 'system:auto-approve', name: 'الاعتماد التلقائي', isAdmin: true,
          });
          approved++;
        } catch (err: any) {
          failed++;
          this.logger.warn(`auto-approve failed order=${o._id} receipt=${r.id}: ${err?.message || err}`);
        }
      }
    }
    return { scanned, approved, failed };
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'deposit-auto-approve' })
  async runDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settings: any = await this.settingsService.getSettings();
      if (!settings?.autoApproveDepositsEnabled) return;
      const { scanned, approved, failed } = await this.run();
      if (approved || failed) {
        this.logger.log(`deposit-auto-approve: scanned=${scanned} approved=${approved} failed=${failed}`);
      }
    } catch (err: any) {
      this.logger.error(`deposit-auto-approve run failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  /** Manual "run now" — same decision, same path, just not waiting for the next minute. */
  async runNow(): Promise<AutoApproveRunResult> {
    return this.run();
  }

  /** How many pending receipts right now qualify, without approving anything — for the UI badge. */
  async pendingCleanCount(): Promise<number> {
    const orders = await this.orderModel
      .find({ status: 'pending', cancelled: { $ne: true }, 'depositReceipts.status': 'معلق' })
      .select('depositReceipts')
      .lean()
      .exec();
    let n = 0;
    for (const o of orders as any[]) {
      for (const r of (o.depositReceipts || []) as DepositReceipt[]) {
        if (DepositAutoApproveService.isClean(r)) n++;
      }
    }
    return n;
  }
}
