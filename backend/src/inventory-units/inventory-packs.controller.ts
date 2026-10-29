import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { InventoryPacksService } from './inventory-packs.service';
import { InventoryUnitsService, TrackingActor } from './inventory-units.service';
import { CreatePacksDto, PackLabelsDto, TrackingRequestDto, OrderPickScanDto } from './inventory-unit.dto';
@Controller('inventory-packs')
@UseGuards(JwtAuthGuard,PermsGuard)
export class InventoryPacksController {
  constructor(private readonly packs:InventoryPacksService,private readonly tracking:InventoryUnitsService){}
  @Post('orders/:id/scans') @RequirePerms('inventory-units-view','inventory-units-allocate','pickup-orders','pickup-orders-edit') scan(@Param('id') id:string,@Body() dto:OrderPickScanDto,@Req() req:{user:TrackingActor}){return this.packs.scan(id,dto,req.user);}
  @Get() @RequirePerms('inventory-units-view') list(@Query() query:Record<string,string>){return this.packs.list(query);}
  @Post() @RequirePerms('inventory-units-view','inventory-units-allocate') create(@Body() dto:CreatePacksDto,@Req() req:{user:TrackingActor}){return this.packs.create(dto,req.user);}
  @Get('operations/:key') @RequirePerms('inventory-units-view') operation(@Param('key') key:string,@Req() req:{user:TrackingActor}){return this.tracking.packOperationResult(key,req.user);}
  @Post('labels/preview') @RequirePerms('inventory-units-view') preview(@Body() dto:PackLabelsDto,@Req() req:{user:TrackingActor}){return this.packs.labels(dto,req.user);}
  @Post('labels/requests') @RequirePerms('inventory-units-view','inventory-units-print') print(@Body() dto:PackLabelsDto,@Req() req:{user:TrackingActor}){return this.packs.labels(dto,req.user,true);}
  @Post(':barcode/open') @RequirePerms('inventory-units-view','inventory-units-allocate') open(@Param('barcode') barcode:string,@Body() dto:TrackingRequestDto,@Req() req:{user:TrackingActor}){return this.packs.open(barcode,dto,req.user);}
  @Post(':barcode/undo-scan') @RequirePerms('inventory-units-view','inventory-units-allocate','pickup-orders','pickup-orders-edit') undo(@Param('barcode') barcode:string,@Body() dto:TrackingRequestDto,@Req() req:{user:TrackingActor}){return this.packs.undoScan(barcode,dto,req.user);}
}
