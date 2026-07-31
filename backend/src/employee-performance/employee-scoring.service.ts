import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EmployeePerformanceLog,
  EmployeePerformanceLogDocument,
  PerformanceActionType,
} from './schemas/employee-performance-log.schema';
import { ShopifyOrder, ShopifyOrderDocument } from '../shopify/schemas/shopify-order.schema';
import { Transaction, TransactionDocument } from '../transactions/schemas/transaction.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { EmployeeShift, EmployeeShiftDocument } from './schemas/employee-shift.schema';
import { UsersService } from '../users/users.service';
import { SettingsService } from '../settings/settings.service';
import { Settings } from '../settings/schemas/settings.schema';

export interface PerformanceDashboardRow {
  employeeId: string;
  employeeName: string;
  employeeAvatar: string;
  employeeJobTitle: string;
  assignedOrdersCount: number;
  confirmedOrdersCount: number;
  deliveredOrdersCount: number;
  depositConversionRate: number; // % confirmed orders with depositStatus !== 'none'
  avgConfirmationSpeedMinutes: number;
  earnedPoints: number; // sum of all automatic scoring (everything except manual_bonus)
  bonusPoints: number;  // sum of manual_bonus adjustments (can be negative)
  totalPoints: number;  // earnedPoints + bonusPoints
}

@Injectable()
export class EmployeeScoringService {
  private readonly logger = new Logger(EmployeeScoringService.name);

  constructor(
    @InjectModel(EmployeePerformanceLog.name)
    private readonly logModel: Model<EmployeePerformanceLogDocument>,
    @InjectModel(ShopifyOrder.name) private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
    @InjectModel(Transaction.name) private readonly txModel: Model<TransactionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(EmployeeShift.name) private readonly shiftModel: Model<EmployeeShiftDocument>,
    private readonly usersService: UsersService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Called from ShopifyService.approveOrder(). Awards confirmation-speed points to
   * whoever actually confirmed the order (not necessarily who it was assigned to).
   * Deposit points are scored separately, at order-arrival time — see scoreDepositDetection().
   * Never throws — callers already wrap this in .catch() as fire-and-forget.
   */
  async scoreConfirmation(order: ShopifyOrderDocument, confirmedByUsername: string): Promise<void> {
    try {
      const alreadyScored = await this.logModel
        .exists({ orderId: String(order._id), actionType: 'confirmation_speed' })
        .exec();
      if (alreadyScored) return;

      const user = await this.usersService.findByUsername(confirmedByUsername);
      if (!user) {
        this.logger.warn(`Cannot score confirmation for order ${order._id}: user "${confirmedByUsername}" not found`);
        return;
      }
      const employeeId = String(user._id);

      if (!order.shopifyCreatedAt || !order.reviewedAt) return;
      const settings = await this.settingsService.getSettings();
      const confSpeed = this.scoreSpeedPoints(order.shopifyCreatedAt, order.reviewedAt, settings.performanceConfig);
      await this.logModel.create({
        employeeId,
        orderId: String(order._id),
        actionType: 'confirmation_speed',
        points: confSpeed.points,
        note: `سرعة التأكيد — ${confSpeed.minutes} دقيقة`,
        meta: { minutes: confSpeed.minutes },
      });
    } catch (err) {
      this.logger.error(`scoreConfirmation failed for order ${order._id}: ${(err as Error).message}`);
    }
  }

  /**
   * Called from ShopifyService.handleOrder() (new order webhook) and handleOrderUpdate()
   * (notes changed) right after the order's deposit fields are (re-)parsed. Awards points
   * to the currently-assigned employee — the order is still pending at this point, so no
   * "confirmed by" exists yet. Silently skipped if the order has no assignee.
   *
   * Idempotent per note-content: if called again with the SAME parsed deposit result for
   * an order that already has a deposit_* row, it's a no-op. If the result CHANGED (notes
   * were edited), the previous deposit_* row for this order is deleted and replaced.
   */
  async scoreDepositDetection(order: ShopifyOrderDocument): Promise<void> {
    try {
      if (!order.assignedTo) return;

      const existing = await this.logModel
        .findOne({ orderId: String(order._id), actionType: { $in: this.depositActionTypes } })
        .lean()
        .exec();

      const settings = await this.settingsService.getSettings();
      const depositScore = this.scoreDepositPoints(order.depositStatus, order.depositPercentage, settings.performanceConfig);
      if (
        existing &&
        existing.employeeId === order.assignedTo &&
        existing.actionType === depositScore.actionType &&
        existing.points === depositScore.points
      ) {
        return; // unchanged — same employee, same result — nothing to do
      }
      if (existing) {
        // Deletes the row even if it belonged to a different (previously assigned) employee —
        // deposit credit always follows the CURRENT assignee, never stays with a prior one.
        await this.logModel.deleteOne({ _id: existing._id }).exec();
      }

      await this.logModel.create({
        employeeId: order.assignedTo,
        orderId: String(order._id),
        actionType: depositScore.actionType,
        points: depositScore.points,
        note: `تحليل إيداع عند وصول الأوردر — ${order.depositPercentage}% — ${order.depositAmount} EGP`,
        meta: { depositPercentage: order.depositPercentage, depositAmount: order.depositAmount },
      });
    } catch (err) {
      this.logger.error(`scoreDepositDetection failed for order ${order._id}: ${(err as Error).message}`);
    }
  }

  /**
   * Called from BostaService when a transaction transitions into DELIVERED status
   * and is linked to a Shopify order. Never throws.
   */
  async scoreDelivery(tx: TransactionDocument): Promise<void> {
    try {
      if (!tx.shopifyOrderId) return;

      const order = await this.shopifyOrderModel.findOne({ shopifyId: tx.shopifyOrderId }).exec();
      if (!order) return;

      const alreadyScored = await this.logModel
        .exists({ orderId: String(order._id), actionType: 'delivery_completed' })
        .exec();
      if (alreadyScored) return;

      const creditedUsername = order.reviewedBy || order.assignedTo;
      if (!creditedUsername) return;

      // reviewedBy is a username string (set from req.user.username in approveOrder);
      // assignedTo is a User._id string (set by resolveAssignee). Resolve either shape to an _id.
      let employeeId: string | null = null;
      const byUsername = await this.usersService.findByUsername(creditedUsername);
      if (byUsername) {
        employeeId = String(byUsername._id);
      } else {
        const byId = await this.usersService.findById(creditedUsername);
        if (byId) employeeId = String(byId._id);
      }
      if (!employeeId) {
        this.logger.warn(`Cannot score delivery for order ${order._id}: no resolvable employee`);
        return;
      }

      const settings = await this.settingsService.getSettings();
      const points = settings.performanceConfig?.deliveryPoints ?? 2;

      await this.logModel.create({
        employeeId,
        orderId: String(order._id),
        actionType: 'delivery_completed',
        points,
        note: `تسليم ناجح — الأوردر #${order.ref}`,
        meta: { txId: String(tx._id) },
      });
    } catch (err) {
      this.logger.error(`scoreDelivery failed for tx ${tx._id}: ${(err as Error).message}`);
    }
  }

  async getDashboardStats(): Promise<PerformanceDashboardRow[]> {
    // Only staff with a configured shift appear — a roster of "who's actually
    // scheduled", not every staff account in the system.
    const shifts = await this.shiftModel.find().select('userId').lean().exec();
    const scheduledUserIds = shifts.map((s) => s.userId);
    if (scheduledUserIds.length === 0) return [];

    const staff = await this.userModel
      .find({ role: 'staff', _id: { $in: scheduledUserIds } })
      .select('_id name username avatar jobTitle')
      .lean()
      .exec();
    if (staff.length === 0) return [];

    const staffIds = staff.map((s) => String(s._id));
    const staffUsernames = staff.map((s) => s.username).filter(Boolean);

    const [pointsAgg, assignedCounts, confirmedOrders, deliveredCounts] = await Promise.all([
      this.logModel.aggregate([
        { $match: { employeeId: { $in: staffIds } } },
        {
          $group: {
            _id: '$employeeId',
            earnedPoints: { $sum: { $cond: [{ $eq: ['$actionType', 'manual_bonus'] }, 0, '$points'] } },
            bonusPoints: { $sum: { $cond: [{ $eq: ['$actionType', 'manual_bonus'] }, '$points', 0] } },
          },
        },
      ]),
      this.shopifyOrderModel.aggregate([
        { $match: { assignedTo: { $in: staffIds } } },
        { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
      ]),
      this.shopifyOrderModel
        .find({ reviewedBy: { $in: staffUsernames }, status: 'approved' })
        .select('reviewedBy shopifyCreatedAt reviewedAt depositStatus')
        .lean()
        .exec(),
      this.logModel.aggregate([
        { $match: { actionType: 'delivery_completed', employeeId: { $in: staffIds } } },
        { $group: { _id: '$employeeId', count: { $sum: 1 } } },
      ]),
    ]);

    const earnedById = new Map<string, number>(pointsAgg.map((r) => [r._id, r.earnedPoints]));
    const bonusById = new Map<string, number>(pointsAgg.map((r) => [r._id, r.bonusPoints]));
    const assignedById = new Map<string, number>(assignedCounts.map((r) => [r._id, r.count]));
    const deliveredById = new Map<string, number>(deliveredCounts.map((r) => [r._id, r.count]));

    const confirmedByUsername = new Map<string, { total: number; withDeposit: number; speedSumMin: number; speedCount: number }>();
    for (const o of confirmedOrders) {
      const key = o.reviewedBy;
      const bucket = confirmedByUsername.get(key) || { total: 0, withDeposit: 0, speedSumMin: 0, speedCount: 0 };
      bucket.total += 1;
      if (o.depositStatus && o.depositStatus !== 'none') bucket.withDeposit += 1;
      if (o.shopifyCreatedAt && o.reviewedAt) {
        const minutes = this.minutesBetween(o.shopifyCreatedAt, o.reviewedAt);
        if (minutes !== null) {
          bucket.speedSumMin += minutes;
          bucket.speedCount += 1;
        }
      }
      confirmedByUsername.set(key, bucket);
    }

    const rows: PerformanceDashboardRow[] = staff.map((u) => {
      const id = String(u._id);
      const confirmed = confirmedByUsername.get(u.username || '') || { total: 0, withDeposit: 0, speedSumMin: 0, speedCount: 0 };
      return {
        employeeId: id,
        employeeName: u.name || u.username || '',
        employeeAvatar: u.avatar || '',
        employeeJobTitle: u.jobTitle || '',
        assignedOrdersCount: assignedById.get(id) || 0,
        confirmedOrdersCount: confirmed.total,
        deliveredOrdersCount: deliveredById.get(id) || 0,
        depositConversionRate: confirmed.total > 0 ? Math.round((confirmed.withDeposit / confirmed.total) * 100) : 0,
        avgConfirmationSpeedMinutes: confirmed.speedCount > 0 ? Math.round(confirmed.speedSumMin / confirmed.speedCount) : 0,
        earnedPoints: earnedById.get(id) || 0,
        bonusPoints: bonusById.get(id) || 0,
        totalPoints: (earnedById.get(id) || 0) + (bonusById.get(id) || 0),
      };
    });

    return rows.sort((a, b) => b.totalPoints - a.totalPoints);
  }

  /**
   * Lightweight personal summary for any user (not restricted to staff-with-a-shift
   * like getDashboardStats) — used by UserHub/profile pages: total performance points
   * and count of orders successfully delivered while confirmed by this user.
   */
  async getMyPerformanceSummary(userId: string): Promise<{ totalPoints: number; deliveredOrdersCount: number }> {
    const [pointsAgg, deliveredCount] = await Promise.all([
      this.logModel.aggregate([
        { $match: { employeeId: userId } },
        { $group: { _id: null, totalPoints: { $sum: '$points' } } },
      ]),
      this.logModel.countDocuments({ employeeId: userId, actionType: 'delivery_completed' }),
    ]);
    return {
      totalPoints: pointsAgg[0]?.totalPoints || 0,
      deliveredOrdersCount: deliveredCount,
    };
  }

  /**
   * Home-page widget for staff: their own assigned Shopify orders within a time window,
   * plus how many already have an auto-detected deposit (depositStatus !== 'none') vs.
   * still pending. Read-only summary — no new scoring, reuses the same depositStatus
   * field ScoreDepositDetection already populates at order-arrival time.
   */
  async getMyAssignedOrders(
    userId: string,
    period: 'today' | 'week',
  ): Promise<{
    total: number;
    depositConfirmed: number;
    pending: Array<{ id: string; ref: string; client: string; depositStatus: string; assignedAt: string }>;
  }> {
    const since = new Date();
    if (period === 'today') {
      since.setHours(0, 0, 0, 0);
    } else {
      since.setDate(since.getDate() - 7);
    }

    const orders = await this.shopifyOrderModel
      .find({ assignedTo: userId, assignedAt: { $gte: since.toISOString() }, cancelled: { $ne: true } })
      .select('ref client depositStatus assignedAt')
      .sort({ assignedAt: -1 })
      .lean()
      .exec();

    const depositConfirmed = orders.filter((o) => o.depositStatus && o.depositStatus !== 'none').length;
    const pending = orders
      .filter((o) => !o.depositStatus || o.depositStatus === 'none')
      .map((o) => ({
        id: String(o._id),
        ref: o.ref,
        client: o.client,
        depositStatus: o.depositStatus || 'none',
        assignedAt: o.assignedAt,
      }));

    return { total: orders.length, depositConfirmed, pending };
  }

  async getLogs(filter: { employeeId?: string; orderId?: string }): Promise<EmployeePerformanceLogDocument[]> {
    const query: Record<string, unknown> = {};
    if (filter.employeeId) query.employeeId = filter.employeeId;
    if (filter.orderId) query.orderId = filter.orderId;
    return this.logModel.find(query).sort({ createdAt: -1 }).limit(500).exec();
  }

  /** Admin-only manual point adjustment — positive (bonus) or negative (penalty/correction). Not tied to any order. */
  async addManualBonus(
    employeeId: string,
    points: number,
    reason: string,
    adjustedBy: string,
  ): Promise<EmployeePerformanceLogDocument> {
    return this.logModel.create({
      employeeId,
      orderId: '',
      actionType: 'manual_bonus',
      points,
      note: reason,
      meta: { adjustedBy },
    });
  }

  private readonly depositActionTypes: PerformanceActionType[] = [
    'deposit_full',
    'deposit_partial_50',
    'deposit_partial_low',
    'deposit_none',
  ];

  private scoreDepositPoints(
    depositStatus: string,
    depositPercentage: number,
    cfg?: Partial<Settings['performanceConfig']>,
  ): { points: number; actionType: PerformanceActionType } {
    if (depositStatus === 'full') return { points: cfg?.depositFullPoints ?? 5, actionType: 'deposit_full' };
    if (depositPercentage >= 50) return { points: cfg?.depositPartial50Points ?? 3, actionType: 'deposit_partial_50' };
    if (depositPercentage > 0) return { points: cfg?.depositPartialLowPoints ?? 2, actionType: 'deposit_partial_low' };
    return { points: cfg?.depositNonePoints ?? 1, actionType: 'deposit_none' };
  }

  /** <15min=configurable, <1h=configurable, <4h=configurable, else=0 */
  private scoreSpeedPoints(
    startIso: string,
    endIso: string,
    cfg?: Partial<Settings['performanceConfig']>,
  ): { points: number; minutes: number } {
    const minutes = this.minutesBetween(startIso, endIso) ?? Infinity;
    let points = 0;
    if (minutes < 15) points = cfg?.speedUnder15MinPoints ?? 3;
    else if (minutes < 60) points = cfg?.speedUnder1HourPoints ?? 2;
    else if (minutes < 240) points = cfg?.speedUnder4HoursPoints ?? 1;
    return { points, minutes: Number.isFinite(minutes) ? Math.round(minutes) : -1 };
  }

  private minutesBetween(startIso: string, endIso: string): number | null {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    if (isNaN(start) || isNaN(end) || end < start) return null;
    return (end - start) / 60000;
  }
}
