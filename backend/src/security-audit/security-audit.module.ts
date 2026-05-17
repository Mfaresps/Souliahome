import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SecurityAuditLog, SecurityAuditLogSchema } from './schemas/security-audit-log.schema';
import { SecurityAuditService } from './security-audit.service';
import { SecurityAuditController } from './security-audit.controller';
import { UsersModule } from '../users/users.module';
import { MentionsModule } from '../mentions/mentions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SecurityAuditLog.name, schema: SecurityAuditLogSchema },
    ]),
    forwardRef(() => UsersModule),
    forwardRef(() => MentionsModule),
  ],
  controllers: [SecurityAuditController],
  providers: [SecurityAuditService],
  exports: [SecurityAuditService],
})
export class SecurityAuditModule {}
