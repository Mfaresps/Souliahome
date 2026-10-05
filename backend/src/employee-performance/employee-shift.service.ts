import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmployeeShift, EmployeeShiftDocument } from './schemas/employee-shift.schema';
import { UsersService } from '../users/users.service';
import { EmployeeLeaveService } from './employee-leave.service';
import { CreateEmployeeShiftDto, UpdateEmployeeShiftDto } from './dto/employee-shift.dto';

export interface AssigneeResolution {
  userId: string;
  /** The shift's stored userUsername — the restore-safe identifier for this person. */
  username: string;
  name: string;
  reason: 'shift' | 'on-call-fallback' | 'unassigned';
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * The timezone shift windows are written in. Overridable so a deployment in
 * another country does not need a code change; defaults to Cairo, which is what
 * every existing shift row was entered against.
 */
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Africa/Cairo';

/** Intl's short weekday name → the 0=Sunday index this service uses everywhere. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

@Injectable()
export class EmployeeShiftService {
  private readonly logger = new Logger(EmployeeShiftService.name);

  constructor(
    @InjectModel(EmployeeShift.name) private readonly shiftModel: Model<EmployeeShiftDocument>,
    private readonly usersService: UsersService,
    private readonly leaveService: EmployeeLeaveService,
  ) {}

  async listShifts(): Promise<EmployeeShiftDocument[]> {
    return this.shiftModel.find().sort({ userId: 1, shiftStart: 1 }).exec();
  }

  /**
   * The employee a shift belongs to, or '' when the row is gone.
   *
   * ⚠ Exists so the controller can resolve the owner BEFORE deleting — after
   * `deleteShift` the row is gone and there is nothing left to attribute the change
   * to, so the affected employee could never be told their own schedule moved.
   * Never throws: this only decorates a notification, and a lookup failure must not
   * fail the write it accompanies.
   */
  async findShiftOwner(id: string): Promise<string> {
    try {
      const doc = await this.shiftModel.findById(id).select('userId').lean().exec();
      return doc ? String((doc as { userId?: string }).userId || '') : '';
    } catch {
      return '';
    }
  }

  async createShift(dto: CreateEmployeeShiftDto, by: string): Promise<EmployeeShiftDocument[]> {
    const user = await this.usersService.findById(dto.userId);
    if (!user) throw new BadRequestException('الموظف غير موجود');
    if (user.role !== 'staff') throw new BadRequestException('لا يمكن جدولة إلا الموظفين (staff)');

    const days = this.normalizeDays(dto.daysOfWeek);
    await this.assertNoOverlap(dto.userId, days, dto.shiftStart, dto.shiftEnd, null);

    await this.shiftModel.create({
      userId: dto.userId,
      // Stamped so the shift survives a restore onto a database where this account
      // holds a different _id — see userUsername on the schema.
      userUsername: user.username || '',
      name: user.name || user.username,
      shiftStart: dto.shiftStart,
      shiftEnd: dto.shiftEnd,
      daysOfWeek: days,
      isActive: dto.isActive !== undefined ? dto.isActive : true,
      isOnCall: false, // set-on-call is a dedicated atomic action, not settable at creation
      createdBy: by,
      updatedBy: by,
    });

    return this.listShifts();
  }

  async updateShift(id: string, dto: UpdateEmployeeShiftDto, by: string): Promise<EmployeeShiftDocument[]> {
    const existing = await this.shiftModel.findById(id).exec();
    if (!existing) throw new NotFoundException('جدول الوردية غير موجود');

    const days = dto.daysOfWeek !== undefined ? this.normalizeDays(dto.daysOfWeek) : existing.daysOfWeek;
    const start = dto.shiftStart ?? existing.shiftStart;
    const end = dto.shiftEnd ?? existing.shiftEnd;
    await this.assertNoOverlap(existing.userId, days, start, end, id);

    const update: Record<string, unknown> = { ...dto, updatedBy: by };
    if (dto.daysOfWeek !== undefined) update.daysOfWeek = days;
    delete update.isOnCall; // use setOnCall() to change this, keeps the single-true-per-day invariant enforced

    const shift = await this.shiftModel.findByIdAndUpdate(id, update, { new: true }).exec();
    if (!shift) throw new NotFoundException('جدول الوردية غير موجود');

    return this.listShifts();
  }

  async deleteShift(id: string): Promise<EmployeeShiftDocument[]> {
    const result = await this.shiftModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('جدول الوردية غير موجود');
    return this.listShifts();
  }

  /**
   * on-call is now scoped to the days the target shift itself covers — not a single
   * system-wide flag any more, since a shift is no longer a system-wide, all-week thing.
   * Only shifts sharing at least one day with the target are cleared, so setting
   * Ahmed on-call for Fri–Sat does not silently strip Sara's on-call flag on Sun–Thu.
   */
  async setOnCall(id: string): Promise<EmployeeShiftDocument[]> {
    const target = await this.shiftModel.findById(id).exec();
    if (!target) throw new NotFoundException('جدول الوردية غير موجود');

    const targetDays = new Set(target.daysOfWeek?.length ? target.daysOfWeek : ALL_DAYS);
    const others = await this.shiftModel.find({ _id: { $ne: id }, isOnCall: true }).exec();
    const toClear = others
      .filter((s) => (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).some((d) => targetDays.has(d)))
      .map((s) => s._id);
    if (toClear.length) {
      await this.shiftModel.updateMany({ _id: { $in: toClear } }, { isOnCall: false }).exec();
    }
    await this.shiftModel.findByIdAndUpdate(id, { isOnCall: true }).exec();

    return this.listShifts();
  }

  /**
   * Clears isOnCall on exactly this shift, leaving every other shift's on-call flag
   * untouched. setOnCall() only ever moves the flag onto a new target (and clears
   * conflicting siblings as a side effect) — it has no way to leave a day with NO
   * on-call employee, which is a legitimate state an admin must be able to reach
   * (e.g. after deciding nobody covers overnight orders any more).
   */
  async unsetOnCall(id: string): Promise<EmployeeShiftDocument[]> {
    const target = await this.shiftModel.findById(id).exec();
    if (!target) throw new NotFoundException('جدول الوردية غير موجود');
    await this.shiftModel.findByIdAndUpdate(id, { isOnCall: false }).exec();
    return this.listShifts();
  }

  /**
   * Resolves which employee an incoming Shopify order should be routed to, based on
   * the order's weekday + time-of-day against configured active shifts (minus anyone
   * on leave that day), falling back to that day's on-call employee.
   * Never throws — assignment is advisory and must never block webhook ingestion;
   * callers should still wrap calls in try/catch.
   */
  async resolveAssignee(orderCreatedAtIso: string): Promise<AssigneeResolution | null> {
    const orderDate = new Date(orderCreatedAtIso);
    if (isNaN(orderDate.getTime())) return null;

    // ⚠ Resolved in BUSINESS time, not UTC — shift windows are Cairo wall-clock.
    // See businessParts() for what reading getUTCHours() here used to cost.
    const { time: timeOfDay, weekday, date: onDay } = this.businessParts(orderDate);

    // ⚠ A shift row outlives the account it was scheduled for — disabling an
    // employee does not delete their shift. Without this set, a disabled
    // employee's own shift window still wins routing and they'd be handed a
    // live order nobody can reach them about.
    const [activeShifts, onLeave, activeUserIds] = await Promise.all([
      this.shiftModel.find({ isActive: true }).exec(),
      this.leaveService.listUserIdsOnLeave(onDay),
      this.usersService.findActiveUserIds(),
    ]);

    const matches = activeShifts.filter(
      (s) =>
        !onLeave.has(String(s.userId)) &&
        activeUserIds.has(String(s.userId)) &&
        this.coversWeekdayAtTime(s, weekday, timeOfDay),
    );

    if (matches.length === 1) {
      return { userId: matches[0].userId, username: matches[0].userUsername || '', name: matches[0].name, reason: 'shift' };
    }
    if (matches.length > 1) {
      matches.sort(this.byRunningLongest(timeOfDay));
      this.logger.warn(
        `Multiple overlapping shifts match order time ${timeOfDay} (weekday ${weekday}) — using earliest shiftStart (${matches[0].name})`,
      );
      return { userId: matches[0].userId, username: matches[0].userUsername || '', name: matches[0].name, reason: 'shift' };
    }

    // On-call fallback: the on-call shift whose days include the day the order's own
    // shift-window would have started (see dutyDayFor — an overnight shift starting
    // Saturday still "belongs" to Saturday's on-call, not Sunday's).
    const onCallCandidates = await this.shiftModel.find({ isOnCall: true, isActive: true }).exec();
    const onCall = onCallCandidates.find(
      (s) =>
        !onLeave.has(String(s.userId)) &&
        activeUserIds.has(String(s.userId)) &&
        (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).includes(weekday),
    );
    if (onCall) {
      return { userId: onCall.userId, username: onCall.userUsername || '', name: onCall.name, reason: 'on-call-fallback' };
    }

    return null;
  }

  /**
   * Every employee who could take an assignment right now, split into tiers.
   *
   * `resolveAssignee` answers "who owns this?" and returns exactly one person —
   * correct for routing a Shopify order, which has one owner. Assigning a live
   * delivery problem is a different question: it should go to somebody who is
   * actually at a screen, so the caller needs the whole candidate set to
   * intersect against who is online. Neither list is ordered by preference; the
   * caller decides.
   *
   * Never throws — assignment is advisory and must not block ingestion.
   */
  async listShiftCandidates(atIso: string): Promise<{
    onShift: Array<{ userId: string; username: string; name: string }>;
    scheduled: Array<{ userId: string; username: string; name: string }>;
    onCall: { userId: string; username: string; name: string } | null;
  }> {
    const empty = { onShift: [], scheduled: [], onCall: null };
    try {
      const at = new Date(atIso);
      if (isNaN(at.getTime())) return empty;

      const { time: timeOfDay, weekday, date: onDay } = this.businessParts(at);

      const [activeShifts, onLeave, activeUserIds] = await Promise.all([
        this.shiftModel.find({ isActive: true }).exec(),
        this.leaveService.listUserIdsOnLeave(onDay),
        this.usersService.findActiveUserIds(),
      ]);
      const available = activeShifts.filter(
        (s) => !onLeave.has(String(s.userId)) && activeUserIds.has(String(s.userId)),
      );
      const pick = (s: EmployeeShiftDocument) => ({ userId: s.userId, username: s.userUsername || '', name: s.name });

      const onCallDoc =
        available.find(
          (s) => s.isOnCall && (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).includes(weekday),
        ) || null;

      return {
        onShift: available.filter((s) => this.coversWeekdayAtTime(s, weekday, timeOfDay)).map(pick),
        // "scheduled" = today's roster regardless of the exact time window, i.e. every
        // employee whose shift touches today at all — the pool a delivery problem raised
        // later in the day may still reasonably fall to.
        scheduled: available.filter((s) => (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).includes(weekday)).map(pick),
        onCall: onCallDoc ? pick(onCallDoc) : null,
      };
    } catch (err) {
      this.logger.warn(`listShiftCandidates failed: ${(err as Error).message}`);
      return empty;
    }
  }


  /**
   * The caller's OWN roster — their shifts, their upcoming leave, and where they
   * stand in today's window right now.
   *
   * ⚠ Scoped by `userId` inside the query, never filtered after the fact by the
   * caller. `listShifts()` returns every employee's schedule, and a staff-facing
   * screen must not receive rows it is then trusted to hide: the response is the
   * privacy boundary, not the render. That is the whole reason this method exists
   * instead of the frontend calling `listShifts()` and picking its own rows out.
   *
   * Weekday/time are read with the same UTC-parts convention `resolveAssignee`
   * uses, so "am I on shift now?" here and "who owns this order?" there can never
   * disagree about which day it is.
   */
  async getMyRoster(
    userId: string,
    nowIso?: string,
  ): Promise<{
    todayWeekday: number;
    todayDate: string;
    onLeaveToday: boolean;
    onShiftNow: boolean;
    currentShift: {
      id: string;
      shiftStart: string;
      shiftEnd: string;
      lengthMinutes: number;
      elapsedMinutes: number;
      remainingMinutes: number;
    } | null;
    /** Every shift template belonging to THIS employee — the week grid is drawn from it. */
    shifts: Array<{
      id: string;
      shiftStart: string;
      shiftEnd: string;
      daysOfWeek: number[];
      isActive: boolean;
      isOnCall: boolean;
      lengthMinutes: number;
    }>;
    /** This employee's leave only: still covering today, or starting later. */
    leaves: Array<{ id: string; fromDate: string; toDate: string; reason: string }>;
  }> {
    const parsed = nowIso ? new Date(nowIso) : new Date();
    const ref = isNaN(parsed.getTime()) ? new Date() : parsed;
    const { date: todayDate, weekday, time: timeOfDay } = this.businessParts(ref);

    const [rows, onLeave, leaveRows] = await Promise.all([
      this.shiftModel.find({ userId }).sort({ shiftStart: 1 }).lean().exec(),
      this.leaveService.listUserIdsOnLeave(todayDate),
      this.leaveService.listUpcomingForUser(userId, todayDate),
    ]);

    const onLeaveToday = onLeave.has(String(userId));
    // A shift an employee is on leave from is not a shift they are "on" — the same
    // exclusion resolveAssignee applies before routing an order to them. Without it
    // the header would say "on shift" to someone the router is deliberately skipping.
    const active = onLeaveToday
      ? null
      : rows.find(
          (s) =>
            s.isActive !== false &&
            this.coversWeekdayAtTime(s as unknown as EmployeeShiftDocument, weekday, timeOfDay),
        ) || null;

    return {
      todayWeekday: weekday,
      todayDate,
      onLeaveToday,
      onShiftNow: !!active,
      currentShift: active
        ? {
            id: String(active._id),
            shiftStart: active.shiftStart,
            shiftEnd: active.shiftEnd,
            ...this.windowProgress(active.shiftStart, active.shiftEnd, timeOfDay),
          }
        : null,
      shifts: rows.map((s) => ({
        id: String(s._id),
        shiftStart: s.shiftStart,
        shiftEnd: s.shiftEnd,
        daysOfWeek: s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS.slice(),
        isActive: s.isActive !== false,
        isOnCall: !!s.isOnCall,
        lengthMinutes: this.windowLengthMinutes(s.shiftStart, s.shiftEnd),
      })),
      leaves: leaveRows.map((l) => ({
        id: String(l._id),
        fromDate: l.fromDate,
        toDate: l.toDate,
        reason: l.reason || '',
      })),
    };
  }

  /**
   * Who is on duty right now, across the whole team — the dashboard "who takes orders now"
   * panel.
   *
   * ⚠ `nextUp` is only ever populated for an ADMIN caller. Staff get who is on duty (they
   * need to know where to hand work) but not the rest of the roster; the response is the
   * privacy boundary, exactly as it is in getMyRoster — never a field the client is trusted
   * to hide.
   *
   * ⚠ `receivesOrders` marks the ONE person `resolveAssignee` would actually pick for an
   * order arriving this second. Several people can be on shift at once, but only the
   * earliest-starting one is routed to; showing them all as equal would misdescribe the
   * system to the person reading the panel.
   *
   * Never throws — a dashboard widget must not take the dashboard down.
   */
  async getDutyBoard(
    nowIso?: string,
    opts?: { includeRoster?: boolean },
  ): Promise<{
    now: string;
    todayWeekday: number;
    onDuty: Array<{
      userId: string;
      name: string;
      shiftStart: string;
      shiftEnd: string;
      remainingMinutes: number;
      receivesOrders: boolean;
      isOnCall: boolean;
    }>;
    onCall: { userId: string; name: string } | null;
    /** Admin-only: everyone else scheduled today who is not currently in their window. */
    nextUp: Array<{ userId: string; name: string; shiftStart: string; shiftEnd: string; startsInMinutes: number }>;
    /** Admin-only: scheduled today but on leave. */
    onLeave: Array<{ userId: string; name: string }>;
    coverageGap: boolean;
  }> {
    const empty = {
      now: '',
      todayWeekday: 0,
      onDuty: [] as any[],
      onCall: null,
      nextUp: [] as any[],
      onLeave: [] as any[],
      coverageGap: false,
    };
    try {
      const parsed = nowIso ? new Date(nowIso) : new Date();
      const ref = isNaN(parsed.getTime()) ? new Date() : parsed;
      const { date: todayDate, weekday, time: timeOfDay } = this.businessParts(ref);

      const [rows0, onLeaveIds, activeUserIds] = await Promise.all([
        this.shiftModel.find({ isActive: true }).lean().exec(),
        this.leaveService.listUserIdsOnLeave(todayDate),
        this.usersService.findActiveUserIds(),
      ]);
      // ⚠ A disabled employee's shift row is not deleted — without this filter
      // they'd still appear "on duty" / "next up" / the on-call fallback on a
      // board whose whole point is showing a live, reachable roster.
      const rows = rows0.filter((s) => activeUserIds.has(String(s.userId)));

      const availableToday = rows.filter(
        (s) =>
          !onLeaveIds.has(String(s.userId)) &&
          (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).includes(weekday),
      );

      // In-window right now, ordered the same way resolveAssignee orders them so the
      // first entry is genuinely the one that would receive an incoming order.
      const inWindow = rows
        .filter(
          (s) =>
            !onLeaveIds.has(String(s.userId)) &&
            this.coversWeekdayAtTime(s as unknown as EmployeeShiftDocument, weekday, timeOfDay),
        )
        .sort(this.byRunningLongest(timeOfDay));

      const onCallRow =
        rows.find(
          (s) =>
            s.isOnCall &&
            !onLeaveIds.has(String(s.userId)) &&
            (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).includes(weekday),
        ) || null;

      const onDuty = inWindow.map((s, i) => ({
        userId: String(s.userId),
        name: s.name,
        shiftStart: s.shiftStart,
        shiftEnd: s.shiftEnd,
        remainingMinutes: this.windowProgress(s.shiftStart, s.shiftEnd, timeOfDay).remainingMinutes,
        receivesOrders: i === 0,
        isOnCall: !!s.isOnCall,
      }));

      const includeRoster = !!opts?.includeRoster;
      const inWindowIds = new Set(inWindow.map((s) => String(s._id)));
      const nextUp = includeRoster
        ? availableToday
            .filter((s) => !inWindowIds.has(String(s._id)) && s.shiftStart > timeOfDay)
            .sort((a, b) => a.shiftStart.localeCompare(b.shiftStart))
            .map((s) => ({
              userId: String(s.userId),
              name: s.name,
              shiftStart: s.shiftStart,
              shiftEnd: s.shiftEnd,
              startsInMinutes: this.toMinutes(s.shiftStart) - this.toMinutes(timeOfDay),
            }))
        : [];

      const onLeave = includeRoster
        ? [
            ...new Map(
              rows
                .filter(
                  (s) =>
                    onLeaveIds.has(String(s.userId)) &&
                    (s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS).includes(weekday),
                )
                .map((s) => [String(s.userId), { userId: String(s.userId), name: s.name }]),
            ).values(),
          ]
        : [];

      return {
        now: ref.toISOString(),
        todayWeekday: weekday,
        onDuty,
        onCall: onCallRow ? { userId: String(onCallRow.userId), name: onCallRow.name } : null,
        nextUp,
        onLeave,
        // Nobody in a window AND no on-call for today means an order arriving now is
        // routed to nobody — the one fact this panel exists to surface.
        coverageGap: onDuty.length === 0 && !onCallRow,
      };
    } catch (err) {
      this.logger.warn(`getDutyBoard failed: ${(err as Error).message}`);
      return empty;
    }
  }

  /** Length of an HH:mm window in minutes; an overnight wrap crosses midnight exactly once. */
  private windowLengthMinutes(start: string, end: string): number {
    const s = this.toMinutes(start);
    let e = this.toMinutes(end);
    // ⚠ `e === s` is zero, not 24h. Adding a day here is what made a "01:00–01:00"
    // row contribute a full 24h to the employee's weekly-hours total (the «٨٤س»
    // in the reported screenshot) for a window that covers no time at all.
    // Only a genuine wrap (end BEFORE start, e.g. 22:00→06:00) crosses midnight.
    if (e === s) return 0;
    if (e < s) e += 24 * 60;
    return e - s;
  }

  /**
   * How far into the window `time` sits.
   *
   * ⚠ On an overnight shift the current time can be on the far side of midnight
   * (start 22:00, end 06:00, now 01:30). Comparing raw minutes makes elapsed
   * negative; advancing `now` by a day when it precedes the start is what keeps
   * the progress monotonic across midnight instead of jumping backwards.
   */
  private windowProgress(
    start: string,
    end: string,
    time: string,
  ): { lengthMinutes: number; elapsedMinutes: number; remainingMinutes: number } {
    const s = this.toMinutes(start);
    const length = this.windowLengthMinutes(start, end);
    let now = this.toMinutes(time);
    if (now < s) now += 24 * 60;
    const elapsed = Math.max(0, Math.min(length, now - s));
    return { lengthMinutes: length, elapsedMinutes: elapsed, remainingMinutes: Math.max(0, length - elapsed) };
  }

  private toMinutes(t: string): number {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }

  /**
   * Ranks shifts that are ALL running at `time`, earliest-started first.
   *
   * ⚠ A plain `shiftStart` string sort is wrong once an overnight shift is involved.
   * At 05:30, a night shift that began 18:00 yesterday has been running 11 hours while
   * a 05:00 morning shift has been running 30 minutes — but '05:00' < '18:00' as a
   * string, so the plain sort called the morning shift "earliest" and handed it the
   * order. The night worker who is actually mid-shift was ranked second.
   *
   * Fix: rank by how long the shift has already been running at `time` (longest first),
   * which is what "earliest start" was always trying to express. For same-day windows
   * this produces exactly the previous order, so nothing changes where there is no wrap.
   *
   * Only valid for shifts already confirmed to cover `time` — it says nothing about
   * shifts that have not started.
   */
  private elapsedAt(shiftStart: string, time: string): number {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const e = toMin(time) - toMin(shiftStart);
    return e < 0 ? e + 24 * 60 : e;   // wrapped past midnight
  }

  /** Comparator for shifts running right now: the one that started earliest comes first. */
  private byRunningLongest(time: string) {
    return (a: { shiftStart: string }, b: { shiftStart: string }) =>
      this.elapsedAt(b.shiftStart, time) - this.elapsedAt(a.shiftStart, time);
  }

  /** Whether shift `s` covers `weekday` (0=Sun..6=Sat) at `time` (HH:mm), honouring overnight wrap. */
  private coversWeekdayAtTime(s: EmployeeShiftDocument, weekday: number, time: string): boolean {
    const days = s.daysOfWeek?.length ? s.daysOfWeek : ALL_DAYS;
    // ⚠ Zero-width window covers NOTHING — the same answer isWithinShiftWindow has
    // always given. Without this the `start < end` test below is false, so the row
    // fell into the overnight-wrap branch and matched every hour of the day: the
    // duty board said "on shift" while the roster header said "off". New rows are
    // rejected at save (see assertNoOverlap), but rows written before that guard
    // existed are still in the database and must not route orders.
    if (s.shiftStart === s.shiftEnd) return false;
    if (s.shiftStart < s.shiftEnd) {
      // Same-day window: the shift must be scheduled on this exact weekday.
      return days.includes(weekday) && this.isWithinShiftWindow(time, s.shiftStart, s.shiftEnd);
    }
    // Overnight wrap (e.g. 22:00 -> 06:00). The window spans two calendar days:
    //   - the late part (time >= start) belongs to the day the shift is scheduled on
    //   - the early part (time < end) belongs to the NEXT calendar day, i.e. the shift
    //     still covers it if the PREVIOUS weekday is in `days`.
    const prevWeekday = (weekday + 6) % 7;
    if (time >= s.shiftStart) return days.includes(weekday);
    if (time < s.shiftEnd) return days.includes(prevWeekday);
    return false;
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────────
   * BUSINESS TIME — the one place a Date becomes a weekday + HH:mm.
   *
   * ⚠ Shift windows are entered as CAIRO WALL-CLOCK times ("09:00–21:00" means
   * nine in the morning in the shop, not 09:00 UTC). Every reader in this service
   * used to call `getUTCHours()`/`getUTCDay()` directly, which is only correct on
   * a machine running in UTC+0. On the real (UTC+3) server it read 07:00 for a
   * Cairo 10:00, so a 09:00–21:00 shift did not match and the duty board reported
   * "nobody is working" in the middle of the working day — the reported bug.
   *
   * It also silently shifted the WEEKDAY: between Cairo 00:00 and 03:00 the UTC
   * day is still yesterday, so the board drew the previous day's roster while the
   * employee's own calendar had already turned over.
   *
   * `Intl` is used rather than a fixed +3 offset because Egypt observes DST
   * (reinstated 2023): a hardcoded offset is wrong for half the year, which is the
   * subtler version of exactly this bug.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  private businessParts(d: Date): { date: string; weekday: number; time: string } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const parts = fmt.formatToParts(d).reduce<Record<string, string>>((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
    // `hour` can come back as '24' at midnight in some ICU versions — normalise to '00',
    // or a midnight comparison sorts after every shift end instead of before every start.
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: WEEKDAY_INDEX[parts.weekday] ?? d.getUTCDay(),
      time: `${hour}:${parts.minute}`,
    };
  }


  /** Tests whether `time` (HH:mm) falls in [start, end), handling overnight-wrapping windows (end < start). */
  private isWithinShiftWindow(time: string, start: string, end: string): boolean {
    if (start === end) return false; // zero-width window, misconfiguration guard
    if (start < end) {
      return time >= start && time < end;
    }
    // overnight wrap, e.g. 22:00 -> 06:00
    return time >= start || time < end;
  }

  /** Defaults to every day — this is what makes a caller who omits daysOfWeek behave like the old always-on shift. */
  private normalizeDays(days?: number[]): number[] {
    if (!days || !days.length) return ALL_DAYS.slice();
    return Array.from(new Set(days)).sort((a, b) => a - b);
  }

  /**
   * Guards against creating two shifts for the same employee whose days AND time
   * windows both overlap — that combination has no sane resolution (resolveAssignee
   * already handles genuine multi-employee overlap by picking the earliest start, but
   * one employee holding two conflicting windows on the same day is a data-entry
   * mistake, not a routing decision). Different days, or non-overlapping times on a
   * shared day, are both fine and are the whole point of allowing multiple shifts.
   */
  private async assertNoOverlap(
    userId: string,
    days: number[],
    start: string,
    end: string,
    excludeId: string | null,
  ): Promise<void> {
    /**
     * ⚠ A zero-width window (start === end, e.g. "01:00–01:00") is rejected here
     * because the three readers CANNOT agree on what it means, and nothing in
     * either layer used to stop it being saved:
     *   · isWithinShiftWindow  → false  (explicit "misconfiguration" guard)
     *   · coversWeekdayAtTime  → true   (start < end is false, so it takes the
     *                                    overnight-wrap branch and matches all day)
     *   · windowLengthMinutes  → 1440   (e <= s, so it adds a full 24h)
     * The result on screen was a shift the duty board treated as covering the
     * whole day while the roster header said «خارج مواعيد عملك» — two panels
     * disagreeing about the same row.
     *
     * Rejected rather than reinterpreted: "01:00 to 01:00" is a typo, and silently
     * turning it into either 0h or 24h would guess at the admin's intent. A real
     * all-day shift is entered as 00:00–23:59.
     */
    if (start === end) {
      throw new BadRequestException('وقت البداية والنهاية لا يمكن أن يكونا متطابقين — لوردية طوال اليوم استخدم 00:00 إلى 23:59');
    }

    const query: Record<string, unknown> = { userId };
    if (excludeId) query._id = { $ne: excludeId };
    const siblings = await this.shiftModel.find(query).exec();

    for (const sib of siblings) {
      const sibDays = new Set(sib.daysOfWeek?.length ? sib.daysOfWeek : ALL_DAYS);
      const sharesDay = days.some((d) => sibDays.has(d));
      if (!sharesDay) continue;
      if (this.timeWindowsOverlap(start, end, sib.shiftStart, sib.shiftEnd)) {
        throw new ConflictException('يوجد بالفعل وردية أخرى لهذا الموظف بنفس اليوم ووقت متداخل');
      }
    }
  }

  /** True when two HH:mm windows (either may wrap past midnight) share any instant. */
  private timeWindowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
    // Expand each window onto a 0..48h timeline (minutes) so overnight wrap is just
    // "end > 24h" instead of a special case, then test standard interval overlap.
    const toMin = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const expand = (s: string, e: string): [number, number] => {
      const sm = toMin(s);
      let em = toMin(e);
      if (em <= sm) em += 24 * 60; // wraps past midnight
      return [sm, em];
    };
    const [as, ae] = expand(aStart, aEnd);
    const [bs, be] = expand(bStart, bEnd);
    // Both windows anchor to the same shared day (callers only reach here after
    // confirming `days` intersects), so a plain interval-overlap test on the 0..48h
    // timeline is sufficient — and must be checked against both the window and its
    // +24h shift, since one window may start before midnight and the other after.
    const intervalsOverlap = (s1: number, e1: number, s2: number, e2: number) => s1 < e2 && s2 < e1;
    return (
      intervalsOverlap(as, ae, bs, be) ||
      intervalsOverlap(as, ae, bs + 24 * 60, be + 24 * 60) ||
      intervalsOverlap(as + 24 * 60, ae + 24 * 60, bs, be)
    );
  }
}
