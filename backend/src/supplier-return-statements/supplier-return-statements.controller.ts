import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { SupplierReturnStatementsService } from './supplier-return-statements.service';
import { RS_REASONS, RS_STATUSES } from './supplier-return-statement.constants';

/**
 * «بيانات المرتجعات» — documentation only. Every permission decision is in the service
 * (create vs. edit-own-draft, view = any statement perm), so the routes need only a session.
 * ⚠ `meta` is declared before `:id` — Nest matches in declaration order.
 */
@UseGuards(JwtAuthGuard)
@Controller('supplier-return-statements')
export class SupplierReturnStatementsController {
  constructor(private readonly service: SupplierReturnStatementsService) {}

  @Get('meta')
  meta() { return { reasons: RS_REASONS, statuses: RS_STATUSES }; }

  @Get()
  list(@Req() req: any, @Query('supplierId') supplierId: string) { return this.service.list(req.user, supplierId); }

  @Post()
  create(@Req() req: any, @Body() body: any) { return this.service.create(req.user, body); }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) { return this.service.get(req.user, id); }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.service.update(req.user, id, body); }

  @Post(':id/status')
  status(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.service.setStatus(req.user, id, body); }

  @Post(':id/printed')
  printed(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.service.recordPrint(req.user, id, String(body?.kind || 'print')); }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) { return this.service.remove(req.user, id); }

  @Post(':id/lines/:lineId/photos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0 } }))
  upload(@Req() req: any, @Param('id') id: string, @Param('lineId') lineId: string, @UploadedFile() file: any) {
    return this.service.uploadImage(req.user, id, lineId, file);
  }

  @Get(':id/photos/:attId')
  photo(@Req() req: any, @Param('id') id: string, @Param('attId') attId: string) { return this.service.getImage(req.user, id, attId); }

  @Delete(':id/photos/:attId')
  removePhoto(@Req() req: any, @Param('id') id: string, @Param('attId') attId: string) { return this.service.removeImage(req.user, id, attId); }
}
