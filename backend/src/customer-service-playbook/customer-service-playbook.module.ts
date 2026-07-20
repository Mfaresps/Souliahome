import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { KnowledgeFolder, KnowledgeFolderSchema } from './schemas/knowledge-folder.schema';
import { KnowledgeCard, KnowledgeCardSchema } from './schemas/knowledge-card.schema';
import {
  KnowledgeAuditLog,
  KnowledgeAuditLogSchema,
} from './schemas/knowledge-audit-log.schema';
import {
  KnowledgeImportLog,
  KnowledgeImportLogSchema,
} from './schemas/knowledge-import-log.schema';
import { CustomerServicePlaybookController } from './customer-service-playbook.controller';
import { CustomerServicePlaybookService } from './customer-service-playbook.service';
import { PlaybookImportExportService } from './playbook-import-export.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KnowledgeFolder.name, schema: KnowledgeFolderSchema },
      { name: KnowledgeCard.name, schema: KnowledgeCardSchema },
      { name: KnowledgeAuditLog.name, schema: KnowledgeAuditLogSchema },
      { name: KnowledgeImportLog.name, schema: KnowledgeImportLogSchema },
    ]),
  ],
  controllers: [CustomerServicePlaybookController],
  providers: [CustomerServicePlaybookService, PlaybookImportExportService],
})
export class CustomerServicePlaybookModule {}
