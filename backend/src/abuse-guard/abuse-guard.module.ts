import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { MentionsModule } from '../mentions/mentions.module';
import { UsersModule } from '../users/users.module';
import { SecurityAuditModule } from '../security-audit/security-audit.module';
import { AuthModule } from '../auth/auth.module';
import { AbuseGuardService } from './abuse-guard.service';
import { AbuseGuardInterceptor } from './abuse-guard.interceptor';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]), MentionsModule, UsersModule, SecurityAuditModule, AuthModule],
  providers: [AbuseGuardService, { provide: APP_INTERCEPTOR, useClass: AbuseGuardInterceptor }],
  exports: [AbuseGuardService],
})
export class AbuseGuardModule {}
