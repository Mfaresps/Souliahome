import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmployeePerformanceController } from './employee-performance.controller';
import { EmployeeShiftService } from './employee-shift.service';
import { EmployeeScoringService } from './employee-scoring.service';
import { EmployeeShift, EmployeeShiftSchema } from './schemas/employee-shift.schema';
import { EmployeePerformanceLog, EmployeePerformanceLogSchema } from './schemas/employee-performance-log.schema';
import { ShopifyOrder, ShopifyOrderSchema } from '../shopify/schemas/shopify-order.schema';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmployeeShift.name, schema: EmployeeShiftSchema },
      { name: EmployeePerformanceLog.name, schema: EmployeePerformanceLogSchema },
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => UsersModule),
    forwardRef(() => SettingsModule),
    forwardRef(() => AuthModule),
  ],
  controllers: [EmployeePerformanceController],
  providers: [EmployeeShiftService, EmployeeScoringService],
  exports: [EmployeeShiftService, EmployeeScoringService],
})
export class EmployeePerformanceModule {}
