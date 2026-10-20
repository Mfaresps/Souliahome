import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InventoryUnit, InventoryUnitSchema } from './schemas/inventory-unit.schema';
import { InventoryUnitEvent, InventoryUnitEventSchema } from './schemas/inventory-unit-event.schema';
import { InventoryUnitOperation, InventoryUnitOperationSchema } from './schemas/inventory-unit-operation.schema';
import { InventoryUnitsService } from './inventory-units.service';
import { InventoryUnitsController } from './inventory-units.controller';
import { InventoryScanningService } from './inventory-scanning.service';
import { ManualPurchaseReceivingService } from './manual-purchase-receiving.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { UnitManualCodesService } from './unit-manual-codes.service';
import { InventoryPacksService } from './inventory-packs.service';
import { InventoryPacksController } from './inventory-packs.controller';

/** Identity aliases initialize their own indexes; existing unit identities and stock are never rewritten. */
@Module({
  imports: [MongooseModule.forFeature([
    { name: InventoryUnit.name, schema: InventoryUnitSchema },
    { name: InventoryUnitEvent.name, schema: InventoryUnitEventSchema },
    { name: InventoryUnitOperation.name, schema: InventoryUnitOperationSchema },
  ]), TransactionsModule],
  controllers: [InventoryUnitsController, InventoryPacksController],
  providers: [InventoryUnitsService, InventoryPacksService, InventoryScanningService, ManualPurchaseReceivingService, UnitManualCodesService],
  exports: [MongooseModule, InventoryUnitsService],
})
export class InventoryUnitsModule {}
