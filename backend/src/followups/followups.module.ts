import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FollowUp, FollowUpSchema } from './schemas/followup.schema';
import { FollowUpsService } from './followups.service';
import { FollowUpsController } from './followups.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: FollowUp.name, schema: FollowUpSchema }]),
    AuthModule,
  ],
  controllers: [FollowUpsController],
  providers: [FollowUpsService],
})
export class FollowUpsModule {}
