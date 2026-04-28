import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { ExpensesService } from './expenses.service';
import {
  CreateExpenseDto,
  UpdateExpenseDto,
} from './dto/expense.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  async findAll() {
    return this.expensesService.findAll();
  }

  // Static routes MUST come before :id dynamic routes
  @Post('bulk-delete')
  async bulkDelete(@Body() body: { ids?: string[] }) {
    if (!body.ids || !body.ids.length) {
      throw new BadRequestException('ids مطلوبة');
    }
    const count = await this.expensesService.bulkRemovePending(body.ids);
    return { message: `تم حذف ${count} مصروف`, count };
  }

  @Post('upload-attachment')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_req: any, _file: any, cb: any) => {
        const dir = path.join(process.cwd(), 'uploads', 'expenses');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req: any, file: any, cb: any) => {
        const ext = path.extname(file.originalname);
        cb(null, `exp-${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) {
        return cb(new BadRequestException('نوع الملف غير مسموح'), false);
      }
      cb(null, true);
    },
  }))
  async uploadAttachment(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('لم يتم رفع ملف');
    return { filename: file.filename, path: `/api/expenses/attachments/${file.filename}` };
  }

  @Get('attachments/:filename')
  async getAttachment(@Param('filename') filename: string, @Res() res: Response) {
    const dir = path.join(process.cwd(), 'uploads', 'expenses');
    const safeFile = path.basename(filename);
    const filePath = path.join(dir, safeFile);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ message: 'الملف غير موجود' });
      return;
    }
    res.sendFile(filePath);
  }

  // Dynamic :id routes come after static routes
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.expensesService.findById(id);
  }

  @Post()
  async create(@Body() dto: CreateExpenseDto) {
    return this.expensesService.create(dto);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expensesService.update(id, dto);
  }

  @Roles('admin')
  @Post(':id/approve')
  async approve(@Param('id') id: string, @Req() req: { user: { name: string; username: string } }) {
    const approvedBy = req.user.name || req.user.username;
    return this.expensesService.approve(id, approvedBy);
  }

  @Roles('admin')
  @Post(':id/reject')
  async reject(@Param('id') id: string, @Req() req: { user: { name: string; username: string } }) {
    const approvedBy = req.user.name || req.user.username;
    return this.expensesService.reject(id, approvedBy);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: { user?: { role?: string } }) {
    const isAdmin = req.user?.role === 'admin';
    await this.expensesService.remove(id, isAdmin);
    return { message: 'تم حذف المصروف' };
  }
}
