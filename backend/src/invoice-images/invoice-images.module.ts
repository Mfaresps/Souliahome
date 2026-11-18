import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { InvoiceImagesController } from './invoice-images.controller';
import { InvoiceImagesService } from './invoice-images.service';

/** Supplier invoice photos on purchases — writes only `purchaseinvoiceimages` (and R2). */
@Module({
  imports: [forwardRef(() => AuthModule), SettingsModule],
  controllers: [InvoiceImagesController],
  providers: [InvoiceImagesService],
})
export class InvoiceImagesModule {}
