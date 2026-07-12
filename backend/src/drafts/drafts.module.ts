import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Draft, DraftSchema } from './schemas/draft.schema';
import { DraftsService } from './drafts.service';
import { DraftsController } from './drafts.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Draft.name, schema: DraftSchema }])],
  controllers: [DraftsController],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
