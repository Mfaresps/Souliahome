import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { EmployeeShiftService } from './employee-shift.service';
import { EmployeeScoringService } from './employee-scoring.service';
import { CreateEmployeeShiftDto, UpdateEmployeeShiftDto } from './dto/employee-shift.dto';
import { ManualBonusDto } from './dto/manual-bonus.dto';

@Controller('employee-performance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeePerformanceController {
  constructor(
    private readonly shiftService: EmployeeShiftService,
    private readonly scoringService: EmployeeScoringService,
  ) {}

  @Get('shifts')
  async listShifts() {
    return this.shiftService.listShifts();
  }

  @Post('shifts')
  @Roles('admin')
  async createShift(@Body() dto: CreateEmployeeShiftDto, @Request() req: any) {
    const by = req.user?.username || req.user?.name || 'admin';
    return this.shiftService.createShift(dto, by);
  }

  @Put('shifts/:id')
  @Roles('admin')
  async updateShift(@Param('id') id: string, @Body() dto: UpdateEmployeeShiftDto, @Request() req: any) {
    const by = req.user?.username || req.user?.name || 'admin';
    return this.shiftService.updateShift(id, dto, by);
  }

  @Delete('shifts/:id')
  @Roles('admin')
  async deleteShift(@Param('id') id: string) {
    return this.shiftService.deleteShift(id);
  }

  @Post('shifts/:id/set-on-call')
  @Roles('admin')
  async setOnCall(@Param('id') id: string) {
    return this.shiftService.setOnCall(id);
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
}
