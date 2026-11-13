import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { SupplierReturnStatementsController } from './supplier-return-statements.controller';
import { SupplierReturnStatementsService } from './supplier-return-statements.service';

/**
 * Documentation-only supplier return statements. ⚠ Imports nothing from inventory, ledger,
 * vault, transactions or purchase orders on purpose — it reads their collections directly for
 * reference checks and never calls a service that could write.
 */
@Module({
  imports: [forwardRef(() => AuthModule), SettingsModule],
  controllers: [SupplierReturnStatementsController],
  providers: [SupplierReturnStatementsService],
})
export class SupplierReturnStatementsModule {}
