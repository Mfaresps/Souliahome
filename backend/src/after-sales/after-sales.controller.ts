import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { AfterSalesService } from './after-sales.service';
import { AfterSalesAccessGuard } from './after-sales-access.guard';
@Controller('after-sales') @UseGuards(JwtAuthGuard, RolesGuard, AfterSalesAccessGuard)
export class AfterSalesController {
  constructor(private readonly service: AfterSalesService) {}
  @Get() list(@Query('invoiceId') invoiceId?: string, @Query('q') q?: string) { return this.service.list(invoiceId, q); }
  @Get('policy') policy() { return this.service.policy(); }
  @Get('shipping/cities') cities() { return this.service.shippingCities(); }
  @Get('shipping/cities/:cityId/districts') districts(@Param('cityId') cityId: string) { return this.service.shippingDistricts(cityId); }
  @Post('policy') @Roles('admin') savePolicy(@Body() body: any, @Req() req: any) { return this.service.savePolicy(body, req.user); }
  @Get('report') report(@Query('from') from?: string, @Query('to') to?: string) { return this.service.report(from, to); }
  @Get('invoice/:id') invoice(@Param('id') id: string) { return this.service.invoice(id); }
  @Post('quote') quote(@Body() body: any) { return this.service.quote(body); }
  @Post() create(@Body() body: any, @Req() req: any) { return this.service.create(body, req.user); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Post(':id/approve') @Roles('admin') approve(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.approve(id, body, req.user); }
  @Post(':id/rollback') @Roles('admin') rollback(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.rollback(id, body, req.user); }
  @Post(':id/cancel') @Roles('admin') cancel(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.cancel(id, body, req.user); }
  @Post(':id/ship') ship(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.ship(id, body, req.user); }
  @Post(':id/sync') sync(@Param('id') id: string) { return this.service.sync(id); }
  @Post(':id/link-shipment') @Roles('admin') link(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.linkShipment(id, body, req.user); }
  @Post(':id/receive') receive(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.receive(id, body, req.user); }
  @Post(':id/delivery') @Roles('admin') delivery(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.delivery(id, body, req.user); }
  @Post(':id/settle') @Roles('admin') settle(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.settle(id, body, req.user); }
  @Post(':id/exception') exception(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.service.exception(id, body, req.user); }
}
