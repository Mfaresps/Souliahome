import { Module, forwardRef } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { InvoiceImagesModule } from '../invoice-images/invoice-images.module';
import { MentionsModule } from '../mentions/mentions.module';
import { SecurityAuditModule } from '../security-audit/security-audit.module';
import { InvitationsController, JoinController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/** «إرسال دعوة» — writes only `userinvitations` (+ the account it creates). */
@Module({
  imports: [
    forwardRef(() => UsersModule),
    forwardRef(() => AuthModule),
    InvoiceImagesModule,
    forwardRef(() => MentionsModule),
    forwardRef(() => SecurityAuditModule),
  ],
  controllers: [InvitationsController, JoinController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
