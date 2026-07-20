import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { CustomerServicePlaybookService } from './customer-service-playbook.service';
import { PlaybookImportExportService } from './playbook-import-export.service';
import { CreateFolderDto, UpdateFolderDto } from './dto/folder.dto';
import { CreateCardDto, UpdateCardDto } from './dto/card.dto';
import { ConfirmImportDto } from './dto/import-export.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

interface AuthedRequest {
  user: { userId?: string; username?: string; name?: string; role?: string };
}

@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('customer-service-playbook')
export class CustomerServicePlaybookController {
  constructor(
    private readonly cspService: CustomerServicePlaybookService,
    private readonly importExportService: PlaybookImportExportService,
  ) {}

  // ── Folders ──

  @Get('folders')
  @RequirePerms('csp-view')
  async findAllFolders(@Query('includeInactive') includeInactive?: string) {
    return this.cspService.findAllFolders(includeInactive === 'true');
  }

  @Post('folders')
  @RequirePerms('csp-manage-folders')
  async createFolder(@Body() dto: CreateFolderDto, @Req() req: AuthedRequest) {
    return this.cspService.createFolder(dto, req.user);
  }

  @Put('folders/:id')
  @RequirePerms('csp-manage-folders')
  async updateFolder(
    @Param('id') id: string,
    @Body() dto: UpdateFolderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.cspService.updateFolder(id, dto, req.user);
  }

  @Delete('folders/:id')
  @RequirePerms('csp-manage-folders')
  async removeFolder(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.cspService.removeFolder(id, req.user);
    return { message: 'تم حذف الفولدر' };
  }

  // ── Analytics (static route — must come before /cards/:id) ──

  @Get('analytics')
  @RequirePerms('csp-analytics')
  async getAnalytics() {
    return this.cspService.getAnalytics();
  }

  // ── Export ──

  @Get('export')
  @RequirePerms('csp-export')
  async exportPlaybook(@Res() res: Response, @Query('format') format?: string) {
    const dateStr = new Date().toISOString().slice(0, 10);
    if ((format || 'excel').toLowerCase() === 'json') {
      const data = await this.importExportService.buildExportJson();
      const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="playbook-backup-${dateStr}.json"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
      return;
    }
    const buffer = await this.importExportService.buildExportExcel();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="playbook-export-${dateStr}.xlsx"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  // ── Import ──

  @Get('import/template')
  @RequirePerms('csp-import')
  async downloadImportTemplate(@Res() res: Response) {
    const buffer = await this.importExportService.buildImportTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="playbook-import-template.xlsx"');
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Get('import/history')
  @RequirePerms('csp-import')
  async getImportHistory(@Query('limit') limit?: string, @Query('skip') skip?: string) {
    return this.importExportService.getImportHistory(
      Number(limit) || 30,
      Number(skip) || 0,
    );
  }

  @Post('import/preview')
  @RequirePerms('csp-import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req: any, file: any, cb: any) => {
        const isXlsx =
          /\.xlsx$/i.test(file.originalname) ||
          file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const isJson =
          /\.json$/i.test(file.originalname) || file.mimetype === 'application/json';
        if (!isXlsx && !isJson) {
          return cb(new BadRequestException('يجب أن يكون الملف بصيغة xlsx أو json'), false);
        }
        cb(null, true);
      },
    }),
  )
  async previewImport(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('لم يتم رفع ملف');
    const isJson =
      /\.json$/i.test(file.originalname) || file.mimetype === 'application/json';
    if (isJson) {
      return this.importExportService.previewImportFromJson(file.buffer);
    }
    return this.importExportService.previewImport(file.buffer);
  }

  @Post('import/confirm')
  @RequirePerms('csp-import')
  async confirmImport(@Body() dto: ConfirmImportDto, @Req() req: AuthedRequest) {
    return this.importExportService.confirmImport(dto, req.user);
  }

  // ── Cards ──

  @Get('cards')
  @RequirePerms('csp-view')
  async findCards(@Query('folderId') folderId?: string, @Query('q') q?: string) {
    return this.cspService.findCards(folderId, q);
  }

  @Get('cards/:id')
  @RequirePerms('csp-view')
  async findCardById(@Param('id') id: string) {
    return this.cspService.findCardById(id);
  }

  @Post('cards')
  @RequirePerms('csp-create')
  async createCard(@Body() dto: CreateCardDto, @Req() req: AuthedRequest) {
    return this.cspService.createCard(dto, req.user);
  }

  @Put('cards/:id')
  @RequirePerms('csp-edit')
  async updateCard(
    @Param('id') id: string,
    @Body() dto: UpdateCardDto,
    @Req() req: AuthedRequest,
  ) {
    return this.cspService.updateCard(id, dto, req.user);
  }

  @Delete('cards/:id')
  @RequirePerms('csp-delete')
  async removeCard(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.cspService.removeCard(id, req.user);
    return { message: 'تم حذف البطاقة' };
  }

  @Post('cards/:id/copy')
  @RequirePerms('csp-view')
  async trackCopy(@Param('id') id: string) {
    return this.cspService.trackCopy(id);
  }
}
