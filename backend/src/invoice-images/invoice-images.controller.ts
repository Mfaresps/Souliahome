import { Body, Controller, Get, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { InvoiceImagesService, MAX_INVOICE_UPLOAD_BYTES } from './invoice-images.service';

@Controller('invoice-images')
export class InvoiceImagesController {
  constructor(private readonly service: InvoiceImagesService) {}

  /** Permission (purchase create / edit, or `expenses` for purpose=expense) is checked in the service. */
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_INVOICE_UPLOAD_BYTES } }))
  upload(@Req() req: any, @UploadedFile() file: any, @Body('purpose') purpose?: string) {
    return this.service.upload(req.user, file, purpose);
  }

  /** ⚠ No session: the random 64-hex id is the capability (img tags and prints send no token). */
  @Get(':id')
  async image(@Param('id') id: string, @Res() res: Response) {
    const body = await this.service.read(id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }
}
