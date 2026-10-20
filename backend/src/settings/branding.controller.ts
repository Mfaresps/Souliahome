import { Body, Controller, Get, Param, Patch, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { BrandingService, BrandSelection } from './branding.service';
import { MAX_LOGO_UPLOAD_BYTES } from './branding-image.util';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PresenceGateway } from '../auth/presence.gateway';

@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService, private readonly presence: PresenceGateway) {}

  // Public appearance only: needed before login and by browser favicon requests.
  @Get()
  async snapshot(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.branding.snapshot();
  }

  @Get('logos/:id/image')
  async image(@Param('id') id: string, @Res() res: Response) { return this.sendImage(id, false, res); }

  @Get('logos/:id/icon')
  async icon(@Param('id') id: string, @Res() res: Response) { return this.sendImage(id, true, res); }

  private async sendImage(id: string, icon: boolean, res: Response) {
    const image = await this.branding.image(id, icon);
    res.setHeader('Content-Type', icon ? 'image/png' : 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(image);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('library')
  library() { return this.branding.library(); }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('logos')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_LOGO_UPLOAD_BYTES, files: 1, fields: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File, @Body('name') name: string) { return this.branding.upload(file, name); }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('logos/:id')
  rename(@Param('id') id: string, @Body('name') name: string) { return this.branding.rename(id, name); }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Put('selection')
  async select(@Body() selection: BrandSelection) {
    const snapshot = await this.branding.select(selection);
    this.presence.emitEvent('branding:changed', snapshot);
    return snapshot;
  }
}
