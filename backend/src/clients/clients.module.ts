import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { ShopifyOrder, ShopifyOrderSchema } from '../shopify/schemas/shopify-order.schema';
import { ReturnRequest, ReturnRequestSchema } from '../returns/schemas/return-request.schema';
import { FollowUp, FollowUpSchema } from '../followups/schemas/followup.schema';
import { Complaint, ComplaintSchema } from '../complaints/schemas/complaint.schema';
import { ClientContactSchema } from './client-contact.schema';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';

@Module({
  imports: [AuthModule, MongooseModule.forFeature([
    { name: Transaction.name, schema: TransactionSchema },
    { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
    { name: ReturnRequest.name, schema: ReturnRequestSchema },
    { name: FollowUp.name, schema: FollowUpSchema },
    { name: Complaint.name, schema: ComplaintSchema },
    { name: 'ClientContact', schema: ClientContactSchema },
  ])],
  controllers: [ClientsController], providers: [ClientsService],
})
export class ClientsModule {}
