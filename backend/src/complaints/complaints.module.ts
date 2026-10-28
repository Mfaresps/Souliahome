import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Complaint, ComplaintSchema } from './schemas/complaint.schema';
import { ComplaintsService } from './complaints.service';
import { ComplaintsController } from './complaints.controller';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [
    VaultModule,
    MongooseModule.forFeature([
      { name: Complaint.name, schema: ComplaintSchema },
    ]),
  ],
  controllers: [ComplaintsController],
  providers: [ComplaintsService],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
