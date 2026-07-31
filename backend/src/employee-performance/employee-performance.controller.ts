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

  @Get('dashboard')
  @Roles('admin')
  async getDashboard() {
    return this.scoringService.getDashboardStats();
  }

  @Get('my-summary')
  async getMySummary(@Request() req: any) {
    const userId = req.user?.userId || req.user?.sub || '';
    return this.scoringService.getMyPerformanceSummary(String(userId));
  }

  @Get('my-orders')
  async getMyOrders(@Request() req: any, @Query('period') period?: string) {
    const userId = req.user?.userId || req.user?.sub || '';
    const p = period === 'week' ? 'week' : 'today';
    return this.scoringService.getMyAssignedOrders(String(userId), p);
  }

  @Get('logs')
  @Roles('admin')
  async getLogs(@Query('employeeId') employeeId?: string, @Query('orderId') orderId?: string) {
    return this.scoringService.getLogs({ employeeId, orderId });
  }

  @Post('manual-bonus')
  @Roles('admin')
  async addManualBonus(@Body() dto: ManualBonusDto, @Request() req: any) {
    const adjustedBy = req.user?.username || req.user?.name || 'admin';
    const log = await this.scoringService.addManualBonus(dto.employeeId, dto.points, dto.reason, adjustedBy);
    return { success: true, log };
  }
}
