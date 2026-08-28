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

/**
 * The scoring period. Points are NOT deleted at the end of a period — they are
 * always *computed* within one, so the first of the month naturally starts at
 * zero because the query window starts there. This keeps the append-only log
 * intact (a past month can still be reopened and printed) and needs no cron job.
 * See PERIOD RESOLUTION in employee-performance docs.
 */
export type PerformancePeriod = 'week' | 'month' | 'year' | 'all';

export interface PerformancePeriodRange {
  period: PerformancePeriod;
  /** inclusive ISO start, or null for 'all' */
  start: Date | null;
  /** exclusive ISO end, or null for 'all' */
  end: Date | null;
  /** e.g. "2026-08" / "2026-W35" / "2026" — stable id for the period, used as a cache/label key */
  key: string;
}

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
  earnedPoints: number; // sum of all automatic scoring (everything except manual_bonus) WITHIN the period
  bonusPoints: number;  // sum of manual_bonus adjustments (can be negative) WITHIN the period
  totalPoints: number;  // earnedPoints + bonusPoints — the period score, resets each period
  /** Same total for the immediately-preceding period of the same length — powers the trend arrow. */
  prevPeriodPoints: number;
  /** Lifetime total across every period. Shown as context; never the ranking key. */
  allTimePoints: number;
}

export interface PerformanceDashboardResult {
  period: PerformancePeriod;
  periodKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string;
  /** Key of the period before/after this one — the arrows are built from these, not recomputed. */
  prevPeriodKey: string | null;
  nextPeriodKey: string | null;
  /** True when this window contains today. The UI uses it to disable "next" and mark "الحالي". */
  isCurrentPeriod: boolean;
  rows: PerformanceDashboardRow[];
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

  /**
   * PERIOD RESOLUTION — the single place a period name becomes a date window.
   *
   * ⚠ Every consumer (dashboard, my-summary, logs, export) MUST go through this.
   * Two callers computing "this month" independently is how a leaderboard and the
   * payslip it justifies end up disagreeing by a day.
   *
   * The week starts SUNDAY, matching the frontend's existing `now.getDay()`
   * convention in `_perfDetailFilteredLogs` — don't switch one side to Monday.
   *
   * `ref` exists so the *previous* period can be resolved by the same code that
   * resolves the current one; there is no separate "previous" branch to drift.
   */
  resolvePeriod(
    period: string | undefined,
    ref: Date = new Date(),
    periodKey?: string,
  ): PerformancePeriodRange {
    const p: PerformancePeriod =
      period === 'week' || period === 'year' || period === 'all' ? period : 'month';

    // A supplied key selects WHICH period, by moving the reference date — it never
    // becomes a second way to compute a window. That is what keeps "August" and
    // "this month, when it is August" byte-identical instead of two near-copies
    // that drift. An unparseable key falls back to `ref` (i.e. the current period)
    // rather than erroring: a stale bookmark should land on today, not a 400.
    const anchored = periodKey ? this.anchorFromKey(p, periodKey) : null;
    if (anchored) ref = anchored;

    if (p === 'all') return { period: p, start: null, end: null, key: 'all' };

    const y = ref.getFullYear();
    if (p === 'year') {
      return {
        period: p,
        start: new Date(y, 0, 1),
        end: new Date(y + 1, 0, 1),
        key: String(y),
      };
    }
    if (p === 'week') {
      const start = new Date(y, ref.getMonth(), ref.getDate() - ref.getDay());
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
      return { period: p, start, end, key: this.isoWeekKey(start) };
    }
    // month — the reset cycle the whole feature is built around
    const start = new Date(y, ref.getMonth(), 1);
    const end = new Date(y, ref.getMonth() + 1, 1);
    return { period: p, start, end, key: `${y}-${String(ref.getMonth() + 1).padStart(2, '0')}` };
  }

  /**
   * `periodKey` → the reference date that resolves to that exact period.
   *
   * The keys are the SAME strings resolvePeriod() emits ("2026-08", "2026-W34",
   * "2026"), so the API's own output is valid input — the round-trip is what makes
   * a month shareable as a URL and re-openable later. Returns null on anything
   * unrecognised, and the caller then keeps the current period.
   *
   * ⚠ Dates are constructed with the local-midnight constructor, never
   * `new Date("2026-08-01")` — that string form parses as UTC midnight and shifts a
   * day in any negative-offset zone, the same trap documented for `_vltDayGap`.
   */
  private anchorFromKey(period: PerformancePeriod, key: string): Date | null {
    const k = String(key || '').trim();
    if (!k || period === 'all') return null;

    if (period === 'year') {
      const m = /^(\d{4})$/.exec(k);
      if (!m) return null;
      const y = Number(m[1]);
      return this.isSaneYear(y) ? new Date(y, 0, 1) : null;
    }

    if (period === 'month') {
      const m = /^(\d{4})-(\d{2})$/.exec(k);
      if (!m) return null;
      const y = Number(m[1]), mo = Number(m[2]);
      if (!this.isSaneYear(y) || mo < 1 || mo > 12) return null;
      return new Date(y, mo - 1, 1);
    }

    // week — "2026-W34", counted from Jan 1 in 7-day blocks, matching isoWeekKey().
    const m = /^(\d{4})-W(\d{1,2})$/i.exec(k);
    if (!m) return null;
    const y = Number(m[1]), w = Number(m[2]);
    if (!this.isSaneYear(y) || w < 1 || w > 53) return null;
    // Anchor on the same first-Sunday origin isoWeekKey() counts from, so the key
    // round-trips unchanged. resolvePeriod('week') still does the Sunday snap — this
    // only has to land inside the right block.
    const jan1 = new Date(y, 0, 1);
    return new Date(y, 0, 1 - jan1.getDay() + (w - 1) * 7);
  }

  /** Guards against a malformed key producing a window thousands of years wide. */
  private isSaneYear(y: number): boolean {
    return Number.isInteger(y) && y >= 2000 && y <= 2100;
  }

  /** The period of the same length immediately before `range` — used for the trend delta. */
  private previousPeriod(range: PerformancePeriodRange): PerformancePeriodRange | null {
    if (!range.start) return null;
    const s = range.start;
    if (range.period === 'year') return this.resolvePeriod('year', new Date(s.getFullYear() - 1, 0, 1));
    if (range.period === 'week') {
      return this.resolvePeriod('week', new Date(s.getFullYear(), s.getMonth(), s.getDate() - 7));
    }
    return this.resolvePeriod('month', new Date(s.getFullYear(), s.getMonth() - 1, 1));
  }

  /** The period of the same length immediately after `range`. Mirrors previousPeriod(). */
  private nextPeriod(range: PerformancePeriodRange): PerformancePeriodRange | null {
    if (!range.start || !range.end) return null;
    // `end` is exclusive, so it is already the first instant of the next period —
    // deriving the next window from it means the two can never leave a gap or overlap.
    return this.resolvePeriod(range.period, new Date(range.end.getTime()));
  }

  /** Does this window contain now? Decides whether "next" is a future period. */
  private isCurrentPeriod(range: PerformancePeriodRange): boolean {
    if (!range.start || !range.end) return true; // 'all' always includes today
    const now = Date.now();
    return now >= range.start.getTime() && now < range.end.getTime();
  }

  /**
   * Week number for a Sunday-aligned week start.
   *
   * ⚠ Counted from the FIRST SUNDAY ON OR BEFORE Jan 1, not from Jan 1 itself.
   * Counting from Jan 1 numbered the weeks by a boundary that resolvePeriod() then
   * snapped backwards to Sunday, so every key resolved to the week before it and a
   * "previous week" link walked two weeks back. This function and the Sunday snap in
   * resolvePeriod() must share one definition of where a week begins — locked in by
   * the round-trip assertion in the period tests.
   *
   * The year comes from the week's own Sunday, so a week straddling New Year belongs
   * to the year it STARTED in. One consequence, and it is the intended one: when Jan 1
   * is not a Sunday, "2026-W01" and "2025-W53" name the same seven days, and both
   * normalize to "2025-W53". The alias is accepted on input and canonicalised on
   * output, so getAvailablePeriods() can never list one week twice.
   */
  private isoWeekKey(weekStart: Date): string {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const firstSunday = new Date(jan1.getFullYear(), 0, 1 - jan1.getDay());
    const week = Math.round((d.getTime() - firstSunday.getTime()) / (7 * 86400000)) + 1;
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  /** Arabic label for the resolved window — the header must state exactly what is being counted. */
  private periodLabel(range: PerformancePeriodRange): string {
    if (!range.start || !range.end) return 'كل الفترات';
    const fmt = (d: Date) =>
      d.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' });
    if (range.period === 'year') return `سنة ${range.start.getFullYear()}`;
    if (range.period === 'month') {
      return range.start.toLocaleDateString('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' });
    }
    const lastDay = new Date(range.end.getTime() - 86400000);
    return `${fmt(range.start)} — ${fmt(lastDay)}`;
  }

  /**
   * Mongo match fragment restricting a log query to `range`.
   *
   * ⚠ Filters on `createdAt` — the moment the POINT was awarded, not the order's own
   * date. A delivery scored in September for an order placed in August belongs to
   * September's scorecard, because that is the month the employee did the work that
   * earned it. This mirrors the cancellations report's `cancelledAt` rule.
   */
  private periodMatch(range: PerformancePeriodRange): Record<string, unknown> {
    if (!range.start || !range.end) return {};
    return { createdAt: { $gte: range.start, $lt: range.end } };
  }

  /** Same window, applied to an ISO-*string* date field (Shopify orders store strings, not Dates). */
  private periodMatchIsoString(range: PerformancePeriodRange, field: string): Record<string, unknown> {
    if (!range.start || !range.end) return {};
    return { [field]: { $gte: range.start.toISOString(), $lt: range.end.toISOString() } };
  }

  /**
   * The leaderboard, scoped to one period.
   *
   * ⚠ EVERY figure in a row is bounded by the same window — points, assigned,
   * confirmed, delivered, deposit rate and speed. An unbounded counter sitting
   * beside a monthly point total is the single most misleading thing this panel
   * could show: it would rank on the month while explaining with all-time work.
   */
  async getDashboardStats(period?: string, periodKey?: string): Promise<PerformanceDashboardResult> {
    const range = this.resolvePeriod(period, new Date(), periodKey);
    const prev = this.previousPeriod(range);
    const next = this.nextPeriod(range);
    const isCurrent = this.isCurrentPeriod(range);
    const base: PerformanceDashboardResult = {
      period: range.period,
      periodKey: range.key,
      periodStart: range.start ? range.start.toISOString() : null,
      periodEnd: range.end ? range.end.toISOString() : null,
      periodLabel: this.periodLabel(range),
      prevPeriodKey: prev ? prev.key : null,
      // Never offer a future period: a window that has not happened yet can only ever
      // show zeroes, which reads as "everyone failed" rather than "not yet".
      nextPeriodKey: next && !isCurrent ? next.key : null,
      isCurrentPeriod: isCurrent,
      rows: [],
    };

    // Only staff with a configured shift appear — a roster of "who's actually
    // scheduled", not every staff account in the system.
    const shifts = await this.shiftModel.find().select('userId').lean().exec();
    const scheduledUserIds = shifts.map((s) => s.userId);
    if (scheduledUserIds.length === 0) return base;

    const staff = await this.userModel
      .find({ role: 'staff', _id: { $in: scheduledUserIds } })
      .select('_id name username avatar jobTitle')
      .lean()
      .exec();
    if (staff.length === 0) return base;

    const staffIds = staff.map((s) => String(s._id));
    const staffUsernames = staff.map((s) => s.username).filter(Boolean);
    const inPeriod = this.periodMatch(range);

    const [pointsAgg, allTimeAgg, prevAgg, assignedCounts, confirmedOrders, deliveredCounts] =
      await Promise.all([
        this.logModel.aggregate([
          { $match: { employeeId: { $in: staffIds }, ...inPeriod } },
          {
            $group: {
              _id: '$employeeId',
              earnedPoints: { $sum: { $cond: [{ $eq: ['$actionType', 'manual_bonus'] }, 0, '$points'] } },
              bonusPoints: { $sum: { $cond: [{ $eq: ['$actionType', 'manual_bonus'] }, '$points', 0] } },
            },
          },
        ]),
        // Lifetime context. Deliberately NOT the ranking key — the period total is.
        this.logModel.aggregate([
          { $match: { employeeId: { $in: staffIds } } },
          { $group: { _id: '$employeeId', total: { $sum: '$points' } } },
        ]),
        prev
          ? this.logModel.aggregate([
              { $match: { employeeId: { $in: staffIds }, ...this.periodMatch(prev) } },
              { $group: { _id: '$employeeId', total: { $sum: '$points' } } },
            ])
          : Promise.resolve([] as Array<{ _id: string; total: number }>),
        this.shopifyOrderModel.aggregate([
          { $match: { assignedTo: { $in: staffIds }, ...this.periodMatchIsoString(range, 'assignedAt') } },
          { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
        ]),
        this.shopifyOrderModel
          .find({
            reviewedBy: { $in: staffUsernames },
            status: 'approved',
            ...this.periodMatchIsoString(range, 'reviewedAt'),
          })
          .select('reviewedBy shopifyCreatedAt reviewedAt depositStatus')
          .lean()
          .exec(),
        this.logModel.aggregate([
          {
            $match: {
              actionType: 'delivery_completed',
              employeeId: { $in: staffIds },
              ...inPeriod,
            },
          },
          { $group: { _id: '$employeeId', count: { $sum: 1 } } },
        ]),
      ]);

    const earnedById = new Map<string, number>(pointsAgg.map((r) => [r._id, r.earnedPoints]));
    const bonusById = new Map<string, number>(pointsAgg.map((r) => [r._id, r.bonusPoints]));
    const allTimeById = new Map<string, number>(allTimeAgg.map((r) => [r._id, r.total]));
    const prevById = new Map<string, number>(prevAgg.map((r) => [r._id, r.total]));
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
      const earned = earnedById.get(id) || 0;
      const bonus = bonusById.get(id) || 0;
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
        earnedPoints: earned,
        bonusPoints: bonus,
        totalPoints: earned + bonus,
        prevPeriodPoints: prevById.get(id) || 0,
        allTimePoints: allTimeById.get(id) || 0,
      };
    });

    base.rows = rows.sort((a, b) => b.totalPoints - a.totalPoints);
    return base;
  }

  /**
   * Lightweight personal summary for any user (not restricted to staff-with-a-shift
   * like getDashboardStats) — used by UserHub/profile pages: performance points and
   * deliveries WITHIN the requested period, plus the previous period and the lifetime
   * total as context. Defaults to the current month, so a staff member's own number
   * is the same number the leaderboard ranks them on. Goes through resolvePeriod()
   * for exactly that reason — see PERIOD RESOLUTION.
   */
  async getMyPerformanceSummary(
    userId: string,
    period?: string,
    periodKey?: string,
  ): Promise<{
    period: PerformancePeriod;
    periodKey: string;
    periodLabel: string;
    totalPoints: number;
    deliveredOrdersCount: number;
    prevPeriodPoints: number;
    allTimePoints: number;
  }> {
    const range = this.resolvePeriod(period, new Date(), periodKey);
    const prev = this.previousPeriod(range);
    const inPeriod = this.periodMatch(range);

    const [pointsAgg, deliveredCount, prevAgg, allTimeAgg] = await Promise.all([
      this.logModel.aggregate([
        { $match: { employeeId: userId, ...inPeriod } },
        { $group: { _id: null, totalPoints: { $sum: '$points' } } },
      ]),
      this.logModel.countDocuments({ employeeId: userId, actionType: 'delivery_completed', ...inPeriod }),
      prev
        ? this.logModel.aggregate([
            { $match: { employeeId: userId, ...this.periodMatch(prev) } },
            { $group: { _id: null, totalPoints: { $sum: '$points' } } },
          ])
        : Promise.resolve([] as Array<{ totalPoints: number }>),
      this.logModel.aggregate([
        { $match: { employeeId: userId } },
        { $group: { _id: null, totalPoints: { $sum: '$points' } } },
      ]),
    ]);

    return {
      period: range.period,
      periodKey: range.key,
      periodLabel: this.periodLabel(range),
      totalPoints: pointsAgg[0]?.totalPoints || 0,
      deliveredOrdersCount: deliveredCount,
      prevPeriodPoints: prevAgg[0]?.totalPoints || 0,
      allTimePoints: allTimeAgg[0]?.totalPoints || 0,
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

  /**
   * The point-by-point audit trail behind a row's total.
   *
   * ⚠ `period` must default to the SAME window the dashboard row was computed in,
   * or the drill-down will not add up to the number that was clicked — the classic
   * way an otherwise-correct leaderboard loses its credibility. The caller passes
   * the period it is currently showing; 'all' explicitly opens the full history.
   *
   * The 500-row cap is reported rather than silently applied, so a truncated
   * history is never mistaken for a complete one.
   */
  /**
   * The periods that actually contain scoring activity, newest first.
   *
   * The picker is built from this rather than from an open-ended calendar: offering
   * every month back to 2000 makes the user hunt for the handful that have data, and
   * a month that predates the system is not a period the business ever had. The
   * current period is always included even when empty — it is the one the hub opens
   * on, and it must not be missing from its own selector on the 1st of the month.
   *
   * Grouped in JS rather than with $dateToString because the boundaries must be
   * LOCAL (the reset is local midnight); $dateToString would bucket by UTC and put
   * the first hours of each month in the previous one.
   */
  async getAvailablePeriods(period?: string): Promise<{
    period: PerformancePeriod;
    periods: Array<{ key: string; label: string; count: number; points: number; isCurrent: boolean }>;
  }> {
    const p: PerformancePeriod =
      period === 'week' || period === 'year' || period === 'all' ? period : 'month';

    const current = this.resolvePeriod(p);
    if (p === 'all') {
      return { period: p, periods: [{ key: 'all', label: this.periodLabel(current), count: 0, points: 0, isCurrent: true }] };
    }

    const rows = await this.logModel
      .find({}, { createdAt: 1, points: 1 })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const buckets = new Map<string, { count: number; points: number; ref: Date }>();
    for (const r of rows) {
      const d = (r as { createdAt?: Date }).createdAt;
      if (!d) continue;
      const when = new Date(d);
      if (isNaN(when.getTime())) continue;
      const key = this.resolvePeriod(p, when).key;
      const b = buckets.get(key) || { count: 0, points: 0, ref: when };
      b.count += 1;
      b.points += (r as { points?: number }).points || 0;
      buckets.set(key, b);
    }
    if (!buckets.has(current.key)) buckets.set(current.key, { count: 0, points: 0, ref: new Date() });

    const periods = Array.from(buckets.entries())
      .map(([key, b]) => ({
        key,
        label: this.periodLabel(this.resolvePeriod(p, b.ref)),
        count: b.count,
        points: b.points,
        isCurrent: key === current.key,
      }))
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

    return { period: p, periods };
  }

  async getLogs(filter: {
    employeeId?: string;
    orderId?: string;
    period?: string;
    periodKey?: string;
  }): Promise<{
    period: PerformancePeriod;
    periodKey: string;
    periodLabel: string;
    total: number;
    truncated: boolean;
    logs: EmployeePerformanceLogDocument[];
  }> {
    const range = this.resolvePeriod(filter.period, new Date(), filter.periodKey);
    const query: Record<string, unknown> = { ...this.periodMatch(range) };
    if (filter.employeeId) query.employeeId = filter.employeeId;
    if (filter.orderId) query.orderId = filter.orderId;

    const LIMIT = 500;
    const [logs, total] = await Promise.all([
      this.logModel.find(query).sort({ createdAt: -1 }).limit(LIMIT).exec(),
      this.logModel.countDocuments(query),
    ]);

    return {
      period: range.period,
      periodKey: range.key,
      periodLabel: this.periodLabel(range),
      total,
      truncated: total > LIMIT,
      logs,
    };
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
