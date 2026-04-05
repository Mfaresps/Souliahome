import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VaultEntry, VaultEntrySchema } from './schemas/vault-entry.schema';
import { VaultService } from './vault.service';
import { VaultController } from './vault.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VaultEntry.name, schema: VaultEntrySchema },
    ]),
    SettingsModule,
  ],
  controllers: [VaultController],
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
