import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards, Optional, ServiceUnavailableException } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { InventoryUnitsService, TrackingActor } from './inventory-units.service';
import { CountAttestationDto, CountReviewDto, IdentifyPurchaseLineDto, LabelRequestDto, LegacyStockIdentifyDto, OrderPickExceptionDto, OrderPickScanDto, ReceiveCustomerPieceDto, RegisterUnitDto, TrackingRequestDto, UnitActionDto } from './inventory-unit.dto';
import { InventoryScanningService } from './inventory-scanning.service';
import { EligibleScanQueryDto, ScanRequestDto } from './inventory-scan.dto';
import { ManualPurchaseReceivingService } from './manual-purchase-receiving.service';
import { ManualPurchaseReceiptDto } from './manual-purchase.dto';
import { InventoryPacksService } from './inventory-packs.service';
import { ScannedSaleService } from './scanned-sale.service';
import { ScannedSaleDto } from './scanned-sale.dto';

@Controller('inventory-units')
@UseGuards(JwtAuthGuard, PermsGuard)
export class InventoryUnitsController {
  constructor(private readonly service: InventoryUnitsService, private readonly scanning: InventoryScanningService,
    private readonly manualReceiving: ManualPurchaseReceivingService, @Optional() private readonly packs?: InventoryPacksService,
    @Optional() private readonly scannedSales?: ScannedSaleService) {}
  @Post('sales') @RequirePerms('inventory-units-view', 'inventory-units-allocate')
  scannedSale(@Body() dto: ScannedSaleDto, @Req() req: { user: TrackingActor }) {
    if (!this.scannedSales) throw new ServiceUnavailableException('Scanned sale service unavailable');
    return this.scannedSales.create(dto, req.user);
  }
  @Get('legacy-stock/summary') @RequirePerms('inventory-units-view', 'inventory-units-register')
  legacySummary(@Query('productId') productId: string, @Query('warehouseCode') warehouseCode: string) { return this.service.legacyStockSummary(productId, warehouseCode); }
  @Get('stocktake') @RequirePerms('inventory-units-view')
  stocktake(@Query('productId') productId: string, @Query('warehouseCode') warehouseCode: string) { return this.service.stocktake(productId, warehouseCode); }
  @Post('legacy-stock/identify') @RequirePerms('inventory-units-view', 'inventory-units-register')
  legacyIdentify(@Body() dto: LegacyStockIdentifyDto, @Req() req: { user: TrackingActor }) { return this.service.identifyLegacyStock(dto, req.user); }
  @Post('purchases/receive') @RequirePerms('purchase-create', 'inventory-units-receive')
  receiveManual(@Body() dto: ManualPurchaseReceiptDto, @Req() req: { user: TrackingActor }) { return this.manualReceiving.receive(dto, req.user); }
  @Get('purchases/readiness') @RequirePerms('purchase-create', 'inventory-units-receive')
  receivingReadiness() { return this.service.readiness(); }
  @Get('purchases/receipts') @RequirePerms('purchase-view', 'inventory-units-view')
  purchaseReceipts(@Query() query: Record<string, string>) { return this.service.purchaseReceipts(query); }
  @Get('purchases/:id/lines/:lineIndex/units') @RequirePerms('purchase-view', 'inventory-units-view')
  purchaseLineUnits(@Param('id') id: string, @Param('lineIndex', ParseIntPipe) lineIndex: number,
    @Query() query: Record<string, string>) { return this.service.purchaseLineUnits(id, lineIndex, query); }
  @Post('purchases/:id/lines/:lineIndex/identify') @RequirePerms('inventory-units-receive')
  identifyPurchaseLine(@Param('id') id: string, @Param('lineIndex', ParseIntPipe) lineIndex: number,
    @Body() dto: IdentifyPurchaseLineDto, @Req() req: { user: TrackingActor }) {
    return this.service.identifyPurchaseLine(id, lineIndex, dto, req.user);
  }
  @Get('purchases/:id/receipt') @RequirePerms('purchase-view')
  manualSummary(@Param('id') id: string) { return this.manualReceiving.summary(id); }
  @Post('scans/validate') @RequirePerms('inventory-units-view')
  scan(@Body() dto: ScanRequestDto, @Req() req: { user: TrackingActor }) { return this.scanning.validate(dto, req.user); }
  @Get('scans/eligible') @RequirePerms('inventory-units-view', 'inventory-units-manual-select')
  eligible(@Query() dto: EligibleScanQueryDto, @Req() req: { user: TrackingActor }) { return this.scanning.eligible(dto, req.user); }
  @Get('scans/operations/:key') @RequirePerms('inventory-units-view')
  scanOperation(@Param('key') key: string, @Req() req: { user: TrackingActor }) { return this.scanning.operation(key, req.user); }
  @Get('config') @RequirePerms('inventory-units-view') config() { return this.service.config(); }
  @Get('readiness') @RequirePerms('inventory-units-reconcile') readiness() { return this.service.readiness(); }
  @Get('reconciliation') @RequirePerms('inventory-units-reconcile') reconciliation() { return this.service.reconciliation(); }
  @Get('reconciliation/counts') @RequirePerms('inventory-units-reconcile')
  countHistory(@Query('productId') id?: string) { return this.service.countHistory(id); }
  @Post('reconciliation/counts') @RequirePerms('inventory-units-reconcile')
  attest(@Body() dto: CountAttestationDto, @Req() req: { user: TrackingActor }) { return this.service.attestCount(dto, req.user); }
  @Post('reconciliation/reviews') @RequirePerms('inventory-units-reconcile-approve')
  review(@Body() dto: CountReviewDto, @Req() req: { user: TrackingActor }) { return this.service.reviewCount(dto, req.user); }
  @Post('labels/requests') @RequirePerms('inventory-units-print', 'inventory-units-view')
  labels(@Body() dto: LabelRequestDto, @Req() req: { user: TrackingActor }) { return this.service.labels(dto, req.user); }
  @Post('labels/preview') @RequirePerms('inventory-units-view')
  preview(@Body() dto: LabelRequestDto) { return this.service.preview(dto); }
  @Post('orders/:id/identify-lines') @RequirePerms('inventory-units-allocate')
  identify(@Param('id') id: string, @Body() dto: TrackingRequestDto, @Req() req: { user: TrackingActor }) { return this.service.identifyLines(id, dto, req.user); }
  @Get('orders/:id/picking') @RequirePerms('inventory-units-view')
  picking(@Param('id') id: string) { return this.service.pickingSummary(id); }
  @Get('orders/:id/identities') @RequirePerms('inventory-units-view')
  invoiceIdentities(@Param('id') id: string) { return this.service.invoiceIdentities(id); }
  @Get('orders/:id/return-pieces') @RequirePerms('inventory-units-view', 'inventory-units-condition')
  returnPieces(@Param('id') id: string) { return this.service.customerReturnCandidates(id); }
  @Post('orders/:id/return-pieces') @RequirePerms('inventory-units-view', 'inventory-units-condition')
  receivePiece(@Param('id') id: string, @Body() dto: ReceiveCustomerPieceDto, @Req() req: { user: TrackingActor }) {
    return this.service.receiveCustomerPiece(id, dto, req.user);
  }
  @Post('orders/:id/picking/exceptions') @RequirePerms('inventory-units-allocate')
  pickException(@Param('id') id: string, @Body() dto: OrderPickExceptionDto, @Req() req: { user: TrackingActor }) { return this.service.pickException(id, dto, req.user); }
  @Post('orders/:id/picking/scans') @RequirePerms('inventory-units-allocate')
  pickScan(@Param('id') id: string, @Body() dto: OrderPickScanDto, @Req() req: { user: TrackingActor }) {
    const identifier = dto.identifier.trim().replace(/^\][A-Za-z]\d/, '').toUpperCase();
    if (/^PK-[A-F\d]{24}$/.test(identifier)) {
      if (!this.packs) throw new ServiceUnavailableException('Pack scanning service unavailable');
      return this.packs.scan(id, { ...dto, identifier }, req.user);
    }
    return this.service.pickScan(id, dto, req.user);
  }
  @Get() @RequirePerms('inventory-units-view') search(@Query() query: Record<string, string>) { return this.service.search(query); }
  @Post() @RequirePerms('inventory-units-register')
  register(@Body() dto: RegisterUnitDto, @Req() req: { user: TrackingActor }) { return this.service.register(dto, req.user); }
  @Get(':identifier') @RequirePerms('inventory-units-view') lookup(@Param('identifier') id: string) { return this.service.lookup(id); }
  @Get(':identifier/action-options') @RequirePerms('inventory-units-view')
  actionOptions(@Param('identifier') id: string, @Query('q') q: string, @Req() req: { user: TrackingActor }) {
    return this.service.actionOptions(id, req.user, q);
  }
  // The service checks the action-specific permission as well; no generic write permission bypass.
  @Post(':identifier/actions')
  action(@Param('identifier') id: string, @Body() dto: UnitActionDto, @Req() req: { user: TrackingActor }) { return this.service.action(id, dto, req.user); }
}
