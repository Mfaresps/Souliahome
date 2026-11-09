import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { AccessRole, AccessRoleSchema } from './schemas/access-role.schema';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AccessRolesController } from './access-roles.controller';
import { AccessRolesService } from './access-roles.service';
import { AuthModule } from '../auth/auth.module';
import { SecurityAuditModule } from '../security-audit/security-audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AccessRole.name, schema: AccessRoleSchema },
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    forwardRef(() => AuthModule),
    forwardRef(() => SecurityAuditModule),
  ],
  controllers: [UsersController, AccessRolesController],
  providers: [UsersService, AccessRolesService],
  exports: [UsersService],
})
export class UsersModule {}
