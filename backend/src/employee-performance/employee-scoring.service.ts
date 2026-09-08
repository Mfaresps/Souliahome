import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import { FollowUp, FollowUpDocument } from '../followups/schemas/followup.schema';
import { DONE_STATUSES } from '../followups/followups.service';

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

/**
 * One staff member's own dashboard payload. Every list in it is already scoped to
 * the caller — see getMyWorkspace for why that scoping lives in the query and not
 * in the renderer.
 */
export interface MyWorkspaceResult {
  period: PerformancePeriod;
  periodKey: string;
  periodLabel: string;
  prevPeriodKey: string | null;
  isCurrentPeriod: boolean;
  points: {
    earned: number;
    /**
     * NET of every manual adjustment in the period — a +100 bonus and a -40 penalty
     * sum to 60 here.
     *
     * ⚠ This field alone cannot answer "was I given a bonus or docked?". It is kept
     * because `total = earned + bonus` is built on it and several callers read it,
     * but the employee-facing card reads `bonusTotal`/`penaltyTotal` and
     * `adjustments` instead. Do not "simplify" those away into this one number.
     */
    bonus: number;
    /** Sum of the POSITIVE manual adjustments only. Always >= 0. */
    bonusTotal: number;
    /** Sum of the NEGATIVE manual adjustments, as a POSITIVE magnitude. Always >= 0. */
    penaltyTotal: number;
    total: number;
    prevPeriodPoints: number;
    allTimePoints: number;
  };
  /**
   * The individual manual adjustments in the period, newest first — each with the
   * reason the admin typed.
   *
   * ⚠ The reason is the entire point of this array. A manual adjustment the employee
   * cannot see a reason for is indistinguishable from a scoring bug, and reads as one:
   * points move with no explanation. `note` is written by `addManualBonus` from the
   * admin's required `reason` field, so it is never empty on a row created through
   * the normal path.
   *
   * Bounded by MY_ADJUSTMENTS_MAX — this feeds a dashboard card, not an audit report.
   * `adjustmentsTruncated` says so rather than presenting a partial list as complete.
   */
  adjustments: Array<{
    id: string;
    points: number;
    reason: string;
    by: string;
    createdAt: string;
  }>;
  adjustmentsTruncated: boolean;
  /** Lifetime count of orders routed to this employee. Labelled as all-time on the card. */
  assignedOrdersTotal: number;
  /** Same count bounded by the selected period — the one comparable to `points`. */
  assignedOrdersInPeriod: number;
  deliveredInPeriod: number;
  openFollowUpsCount: number;
  orders: Array<{
    id: string;
    shopifyId: string;
    ref: string;
    client: string;
    total: number;
    status: string;
    depositStatus: string;
    depositAmount: number;
    assignedAt: string;
  }>;
  followUps: Array<{
    id: string;
    ticketNo: string;
    orderRef: string;
    transactionId: string;
    clientName: string;
    clientPhone: string;
    reason: string;
    status: string;
    autoSource: string;
    updatedAt: string;
  }>;
  /**
   * Shipment rows in the shape the shared dashboard renderer expects — `_id` and
   * `type` deliberately keep their Transaction names. See the ⚠ at the mapping.
   */
  shipments: Array<{
    _id: string;
    type: string;
    cancelled: boolean;
    ref: string;
    client: string;
    total: number;
    shopifyOrderId: string;
    bostaStatus: string;
    bostaStatusLabel: string;
    bostaTrackingNumber: string;
    bostaLastSync: string;
    pickupStatus: string;
    pickupDate: string;
    deliverySource: string;
    deliveredAt: string;
    shippedAt: string;
    shipIssueState: string;
    failedDelivery: boolean;
    shipmentAttempts: unknown[];
    date: string;
  }>;
  ordersTruncated: boolean;
  followUpsTruncated: boolean;
}

/**
 * Row caps for the staff workspace. Bounded because this is a dashboard payload,
 * not an export; when a cap bites the response says so (`ordersTruncated` /
 * `followUpsTruncated`) so the UI can state it instead of showing a partial list
 * as if it were the whole.
 */
const MY_ORDERS_MAX = 200;
const MY_FOLLOWUPS_MAX = 100;
/* عدد التعديلات اليدوية اللي بتترجع للموظف في الفترة. الكارت بيعرض آخر تلاتة
   والباقي بيتفتح في قايمة — فالسقف ده وفير جداً لشهر عادي، وموجود عشان استعلام
   غير محدود ما يبقاش سطح هجوم لو حد كتب ٥٠٠ تعديل. `adjustmentsTruncated`
   بتقول إن في أكتر، بدل ما قايمة ناقصة تتعرض كإنها كاملة. */
const MY_ADJUSTMENTS_MAX = 50;

@Injectable()
export class EmployeeScoringService implements OnModuleInit {
  private readonly logger = new Logger(EmployeeScoringService.name);

  constructor(
    @InjectModel(EmployeePerformanceLog.name)
    private readonly logModel: Model<EmployeePerformanceLogDocument>,
    @InjectModel(ShopifyOrder.name) private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
    @InjectModel(Transaction.name) private readonly txModel: Model<TransactionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(EmployeeShift.name) private readonly shiftModel: Model<EmployeeShiftDocument>,
    @InjectModel(FollowUp.name) private readonly followUpModel: Model<FollowUpDocument>,
    private readonly usersService: UsersService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Self-heals the point log on every boot, in two steps that must run in this order.
   *
   * ⚠ THIS IS WHAT MAKES A RESTORE ONTO ANOTHER MACHINE SAFE. employeeId stores a
   * User._id; restoreUsersMerge matches accounts by username and keeps the id already
   * on the target machine, so after a local↔online restore the same person holds a
   * different _id on each side and every restored point row points at nothing. The
   * leaderboard then renders empty with all rows intact — the failure is invisible.
   * Measured on the two real backups in this repo: 66% of points orphaned that way.
   *
   * 1. backfill — stamp employeeUsername onto rows that predate the field, using the
   *    accounts on THIS machine while their ids still resolve. Must run first: after a
   *    restore the ids are already stale and there would be nothing left to read from.
   * 2. relink — re-point rows whose id no longer resolves at the account owning the
   *    same username.
   *
   * Both are idempotent, so a boot with nothing to fix does no writes. Neither throws:
   * a repair pass must never stop the API from starting.
   */
  async onModuleInit(): Promise<void> {
    try {
      // Must run before anything period-scoped: a string createdAt makes every window
      // query match nothing, which is what makes a KPI read 0 while the rows exist.
      await this.fixLogTimestamps(false);
      await this.backfillLogUsernames(false);
      await this.relinkOrphanedLogs(false);
      // Shifts carry the same User._id and break the same way. They matter just as much:
      // the leaderboard roster is built from employeeshifts, so a shift pointing at a
      // dead id hides an employee whose points re-linked perfectly.
      await this.backfillShiftUsernames(false);
      await this.relinkOrphanedShifts(false);
      // The same broken link outside the performance tables: the orders a person owns
      // and the follow-ups assigned to them.
      await this.healOrderAndFollowUpLinks(false);
    } catch (err) {
      this.logger.error(`Performance self-heal failed on boot: ${(err as Error).message}`);
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
        employeeUsername: await this.usernameForId(order.assignedTo),
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
      // assignedTo is a User._id string (set by resolveAssignee). Resolve either shape to
      // BOTH an _id and a username — the id is what every query filters on, the username
      // is what survives a restore onto a different database. See employeeUsername.
      let employeeId: string | null = null;
      let employeeUsername = '';
      const byUsername = await this.usersService.findByUsername(creditedUsername);
      if (byUsername) {
        employeeId = String(byUsername._id);
        employeeUsername = byUsername.username || '';
      } else {
        const byId = await this.usersService.findById(creditedUsername);
        if (byId) {
          employeeId = String(byId._id);
          employeeUsername = byId.username || '';
        }
      }
      if (!employeeId) {
        this.logger.warn(`Cannot score delivery for order ${order._id}: no resolvable employee`);
        return;
      }

      const settings = await this.settingsService.getSettings();
      const points = settings.performanceConfig?.deliveryPoints ?? 2;

      await this.logModel.create({
        employeeId,
        employeeUsername,
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

    const earnedById = new Map<string, number>(pointsAgg.map((r): [string, number] => [r._id, r.earnedPoints]));
    const bonusById = new Map<string, number>(pointsAgg.map((r): [string, number] => [r._id, r.bonusPoints]));
    const allTimeById = new Map<string, number>(allTimeAgg.map((r): [string, number] => [r._id, r.total]));
    const prevById = new Map<string, number>(prevAgg.map((r): [string, number] => [r._id, r.total]));
    const assignedById = new Map<string, number>(assignedCounts.map((r): [string, number] => [r._id, r.count]));
    const deliveredById = new Map<string, number>(deliveredCounts.map((r): [string, number] => [r._id, r.count]));

    const confirmedByUsername = new Map<string, { total: number; withDeposit: number }>();
    for (const o of confirmedOrders) {
      const key = o.reviewedBy;
      const bucket = confirmedByUsername.get(key) || { total: 0, withDeposit: 0 };
      bucket.total += 1;
      if (o.depositStatus && o.depositStatus !== 'none') bucket.withDeposit += 1;
      confirmedByUsername.set(key, bucket);
    }

    const rows: PerformanceDashboardRow[] = staff.map((u) => {
      const id = String(u._id);
      const confirmed = confirmedByUsername.get(u.username || '') || { total: 0, withDeposit: 0 };
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

  /**
   * ─────────────────────────────────────────────────────────────────────────────
   * The staff member's own workspace — everything the employee dashboard shows.
   *
   * ⚠ EVERY array here is scoped to `userId` in its own query. The employee
   * dashboard must never receive a colleague's order, ticket or shipment and be
   * trusted not to draw it: the response is the privacy boundary, not the render.
   * That is why this is one endpoint rather than the frontend filtering the
   * already-loaded global `transactions` array, which holds every employee's work.
   *
   * ⚠ Assignment is joined through ShopifyOrder, never through
   * `Transaction.assignedToName`. That field is a denormalized NAME: two employees
   * can share one, and a rename silently re-points history at the wrong person.
   * `ShopifyOrder.assignedTo` holds the User._id, and `Transaction.shopifyOrderId
   * === ShopifyOrder.shopifyId` is the only reliable join back. Do not "simplify"
   * this into a name match.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  async getMyWorkspace(
    userId: string,
    period?: string,
    periodKey?: string,
  ): Promise<MyWorkspaceResult> {
    const range = this.resolvePeriod(period, new Date(), periodKey);
    const prev = this.previousPeriod(range);
    const inPeriod = this.periodMatch(range);

    // `assignedOrdersTotal` is lifetime and `assignedOrdersInPeriod` is bounded by
    // the same window as the points beside it. Both are returned because showing
    // only one is what makes an assignment counter misread — the same rule
    // getDashboardStats states about an unbounded counter sitting next to a
    // period total.
    const [
      pointsAgg,
      prevAgg,
      allTimeAgg,
      assignedTotal,
      assignedInPeriod,
      deliveredInPeriod,
      myOrders,
      myFollowUps,
      myAdjustments,
      myAdjustmentsCount,
    ] = await Promise.all([
      this.logModel.aggregate([
        { $match: { employeeId: userId, ...inPeriod } },
        {
          $group: {
            _id: null,
            earned: { $sum: { $cond: [{ $eq: ['$actionType', 'manual_bonus'] }, 0, '$points'] } },
            bonus: { $sum: { $cond: [{ $eq: ['$actionType', 'manual_bonus'] }, '$points', 0] } },
            /* ⚠ المكافآت والخصومات بتتجمّع كل واحدة لوحدها، مش بالصافي.
               +١٠٠ مكافأة و−٤٠ خصم في نفس الشهر بيدّوا `bonus: 60` — رقم
               مالوش معنى: لا هو مكافأة ولا خصم، والموظف بيقرا إنه اداله ٦٠
               وهو في الحقيقة اتخصم منه ٤٠ كمان. الاتنين لازم يتعرضوا. */
            bonusTotal: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$actionType', 'manual_bonus'] }, { $gt: ['$points', 0] }] },
                  '$points',
                  0,
                ],
              },
            },
            /* بالسالب هنا، وبيتحوّل لمقدار موجب تحت — الجمع لازم يفضل على
               القيم الأصلية عشان `$sum` ما يحتاجش `$abs` لكل صف. */
            penaltyTotal: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$actionType', 'manual_bonus'] }, { $lt: ['$points', 0] }] },
                  '$points',
                  0,
                ],
              },
            },
          },
        },
      ]),
      prev
        ? this.logModel.aggregate([
            { $match: { employeeId: userId, ...this.periodMatch(prev) } },
            { $group: { _id: null, total: { $sum: '$points' } } },
          ])
        : Promise.resolve([] as Array<{ total: number }>),
      this.logModel.aggregate([
        { $match: { employeeId: userId } },
        { $group: { _id: null, total: { $sum: '$points' } } },
      ]),
      this.shopifyOrderModel.countDocuments({ assignedTo: userId, cancelled: { $ne: true } }),
      this.shopifyOrderModel.countDocuments({
        assignedTo: userId,
        cancelled: { $ne: true },
        ...this.periodMatchIsoString(range, 'assignedAt'),
      }),
      this.logModel.countDocuments({ employeeId: userId, actionType: 'delivery_completed', ...inPeriod }),
      this.shopifyOrderModel
        .find({ assignedTo: userId, cancelled: { $ne: true } })
        .select('shopifyId ref client depositStatus depositAmount total status assignedAt')
        .sort({ assignedAt: -1 })
        .limit(MY_ORDERS_MAX)
        .lean()
        .exec(),
      // `responsibleId` is a real User._id (unlike Transaction.assignedToName), so
      // follow-ups scope exactly. Open only: a closed ticket is history, and listing
      // it under "needs your follow-up" reads as work still owed.
      this.followUpModel
        .find({
          responsibleId: userId,
          cancelled: { $ne: true },
          status: { $nin: DONE_STATUSES },
        })
        .select('ticketNo orderRef transactionId clientName clientPhone reason status autoSource updatedAt')
        .sort({ updatedAt: -1 })
        .limit(MY_FOLLOWUPS_MAX)
        .lean()
        .exec(),
      /* التعديلات اليدوية بأسبابها — دي البيانات اللي بتخلّي حركة النقاط
         مفهومة بدل ما تبقى رقم بيتغيّر لوحده.
         ⚠ نفس `inPeriod` بتاع النقاط بالظبط: تعديل بره الفترة المعروضة مش
         داخل في الإجمالي اللي فوقه، فعرضه جنبه بيخلّي الاتنين ما يجمعوش. */
      this.logModel
        .find({ employeeId: userId, actionType: 'manual_bonus', ...inPeriod })
        .select('points note meta createdAt')
        .sort({ createdAt: -1 })
        .limit(MY_ADJUSTMENTS_MAX)
        .lean()
        .exec(),
      this.logModel.countDocuments({ employeeId: userId, actionType: 'manual_bonus', ...inPeriod }),
    ]);

    // The shipment side of MY orders, joined on shopifyId → Transaction.shopifyOrderId.
    // An order assigned to me but never approved into a transaction has no shipment
    // yet and is simply absent here, rather than appearing as a phantom "not shipped".
    const shopifyIds = myOrders.map((o) => String(o.shopifyId)).filter(Boolean);
    const txs = shopifyIds.length
      ? await this.txModel
          .find({ shopifyOrderId: { $in: shopifyIds }, cancelled: { $ne: true } })
          .select(
            'ref client total type cancelled shopifyOrderId bostaStatus bostaStatusLabel ' +
              'bostaTrackingNumber bostaLastSync pickupStatus pickupDate deliverySource ' +
              'deliveredAt shippedAt date shipIssueState failedDelivery shipmentAttempts',
          )
          .lean()
          .exec()
      : [];

    const earned = pointsAgg[0]?.earned || 0;
    const bonus = pointsAgg[0]?.bonus || 0;
    const bonusTotal = pointsAgg[0]?.bonusTotal || 0;
    /* بيترجع من الاستعلام سالب (مجموع القيم السالبة) — بيتقلب لمقدار موجب هنا
       عشان الواجهة تعرضه كـ«−٤٠» بعلامتها الخاصة بدل «−−٤٠». */
    const penaltyTotal = Math.abs(pointsAgg[0]?.penaltyTotal || 0);

    return {
      period: range.period,
      periodKey: range.key,
      periodLabel: this.periodLabel(range),
      prevPeriodKey: prev ? prev.key : null,
      isCurrentPeriod: this.isCurrentPeriod(range),
      points: {
        earned,
        bonus,
        bonusTotal,
        penaltyTotal,
        total: earned + bonus,
        prevPeriodPoints: prevAgg[0]?.total || 0,
        allTimePoints: allTimeAgg[0]?.total || 0,
      },
      adjustments: myAdjustments.map((a) => ({
        id: String(a._id),
        points: a.points || 0,
        /* ⚠ `note` هو نص السبب اللي المدير كتبه (`addManualBonus` بتكتب
           `note: reason`، و`reason` مطلوب في الـDTO). الافتراضي فاضي هنا مش
           نص بديل: الواجهة هي اللي بتقرر تكتب إيه لو الصف قديم ومالوش سبب. */
        reason: a.note || '',
        by: String((a.meta as Record<string, unknown> | null)?.adjustedBy || ''),
        createdAt: (a as { createdAt?: Date }).createdAt
          ? new Date((a as { createdAt?: Date }).createdAt as Date).toISOString()
          : '',
      })),
      adjustmentsTruncated: myAdjustmentsCount > MY_ADJUSTMENTS_MAX,
      assignedOrdersTotal: assignedTotal,
      assignedOrdersInPeriod: assignedInPeriod,
      deliveredInPeriod,
      openFollowUpsCount: myFollowUps.length,
      orders: myOrders.map((o) => ({
        id: String(o._id),
        shopifyId: String(o.shopifyId || ''),
        ref: o.ref || '',
        client: o.client || '',
        total: o.total || 0,
        status: o.status || '',
        depositStatus: o.depositStatus || 'none',
        depositAmount: o.depositAmount || 0,
        assignedAt: o.assignedAt || '',
      })),
      followUps: myFollowUps.map((f) => ({
        id: String(f._id),
        ticketNo: f.ticketNo || '',
        orderRef: f.orderRef || '',
        transactionId: f.transactionId || '',
        clientName: f.clientName || '',
        clientPhone: f.clientPhone || '',
        reason: f.reason || '',
        status: f.status || '',
        autoSource: f.autoSource || '',
        updatedAt: (f as { updatedAt?: Date }).updatedAt
          ? new Date((f as { updatedAt?: Date }).updatedAt as Date).toISOString()
          : '',
      })),
      // ⚠ `_id` and `type` are kept under their real names: the dashboard reuses the
      // SAME shipping renderer for admin and staff, and it reads a Transaction shape
      // (row click → openOrderView(tx._id), `tx.type !== 'مبيعات'` guard). Renaming
      // them to a prettier `id`/`kind` here would break the row click and silently
      // turn every staff row into a non-sales row.
      shipments: txs.map((t) => ({
        _id: String(t._id),
        type: t.type || '',
        cancelled: !!t.cancelled,
        ref: t.ref || '',
        client: t.client || '',
        total: t.total || 0,
        shopifyOrderId: t.shopifyOrderId || '',
        bostaStatus: t.bostaStatus || '',
        bostaStatusLabel: t.bostaStatusLabel || '',
        bostaTrackingNumber: t.bostaTrackingNumber || '',
        bostaLastSync: t.bostaLastSync || '',
        pickupStatus: t.pickupStatus || '',
        pickupDate: (t as { pickupDate?: string }).pickupDate || '',
        deliverySource: t.deliverySource || '',
        deliveredAt: t.deliveredAt || '',
        shippedAt: t.shippedAt || '',
        shipIssueState: t.shipIssueState || '',
        failedDelivery: !!(t as { failedDelivery?: unknown }).failedDelivery,
        shipmentAttempts: Array.isArray((t as { shipmentAttempts?: unknown[] }).shipmentAttempts)
          ? (t as { shipmentAttempts: unknown[] }).shipmentAttempts
          : [],
        date: t.date || '',
      })),
      // Reported rather than silently applied, so a capped list is never mistaken
      // for a complete one — same rule as getLogs' `truncated`.
      ordersTruncated: myOrders.length >= MY_ORDERS_MAX,
      followUpsTruncated: myFollowUps.length >= MY_FOLLOWUPS_MAX,
    };
  }

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
      employeeUsername: await this.usernameForId(employeeId),
      orderId: '',
      actionType: 'manual_bonus',
      points,
      note: reason,
      meta: { adjustedBy },
    });
  }

  /**
   * Resolves a User._id to its username for the employeeUsername stamp.
   *
   * Returns '' rather than throwing when the account cannot be found: the point row
   * itself must still be written. A row with an id but no username is exactly the
   * pre-existing state of every historical row, and relinkOrphanedLogs() handles it.
   */
  private async usernameForId(employeeId: string): Promise<string> {
    if (!employeeId) return '';
    try {
      const u = await this.usersService.findById(employeeId);
      return u?.username || '';
    } catch {
      return '';
    }
  }

  /**
   * Repairs performance rows whose employeeId no longer matches any account, by
   * re-pointing them at the account that owns the same employeeUsername.
   *
   * ⚠ WHY THIS EXISTS. employeeId stores a User._id as a string. A restore onto a
   * DIFFERENT database (local install ↔ online install) merges accounts by USERNAME
   * and keeps the id already on that machine — so the same person legitimately holds
   * a different _id on each side, and every restored point row points at an id that
   * exists nowhere. Measured on the two real backups in this repo: 858 of 1307 points
   * (66%) were orphaned that way, and the leaderboard renders empty while every row
   * is still present and correct. Rebuilding the numbers by hand is impossible.
   *
   * Matching is on `username` for the same reason restoreUsersMerge uses it: it is
   * what login and findByUsername resolve, and it carries the unique index, so it is
   * the one identifier stable across databases.
   *
   * ⚠ Rows whose employeeUsername is empty are REPORTED, never guessed at. Those are
   * pre-existing rows written before this field, or rows belonging to a deleted
   * account; inventing an owner for a point row would corrupt the very leaderboard
   * this repairs. `unresolved` is what the UI shows so the gap stays visible rather
   * than silently absorbed.
   *
   * Idempotent, and safe to run on every boot: a row already pointing at a live
   * account is not touched.
   */
  async relinkOrphanedLogs(dryRun = true): Promise<{
    scanned: number;
    healthy: number;
    relinked: number;
    unresolved: number;
    unresolvedPoints: number;
    details: Array<{ username: string; fromId: string; toId: string; rows: number; points: number }>;
    dryRun: boolean;
  }> {
    const empty = {
      scanned: 0, healthy: 0, relinked: 0, unresolved: 0, unresolvedPoints: 0,
      details: [] as Array<{ username: string; fromId: string; toId: string; rows: number; points: number }>,
      dryRun,
    };
    try {
      const users = await this.userModel.find().select('_id username').lean().exec();
      const liveIds = new Set(users.map((u) => String(u._id)));
      const idByUsername = new Map<string, string>();
      for (const u of users) if (u.username) idByUsername.set(String(u.username), String(u._id));

      const logs = await this.logModel.find().select('employeeId employeeUsername points').lean().exec();
      empty.scanned = logs.length;

      // Group the broken rows by (stale id → username) so one updateMany fixes each person.
      const groups = new Map<string, { username: string; fromId: string; rows: number; points: number }>();
      for (const l of logs) {
        const id = String(l.employeeId || '');
        if (id && liveIds.has(id)) { empty.healthy++; continue; }

        const uname = String((l as { employeeUsername?: string }).employeeUsername || '');
        const target = uname ? idByUsername.get(uname) : undefined;
        if (!target) {
          // No username to match on, or the account itself is gone. Never guessed at.
          empty.unresolved++;
          empty.unresolvedPoints += Number(l.points) || 0;
          continue;
        }
        const key = `${id}→${target}`;
        const g = groups.get(key) || { username: uname, fromId: id, rows: 0, points: 0 };
        g.rows++;
        g.points += Number(l.points) || 0;
        groups.set(key, g);
      }

      for (const [key, g] of groups) {
        const toId = key.split('→')[1];
        empty.relinked += g.rows;
        empty.details.push({ username: g.username, fromId: g.fromId, toId, rows: g.rows, points: g.points });
        if (!dryRun) {
          await this.logModel
            .updateMany({ employeeId: g.fromId, employeeUsername: g.username }, { $set: { employeeId: toId } })
            .exec();
        }
      }

      if (empty.relinked || empty.unresolved) {
        this.logger.log(
          `relinkOrphanedLogs${dryRun ? ' (dry run)' : ''}: ${empty.relinked} rows re-linked, ` +
            `${empty.unresolved} unresolved (${empty.unresolvedPoints} pts) of ${empty.scanned} scanned`,
        );
      }
      return empty;
    } catch (err) {
      // Diagnostics must never take the module down.
      this.logger.error(`relinkOrphanedLogs failed: ${(err as Error).message}`);
      return empty;
    }
  }

  /**
   * Backfills employeeUsername on rows written before the field existed, so a backup
   * taken from THIS machine carries the restore-safe identifier. Rows whose account no
   * longer exists keep '' — there is nothing to resolve, and they are reported by
   * relinkOrphanedLogs() rather than filled with a guess.
   */
  async backfillLogUsernames(dryRun = true): Promise<{ scanned: number; filled: number; skipped: number; dryRun: boolean }> {
    const res = { scanned: 0, filled: 0, skipped: 0, dryRun };
    try {
      const users = await this.userModel.find().select('_id username').lean().exec();
      const usernameById = new Map<string, string>();
      for (const u of users) usernameById.set(String(u._id), String(u.username || ''));

      const rows = await this.logModel
        .find({ $or: [{ employeeUsername: '' }, { employeeUsername: { $exists: false } }] })
        .select('_id employeeId')
        .lean()
        .exec();
      res.scanned = rows.length;

      // One updateMany per employee rather than per row.
      const byId = new Map<string, number>();
      for (const r of rows) {
        const id = String(r.employeeId || '');
        byId.set(id, (byId.get(id) || 0) + 1);
      }
      for (const [id, count] of byId) {
        const uname = usernameById.get(id);
        if (!uname) { res.skipped += count; continue; }
        res.filled += count;
        if (!dryRun) {
          await this.logModel
            .updateMany(
              { employeeId: id, $or: [{ employeeUsername: '' }, { employeeUsername: { $exists: false } }] },
              { $set: { employeeUsername: uname } },
            )
            .exec();
        }
      }
      this.logger.log(
        `backfillLogUsernames${dryRun ? ' (dry run)' : ''}: ${res.filled} filled, ${res.skipped} skipped (no account), of ${res.scanned}`,
      );
      return res;
    } catch (err) {
      this.logger.error(`backfillLogUsernames failed: ${(err as Error).message}`);
      return res;
    }
  }

  /**
   * Backfills userUsername on shift rows written before the field existed, using the
   * accounts on THIS machine while their ids still resolve. Same contract and same
   * ordering requirement as backfillLogUsernames.
   */
  async backfillShiftUsernames(dryRun = true): Promise<{ scanned: number; filled: number; skipped: number; dryRun: boolean }> {
    const res = { scanned: 0, filled: 0, skipped: 0, dryRun };
    try {
      const users = await this.userModel.find().select('_id username').lean().exec();
      const usernameById = new Map<string, string>();
      for (const u of users) usernameById.set(String(u._id), String(u.username || ''));

      const rows = await this.shiftModel
        .find({ $or: [{ userUsername: '' }, { userUsername: { $exists: false } }] })
        .select('_id userId')
        .lean()
        .exec();
      res.scanned = rows.length;

      for (const r of rows) {
        const id = String((r as { userId?: string }).userId || '');
        const uname = usernameById.get(id);
        if (!uname) { res.skipped++; continue; }
        res.filled++;
        if (!dryRun) {
          await this.shiftModel.updateOne({ _id: r._id }, { $set: { userUsername: uname } }).exec();
        }
      }
      if (res.scanned) {
        this.logger.log(
          `backfillShiftUsernames${dryRun ? ' (dry run)' : ''}: ${res.filled} filled, ${res.skipped} skipped, of ${res.scanned}`,
        );
      }
      return res;
    } catch (err) {
      this.logger.error(`backfillShiftUsernames failed: ${(err as Error).message}`);
      return res;
    }
  }

  /**
   * Re-points shift rows whose userId no longer resolves at the account owning the same
   * userUsername — the roster half of the same restore problem relinkOrphanedLogs fixes.
   *
   * ⚠ A broken shift is MORE damaging than a broken point row: the leaderboard roster is
   * built from this collection, so one stale userId hides that employee entirely, even
   * when every one of their points re-linked correctly. Rows with no username are
   * reported, never guessed at.
   */
  async relinkOrphanedShifts(dryRun = true): Promise<{
    scanned: number; healthy: number; relinked: number; unresolved: number; dryRun: boolean;
  }> {
    const res = { scanned: 0, healthy: 0, relinked: 0, unresolved: 0, dryRun };
    try {
      const users = await this.userModel.find().select('_id username').lean().exec();
      const liveIds = new Set(users.map((u) => String(u._id)));
      const idByUsername = new Map<string, string>();
      for (const u of users) if (u.username) idByUsername.set(String(u.username), String(u._id));

      const shifts = await this.shiftModel.find().select('_id userId userUsername').lean().exec();
      res.scanned = shifts.length;

      for (const sh of shifts) {
        const id = String((sh as { userId?: string }).userId || '');
        if (id && liveIds.has(id)) { res.healthy++; continue; }
        const uname = String((sh as { userUsername?: string }).userUsername || '');
        const target = uname ? idByUsername.get(uname) : undefined;
        if (!target) { res.unresolved++; continue; }
        res.relinked++;
        if (!dryRun) {
          await this.shiftModel.updateOne({ _id: sh._id }, { $set: { userId: target } }).exec();
        }
      }
      if (res.relinked || res.unresolved) {
        this.logger.log(
          `relinkOrphanedShifts${dryRun ? ' (dry run)' : ''}: ${res.relinked} re-linked, ${res.unresolved} unresolved, of ${res.scanned}`,
        );
      }
      return res;
    } catch (err) {
      this.logger.error(`relinkOrphanedShifts failed: ${(err as Error).message}`);
      return res;
    }
  }

  /**
   * One generic pass that backfills the username and re-links the stale id on ANY
   * collection that points at a user by `_id`.
   *
   * ⚠ Every such field breaks the same way on a cross-database restore, so they get the
   * same two-step treatment rather than four hand-written copies that can drift:
   *   backfill (stamp the username while the id still resolves)
   *   → relink (re-point the id via that username).
   *
   * `model` is passed in rather than injected so this works for shopifyorders and
   * followups without EmployeeScoringService owning those modules.
   */
  private async healUserLink(
    model: Model<any>,
    idField: string,
    usernameField: string,
    label: string,
    dryRun: boolean,
  ): Promise<{ label: string; filled: number; relinked: number; unresolved: number }> {
    const res = { label, filled: 0, relinked: 0, unresolved: 0 };
    try {
      const users = await this.userModel.find().select('_id username').lean().exec();
      const liveIds = new Set(users.map((u) => String(u._id)));
      const usernameById = new Map<string, string>();
      const idByUsername = new Map<string, string>();
      for (const u of users) {
        usernameById.set(String(u._id), String(u.username || ''));
        if (u.username) idByUsername.set(String(u.username), String(u._id));
      }

      const rows = await model
        .find({ [idField]: { $nin: ['', null] } })
        .select(`_id ${idField} ${usernameField}`)
        .lean()
        .exec();

      for (const r of rows as Array<Record<string, unknown>>) {
        const id = String(r[idField] || '');
        if (!id) continue;
        const stamped = String(r[usernameField] || '');

        // Step 1 — the id still resolves: make sure the username is stamped for later.
        if (liveIds.has(id)) {
          if (!stamped) {
            const uname = usernameById.get(id);
            if (uname) {
              res.filled++;
              if (!dryRun) await model.updateOne({ _id: r._id }, { $set: { [usernameField]: uname } }).exec();
            }
          }
          continue;
        }

        // Step 2 — the id is stale: re-point it via the stamped username.
        const target = stamped ? idByUsername.get(stamped) : undefined;
        if (!target) { res.unresolved++; continue; } // never guessed at
        res.relinked++;
        if (!dryRun) await model.updateOne({ _id: r._id }, { $set: { [idField]: target } }).exec();
      }

      if (res.filled || res.relinked || res.unresolved) {
        this.logger.log(
          `healUserLink[${label}]${dryRun ? ' (dry run)' : ''}: ${res.filled} stamped, ` +
            `${res.relinked} re-linked, ${res.unresolved} unresolved`,
        );
      }
      return res;
    } catch (err) {
      this.logger.error(`healUserLink[${label}] failed: ${(err as Error).message}`);
      return res;
    }
  }

  /**
   * Repairs the two remaining user links outside the performance tables: the orders an
   * employee owns (`shopifyorders.assignedTo`) and the follow-ups assigned to them
   * (`followups.responsibleId`). Without this, an upload leaves «أوردراتي» and the
   * follow-up inbox empty for everyone even when the points re-linked perfectly.
   */
  async healOrderAndFollowUpLinks(dryRun = true): Promise<Array<{ label: string; filled: number; relinked: number; unresolved: number }>> {
    return [
      await this.healUserLink(this.shopifyOrderModel as unknown as Model<any>, 'assignedTo', 'assignedToUsername', 'shopifyorders.assignedTo', dryRun),
      await this.healUserLink(this.followUpModel as unknown as Model<any>, 'responsibleId', 'responsibleUsername', 'followups.responsibleId', dryRun),
    ];
  }

  /**
   * Converts string `createdAt` values on the point log back into real Dates.
   *
   * ⚠ THIS IS WHY A KPI CAN READ ZERO WHILE THE POINTS EXIST. A restore reads the
   * backup with JSON.parse, which has no Date type, so createdAt lands as an ISO
   * STRING. Mongo compares BSON types, so `{createdAt: {$gte: <Date>}}` matches a
   * string row not at all — and EVERY period-scoped query here is built that way
   * (periodMatch). The rows are present and correct; the window simply cannot see
   * them, so «نقاطي» prints 0 for an employee holding 279 points and the leaderboard
   * looks like nobody scored this month.
   *
   * Measured on the live database when this was found: 633 of 637 rows were strings.
   *
   * restoreBackup now writes real Dates, so this is the repair for rows restored
   * before that fix. Idempotent — a row already stored as a Date is skipped.
   */
  async fixLogTimestamps(dryRun = true): Promise<{ scanned: number; converted: number; failed: number; dryRun: boolean }> {
    const res = { scanned: 0, converted: 0, failed: 0, dryRun };
    try {
      // $type:'string' finds exactly the broken rows; a Date-typed row is never matched.
      const rows = await this.logModel
        .find({ createdAt: { $type: 'string' } } as Record<string, unknown>)
        .select('_id createdAt updatedAt')
        .lean()
        .exec();
      res.scanned = rows.length;
      if (!rows.length) return res;

      // ⚠ Written through the RAW driver, not the Mongoose model. `timestamps: true`
      // makes Mongoose own createdAt/updatedAt: it overwrites updatedAt on every save
      // and silently discards a manual write to createdAt, so `logModel.updateOne` here
      // reports success and changes nothing — the rows stay strings and the KPI stays 0.
      // The raw collection is the only way to correct a field the ODM manages.
      const raw = this.logModel.collection;
      for (const r of rows as Array<Record<string, unknown>>) {
        const set: Record<string, Date> = {};
        for (const f of ['createdAt', 'updatedAt']) {
          const v = r[f];
          if (typeof v === 'string' && v) {
            const d = new Date(v);
            if (!isNaN(d.getTime())) set[f] = d;
          }
        }
        if (!Object.keys(set).length) { res.failed++; continue; }
        res.converted++;
        if (!dryRun) {
          await raw.updateOne({ _id: r._id as never }, { $set: set });
        }
      }
      this.logger.log(
        `fixLogTimestamps${dryRun ? ' (dry run)' : ''}: ${res.converted} converted, ${res.failed} unparseable, of ${res.scanned}`,
      );
      return res;
    } catch (err) {
      this.logger.error(`fixLogTimestamps failed: ${(err as Error).message}`);
      return res;
    }
  }

  /**
   * Read-only integrity report for the performance data — "did the points survive?".
   *
   * ⚠ It answers the question the leaderboard CANNOT. An empty leaderboard has three
   * completely different causes that look identical on screen: nobody scored, the point
   * rows lost their employee link, or the shift roster did not come across. Only the
   * first is normal. This separates them, the same way the LOAD_FAIL rule separates
   * "failed to load" from "there is nothing".
   *
   * Never throws — a diagnostic that dies tells you nothing about the thing you are
   * diagnosing, which is worse than an unhealthy report.
   */
  async getPerformanceDataHealth(): Promise<{
    ok: boolean;
    totalRows: number;
    totalPoints: number;
    linkedRows: number;
    linkedPoints: number;
    orphanRows: number;
    orphanPoints: number;
    repairableRows: number;
    repairablePoints: number;
    missingUsernameRows: number;
    rosterCovered: number;
    rosterMissing: Array<{ username: string; name: string; points: number }>;
    shiftRows: number;
    brokenShiftRows: number;
    issues: string[];
  }> {
    const out = {
      ok: true,
      totalRows: 0, totalPoints: 0,
      linkedRows: 0, linkedPoints: 0,
      orphanRows: 0, orphanPoints: 0,
      repairableRows: 0, repairablePoints: 0,
      missingUsernameRows: 0,
      rosterCovered: 0,
      rosterMissing: [] as Array<{ username: string; name: string; points: number }>,
      shiftRows: 0,
      brokenShiftRows: 0,
      issues: [] as string[],
    };
    try {
      const [users, logs, shifts] = await Promise.all([
        this.userModel.find().select('_id username name role').lean().exec(),
        this.logModel.find().select('employeeId employeeUsername points').lean().exec(),
        this.shiftModel.find().select('userId userUsername').lean().exec(),
      ]);

      const liveIds = new Set(users.map((u) => String(u._id)));
      const idByUsername = new Map<string, string>();
      for (const u of users) if (u.username) idByUsername.set(String(u.username), String(u._id));
      const shiftUserIds = new Set(shifts.map((s) => String(s.userId)));
      out.shiftRows = shifts.length;
      // A shift whose userId resolves to nobody hides that employee from the roster
      // entirely, however healthy their point rows are.
      out.brokenShiftRows = shifts.filter((sh) => !liveIds.has(String(sh.userId))).length;

      // Points per still-resolvable employee id, used for the roster check below.
      const pointsById = new Map<string, number>();

      for (const l of logs) {
        const pts = Number(l.points) || 0;
        const id = String(l.employeeId || '');
        const uname = String((l as { employeeUsername?: string }).employeeUsername || '');
        out.totalRows++;
        out.totalPoints += pts;

        if (id && liveIds.has(id)) {
          out.linkedRows++;
          out.linkedPoints += pts;
          pointsById.set(id, (pointsById.get(id) || 0) + pts);
          continue;
        }

        out.orphanRows++;
        out.orphanPoints += pts;
        // An orphan carrying a username that maps to a live account can be repaired
        // automatically; one without a username cannot, and is reported instead.
        if (uname && idByUsername.has(uname)) {
          out.repairableRows++;
          out.repairablePoints += pts;
        } else if (!uname) {
          out.missingUsernameRows++;
        }
      }

      // Roster check — points that are perfectly linked but still invisible on the
      // leaderboard because the employee has no shift row (or is not role 'staff').
      for (const u of users) {
        const id = String(u._id);
        const pts = pointsById.get(id) || 0;
        if (pts <= 0) continue;
        if (shiftUserIds.has(id) && u.role === 'staff') out.rosterCovered++;
        else out.rosterMissing.push({ username: String(u.username || ''), name: String(u.name || ''), points: pts });
      }
      out.rosterMissing.sort((a, b) => b.points - a.points);

      if (out.orphanRows > 0) {
        out.ok = false;
        out.issues.push(
          `${out.orphanRows} صف نقاط (${out.orphanPoints} نقطة) غير مرتبط بأي حساب` +
            (out.repairableRows > 0 ? ` — ${out.repairableRows} منها قابل للإصلاح تلقائياً` : ''),
        );
      }
      if (out.brokenShiftRows > 0) {
        out.ok = false;
        out.issues.push(
          `${out.brokenShiftRows} وردية مرتبطة بحساب غير موجود — أصحابها لن يظهروا في جدول الأداء`,
        );
      }
      if (out.shiftRows === 0) {
        out.ok = false;
        out.issues.push('لا توجد أي ورديات مسجّلة — جدول الأداء سيظهر فارغاً مهما بلغت النقاط');
      }
      if (out.rosterMissing.length > 0) {
        out.issues.push(
          `${out.rosterMissing.length} موظف لديه نقاط لكنه لا يظهر في الجدول (لا توجد وردية أو الدور ليس staff)`,
        );
      }
      return out;
    } catch (err) {
      this.logger.error(`getPerformanceDataHealth failed: ${(err as Error).message}`);
      out.ok = false;
      out.issues.push('تعذّر فحص سلامة بيانات الأداء');
      return out;
    }
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

}
