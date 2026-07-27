import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DemandPlanningService } from './demand-planning.service';
import {
  AnalyzeDemandDto,
  AnalyzeShopifyDemandDto,
  AddToPurchaseOrderDto,
  CreatePoFromDemandDto,
} from './dto/demand-planning.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

interface AuthedRequest {
  user?: { name?: string; username?: string; role?: string };
}

@UseGuards(JwtAuthGuard)
@Controller('demand-planning')
export class DemandPlanningController {
  constructor(private readonly service: DemandPlanningService) {}

  /** Run the demand/inventory analysis over the selected transactions */
  @Post('analyze')
  analyze(@Body() dto: AnalyzeDemandDto, @Req() req: AuthedRequest) {
    return this.service.analyze(dto, {
      name: req.user?.name,
      username: req.user?.username,
    });
  }

  /**
   * Demand analysis for pending Shopify orders — the orders whose stock has
   * not been deducted yet, so the shortage is actionable before approval.
   */
  @Post('analyze-shopify')
  analyzeShopify(
    @Body() dto: AnalyzeShopifyDemandDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.analyzeShopify(dto, {
      name: req.user?.name,
      username: req.user?.username,
    });
  }

  /** Purchase orders that can still receive additional quantities */
  @Get('open-purchase-orders')
  openPurchaseOrders() {
    return this.service.findOpenPurchaseOrders();
  }

  /** Merge shortage quantities into an existing purchase order */
  @Post('add-to-purchase-order')
  addToPurchaseOrder(
    @Body() dto: AddToPurchaseOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.addToPurchaseOrder({
      ...dto,
      by: dto.by || req.user?.name || req.user?.username || 'النظام',
      byUsername: dto.byUsername || req.user?.username || '',
    });
  }

  /** Create a new purchase order out of the shortage lines */
  @Post('create-purchase-order')
  createPurchaseOrder(
    @Body() dto: CreatePoFromDemandDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.createPurchaseOrderFromDemand({
      ...dto,
      by: dto.by || req.user?.name || req.user?.username || 'النظام',
      byUsername: dto.byUsername || req.user?.username || '',
    });
  }

  /** Audit trail of every demand-planning action */
  @Get('logs')
  logs(@Query('limit') limit?: string) {
    return this.service.findLogs(limit ? Number(limit) : undefined);
  }
}
