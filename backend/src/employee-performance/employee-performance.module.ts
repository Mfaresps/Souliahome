import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmployeePerformanceController } from './employee-performance.controller';
import { EmployeeShiftService } from './employee-shift.service';
import { EmployeeLeaveService } from './employee-leave.service';
import { EmployeeScoringService } from './employee-scoring.service';
import { ShiftIndexMigration } from './shift-index.migration';
import { EmployeeShift, EmployeeShiftSchema } from './schemas/employee-shift.schema';
import { EmployeeLeave, EmployeeLeaveSchema } from './schemas/employee-leave.schema';
import { EmployeePerformanceLog, EmployeePerformanceLogSchema } from './schemas/employee-performance-log.schema';
import { ShopifyOrder, ShopifyOrderSchema } from '../shopify/schemas/shopify-order.schema';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { FollowUp, FollowUpSchema } from '../followups/schemas/followup.schema';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmployeeShift.name, schema: EmployeeShiftSchema },
      { name: EmployeeLeave.name, schema: EmployeeLeaveSchema },
      { name: EmployeePerformanceLog.name, schema: EmployeePerformanceLogSchema },
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: User.name, schema: UserSchema },
      // ⚠ Schema-only — same pattern and reason as ShopifyOrder in TransactionsModule.
      // getMyWorkspace reads the caller's own follow-ups; importing FollowUpsModule
      // would close a cycle, since FollowUpsModule already imports THIS module for
      // EmployeeShiftService.resolveAssignee.
      { name: FollowUp.name, schema: FollowUpSchema },
    ]),
    forwardRef(() => UsersModule),
    forwardRef(() => SettingsModule),
    forwardRef(() => AuthModule),
  ],
  controllers: [EmployeePerformanceController],
  providers: [EmployeeShiftService, EmployeeLeaveService, EmployeeScoringService, ShiftIndexMigration],
  exports: [EmployeeShiftService, EmployeeLeaveService, EmployeeScoringService],
})
export class EmployeePerformanceModule {}
