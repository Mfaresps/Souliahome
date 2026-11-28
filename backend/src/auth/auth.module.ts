import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { requireJwtSecret } from './jwt-secret.util';
import { PresenceGateway } from './presence.gateway';
import { TotpService } from './totp.service';
import { UserSessionsService } from './user-sessions.service';
import { AuthChallengeService } from './auth-challenge.service';
import { TrustedDevicesService } from './trusted-devices.service';
import { SecurityMailerService } from './security-mailer.service';
import { TokenIssuerService } from './token-issuer.service';
import { SignInVerificationService } from './sign-in-verification.service';
import { PasswordPolicyService } from './password-policy.service';
import { LoginGuardService } from './login-guard.service';
import { AccountEmailService } from './account-email.service';
import { AccountEmailController } from './account-email.controller';
import { AccountEmailGateInterceptor } from './account-email-gate.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsersModule } from '../users/users.module';
import { MentionsModule } from '../mentions/mentions.module';
import { SecurityAuditModule } from '../security-audit/security-audit.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Settings, SettingsSchema } from '../settings/schemas/settings.schema';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    PassportModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: requireJwtSecret(config.get<string>('JWT_SECRET')),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') || '24h' },
      }),
    }),
    forwardRef(() => MentionsModule),
    SecurityAuditModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Settings.name, schema: SettingsSchema },
    ]),
  ],
  controllers: [AuthController, AccountEmailController],
  providers: [
    AuthService, JwtStrategy, PresenceGateway, TotpService, UserSessionsService, AuthChallengeService, TrustedDevicesService, SecurityMailerService, TokenIssuerService, SignInVerificationService, LoginGuardService, PasswordPolicyService, AccountEmailService,
    { provide: APP_INTERCEPTOR, useClass: AccountEmailGateInterceptor },
  ],
  exports: [AuthService, PresenceGateway, TotpService, UserSessionsService, TrustedDevicesService, SecurityMailerService, AccountEmailService],
})
export class AuthModule {}
