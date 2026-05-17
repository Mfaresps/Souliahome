import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PresenceGateway } from './presence.gateway';
import { TotpService } from './totp.service';
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
        secret: config.get<string>('JWT_SECRET') || 'soulia_jwt_default_secret',
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
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PresenceGateway, TotpService],
  exports: [AuthService, PresenceGateway, TotpService],
})
export class AuthModule {}
