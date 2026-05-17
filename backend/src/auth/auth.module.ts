import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PresenceGateway } from './presence.gateway';
import { UsersModule } from '../users/users.module';
import { MentionsModule } from '../mentions/mentions.module';
import { SecurityAuditModule } from '../security-audit/security-audit.module';

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
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PresenceGateway],
  exports: [AuthService, PresenceGateway],
})
export class AuthModule {}
