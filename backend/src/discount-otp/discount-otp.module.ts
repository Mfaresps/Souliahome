import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiscountOtp, DiscountOtpSchema } from './schemas/discount-otp.schema';
import { DiscountOtpService } from './discount-otp.service';
import { DiscountOtpController } from './discount-otp.controller';
import { SettingsModule } from '../settings/settings.module';
import { MentionsModule } from '../mentions/mentions.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DiscountOtp.name, schema: DiscountOtpSchema },
    ]),
    SettingsModule,
    MentionsModule,
    UsersModule,
    AuthModule,
  ],
  controllers: [DiscountOtpController],
  providers: [DiscountOtpService],
  exports: [DiscountOtpService],
})
export class DiscountOtpModule {}
