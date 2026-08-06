import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FollowUp, FollowUpSchema } from './schemas/followup.schema';
import { FollowUpsService } from './followups.service';
import { FollowUpsController } from './followups.controller';
import { AuthModule } from '../auth/auth.module';
import { MentionsModule } from '../mentions/mentions.module';
import { EmployeePerformanceModule } from '../employee-performance/employee-performance.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: FollowUp.name, schema: FollowUpSchema }]),
    AuthModule,
    MentionsModule,
    // For EmployeeShiftService.resolveAssignee — auto-assigns shipping-issue
    // follow-ups to whoever is on shift.
    EmployeePerformanceModule,
  ],
  controllers: [FollowUpsController],
  providers: [FollowUpsService],
  // Exported so BostaService can open a follow-up when a delivery fails.
  exports: [FollowUpsService],
})
export class FollowUpsModule {}
