import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Mention, MentionSchema } from './schemas/mention.schema';
import { MentionsService } from './mentions.service';
import { MentionsController } from './mentions.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Mention.name, schema: MentionSchema }]),
    AuthModule,
  ],
  controllers: [MentionsController],
  providers: [MentionsService],
  exports: [MentionsService],
})
export class MentionsModule {}
