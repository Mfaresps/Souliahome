import { Global, Module } from '@nestjs/common';
import { MentionsModule } from '../mentions/mentions.module';
import { UsersModule } from '../users/users.module';
import { SecurityAuditModule } from '../security-audit/security-audit.module';
import { AuthModule } from '../auth/auth.module';
import { BrowseAccessService } from './browse-access.service';
import { BrowseAccessController } from './browse-access.controller';

/** Global: the transactions and clients controllers ask it whether an account may browse. */
@Global()
@Module({
  imports: [MentionsModule, UsersModule, SecurityAuditModule, AuthModule],
  providers: [BrowseAccessService],
  controllers: [BrowseAccessController],
  exports: [BrowseAccessService],
})
export class BrowseAccessModule {}
