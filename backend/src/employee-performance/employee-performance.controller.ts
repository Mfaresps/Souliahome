import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { EmployeeShiftService } from './employee-shift.service';
import { EmployeeLeaveService } from './employee-leave.service';
import { EmployeeScoringService } from './employee-scoring.service';
import { CreateEmployeeShiftDto, UpdateEmployeeShiftDto } from './dto/employee-shift.dto';
import { CreateEmployeeLeaveDto } from './dto/employee-leave.dto';
import { ManualBonusDto } from './dto/manual-bonus.dto';
import { PresenceGateway } from '../auth/presence.gateway';

@Controller('employee-performance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeePerformanceController {
  constructor(
    private readonly shiftService: EmployeeShiftService,
    private readonly leaveService: EmployeeLeaveService,
    private readonly scoringService: EmployeeScoringService,
    private readonly presence: PresenceGateway,
  ) {}

  /**
   * Tells every connected client that the roster changed, so an employee's own
   * «مواعيد عملي» strip and the duty board update the moment an admin edits a shift.
   *
   * ⚠ Without this the employee's browser only re-read the roster on its 60s dashboard
   * tick, so the week table (redrawn from the admin's own response) could show the NEW
   * window while the strip above it still said «خارج مواعيد عملك» from the previous
   * poll — two panels disagreeing about the same shift. The reported bug.
   *
   * Never throws: a socket that is down must not fail a write that already committed.
   */
  private emitRosterChanged(action: string, userIds: string[] = []) {
    const affected = userIds.filter(Boolean).map(String);
    try { this.presence.emitEvent('shifts:changed', { action, userIds: affected }); } catch (_) {}
  }

  /**
   * ⚠ Admin-only. This returns EVERY employee's schedule, and the frontend was the
   * only thing hiding it — `renderEmployeeShiftsSection()` gates on `isAdmin()`, so
   * a staff member could still read the whole roster straight from the API.
   * A staff member reads their own schedule through `my-roster` below, which is
   * scoped in the query. Hiding a row in the renderer is not a guard.
   */
  @Get('shifts')
  @Roles('admin')
  async listShifts() {
    return this.shiftService.listShifts();
  }

  @Post('shifts')
  @Roles('admin')
  async createShift(@Body() dto: CreateEmployeeShiftDto, @Request() req: any) {
    const by = req.user?.username || req.user?.name || 'admin';
    const r = await this.shiftService.createShift(dto, by);
    this.emitRosterChanged('create', [dto.userId]);
    return r;
  }

  @Put('shifts/:id')
  @Roles('admin')
  async updateShift(@Param('id') id: string, @Body() dto: UpdateEmployeeShiftDto, @Request() req: any) {
    const by = req.user?.username || req.user?.name || 'admin';
    const owner = await this.shiftService.findShiftOwner(id);
    const r = await this.shiftService.updateShift(id, dto, by);
    this.emitRosterChanged('update', [owner]);
    return r;
  }

  @Delete('shifts/:id')
  @Roles('admin')
  async deleteShift(@Param('id') id: string) {
    // ⚠ يُقرأ المالك قبل الحذف — بعده السجل مش موجود ومفيش طريقة نعرف مين اتأثر.
    const owner = await this.shiftService.findShiftOwner(id);
    const r = await this.shiftService.deleteShift(id);
    this.emitRosterChanged('delete', [owner]);
    return r;
  }

  @Post('shifts/:id/set-on-call')
  @Roles('admin')
  async setOnCall(@Param('id') id: string) {
    const owner = await this.shiftService.findShiftOwner(id);
    const r = await this.shiftService.setOnCall(id);
    this.emitRosterChanged('on-call', [owner]);
    return r;
  }

  @Post('shifts/:id/unset-on-call')
  @Roles('admin')
  async unsetOnCall(@Param('id') id: string) {
    const owner = await this.shiftService.findShiftOwner(id);
    const r = await this.shiftService.unsetOnCall(id);
    this.emitRosterChanged('on-call', [owner]);
    return r;
  }

  /**
   * Who is on duty right now — the dashboard panel. Open to any signed-in user, but the
   * FULL roster (who is next up, who is on leave) is added only for an admin.
   *
   * ⚠ The role check happens here, not in the client: staff must not receive their
   * colleagues' schedule at all, rather than receive it and be trusted to hide it.
   */
  @Get('duty-board')
  async getDutyBoard(@Request() req: any) {
    const isAdmin = req.user?.role === 'admin';
    return this.shiftService.getDutyBoard(undefined, { includeRoster: isAdmin });
  }

  /** ⚠ Admin-only for the same reason as `shifts` above — it lists every employee's leave. */
  @Get('leaves')
  @Roles('admin')
  async listLeaves() {
    return this.leaveService.listLeaves();
  }

  @Post('leaves')
  @Roles('admin')
  async createLeave(@Body() dto: CreateEmployeeLeaveDto, @Request() req: any) {
    const by = req.user?.username || req.user?.name || 'admin';
    const r = await this.leaveService.createLeave(dto, by);
    this.emitRosterChanged('leave', [dto.userId]);
    return r;
  }

  @Delete('leaves/:id')
  @Roles('admin')
  async deleteLeave(@Param('id') id: string) {
    const owner = await this.leaveService.findLeaveOwner(id);
    const r = await this.leaveService.deleteLeave(id);
    this.emitRosterChanged('leave', [owner]);
    return r;
  }

  /**
   * `period` is one of week|month|year|all and defaults to 'month' — the reset cycle.
   * `periodKey` ("2026-08", "2026-W34", "2026") selects WHICH one; omit it for the
   * current period. Both fall back rather than 400ing inside resolvePeriod(): a stale
   * bookmark or a deleted month should land on today, not on an error page.
   */
  @Get('dashboard')
  @Roles('admin')
  async getDashboard(@Query('period') period?: string, @Query('periodKey') periodKey?: string) {
    return this.scoringService.getDashboardStats(period, periodKey);
  }

  /** The periods that actually have data — what the month picker is built from. */
  @Get('periods')
  @Roles('admin')
  async getPeriods(@Query('period') period?: string) {
    return this.scoringService.getAvailablePeriods(period);
  }

  @Get('my-summary')
  async getMySummary(
    @Request() req: any,
    @Query('period') period?: string,
    @Query('periodKey') periodKey?: string,
  ) {
    const userId = req.user?.userId || req.user?.sub || '';
    return this.scoringService.getMyPerformanceSummary(String(userId), period, periodKey);
  }

  /**
   * Everything the staff dashboard draws: the caller's own KPIs, assigned orders,
   * open follow-ups and shipments.
   *
   * ⚠ There is deliberately NO `employeeId` parameter. The identity comes from the
   * JWT and nowhere else — accepting one would turn a staff endpoint into a way to
   * read any colleague's workload by guessing an id. An admin who needs another
   * employee's figures uses `dashboard`/`logs`, which are `@Roles('admin')`.
   */
  @Get('my-workspace')
  async getMyWorkspace(
    @Request() req: any,
    @Query('period') period?: string,
    @Query('periodKey') periodKey?: string,
  ) {
    const userId = req.user?.userId || req.user?.sub || '';
    return this.scoringService.getMyWorkspace(String(userId), period, periodKey);
  }

  /** The caller's own shift schedule + leave, and where they stand in today's window. */
  @Get('my-roster')
  async getMyRoster(@Request() req: any) {
    const userId = req.user?.userId || req.user?.sub || '';
    return this.shiftService.getMyRoster(String(userId));
  }

  @Get('my-orders')
  async getMyOrders(@Request() req: any, @Query('period') period?: string) {
    const userId = req.user?.userId || req.user?.sub || '';
    const p = period === 'week' ? 'week' : 'today';
    return this.scoringService.getMyAssignedOrders(String(userId), p);
  }

  @Get('logs')
  @Roles('admin')
  async getLogs(
    @Query('employeeId') employeeId?: string,
    @Query('orderId') orderId?: string,
    @Query('period') period?: string,
    @Query('periodKey') periodKey?: string,
  ) {
    return this.scoringService.getLogs({ employeeId, orderId, period, periodKey });
  }

  @Post('manual-bonus')
  @Roles('admin')
  async addManualBonus(@Body() dto: ManualBonusDto, @Request() req: any) {
    const adjustedBy = req.user?.username || req.user?.name || 'admin';
    const log = await this.scoringService.addManualBonus(dto.employeeId, dto.points, dto.reason, adjustedBy);
    return { success: true, log };
  }

  /**
   * Post-restore health check — the answer to "did the points survive?".
   *
   * ⚠ Read-only. It reports; it never repairs. A restore that silently drops the
   * link between a point row and its employee renders an EMPTY leaderboard with
   * every row still present, which reads as "nobody scored" rather than "the data
   * is mis-linked" — the same class of invisible failure as a backup that captured
   * users and then skipped them on restore. Run this after any restore, and after
   * moving data between the local and the online install.
   *
   * `rosterCovered` is deliberately part of the answer: an employee whose points are
   * perfectly linked is STILL invisible on the leaderboard if their shift row did not
   * come across, because the roster is built from employeeshifts. Reporting only the
   * link health would call that database healthy while the screen shows nothing.
   */
  @Get('health')
  @Roles('admin')
  async getHealth() {
    return this.scoringService.getPerformanceDataHealth();
  }

  /**
   * Manual repair. The same pass runs automatically on every boot, so this exists for
   * an admin who has just restored and wants the fix applied without a restart.
   * `dryRun` defaults to TRUE: a bare POST previews and writes nothing.
   */
  @Post('repair-links')
  @Roles('admin')
  async repairLinks(@Body() body: { dryRun?: boolean }) {
    const dryRun = body?.dryRun !== false;
    const backfill = await this.scoringService.backfillLogUsernames(dryRun);
    const relink = await this.scoringService.relinkOrphanedLogs(dryRun);
    // Shifts break the same way and matter just as much — the roster is built from them.
    const shiftBackfill = await this.scoringService.backfillShiftUsernames(dryRun);
    const shiftRelink = await this.scoringService.relinkOrphanedShifts(dryRun);
    // Orders and follow-ups carry the same User._id link and break identically.
    const links = await this.scoringService.healOrderAndFollowUpLinks(dryRun);
    return { success: true, dryRun, backfill, relink, shiftBackfill, shiftRelink, links };
  }
}
