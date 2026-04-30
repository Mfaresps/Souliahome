import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VaultEntry, VaultEntrySchema } from './schemas/vault-entry.schema';
import { VaultBalance, VaultBalanceSchema } from './schemas/vault-balance.schema';
import { VaultService } from './vault.service';
import { VaultBalanceService } from './vault-balance.service';
import { MigrateBalancesService } from './migrate-balances.service';
import { VaultController } from './vault.controller';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VaultEntry.name, schema: VaultEntrySchema },
      { name: VaultBalance.name, schema: VaultBalanceSchema },
    ]),
    SettingsModule,
    AuthModule,
  ],
  controllers: [VaultController],
  providers: [VaultService, VaultBalanceService, MigrateBalancesService],
  exports: [VaultService, VaultBalanceService],
})
export class VaultModule implements OnModuleInit {
  constructor(private readonly vaultBalanceService: VaultBalanceService) {}

  async onModuleInit(): Promise<void> {
    await this.vaultBalanceService.initializeSegments();
  }
}
