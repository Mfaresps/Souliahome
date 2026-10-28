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
  UseGuards,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ComplaintsService } from './complaints.service';
import {
  CreateComplaintDto,
  UpdateComplaintDto,
  ResolveComplaintDto,
  SurveyResponseDto,
  UpdateProgressStageDto,
  CreateNoteDto,
  UpdateNoteDto,
  ComplaintWorkflowDto,
} from './dto/complaint.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { ComplaintsAccessGuard } from './complaints-access.guard';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  /* Public survey endpoint — no auth */
  @Get('survey/:token')
  async getSurvey(@Param('token') token: string) {
    return this.complaintsService.publicSurvey(token);
  }

  @Post('survey/:token')
  async submitSurvey(
    @Param('token') token: string,
    @Body() dto: SurveyResponseDto,
  ) {
    return this.complaintsService.submitSurvey(token, dto);
  }

  /* Protected endpoints */
  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Get('message-templates')
  messageTemplates() { return this.complaintsService.messageTemplates(); }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Roles('admin')
  @Put('message-templates')
  saveMessageTemplates(@Body() body: any, @Req() req: any) {
    return this.complaintsService.saveMessageTemplates(body, req.user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Get(':id/customer-message')
  customerMessage(@Param('id') id: string, @Query('lang') lang: string, @Query('event') event: string) {
    return this.complaintsService.customerMessage(id, lang, event);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Post(':id/evidence')
  @UseInterceptors(FileInterceptor('file', { limits:{fileSize:5*1024*1024,files:1,fields:0} }))
  uploadEvidence(@Param('id') id: string, @UploadedFile() file: any, @Req() req: any) {
    return this.complaintsService.uploadEvidence(id,file,req.user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Get(':id/evidence/:attachmentId')
  evidence(@Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return this.complaintsService.evidenceImage(id,attachmentId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Delete(':id/evidence/:attachmentId')
  removeEvidence(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() req: any) {
    return this.complaintsService.removeEvidence(id,attachmentId,req.user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Post(':id/workflow')
  workflow(@Param('id') id: string, @Body() dto: ComplaintWorkflowDto, @Req() req: any) {
    return this.complaintsService.workflow(id, dto, req.user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Get()
  async findAll() {
    return this.complaintsService.findAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Query('view') view?: string, @Query('lang') lang?: string, @Query('event') event?: string) {
    return view === 'workspace' ? this.complaintsService.workspace(id, lang || 'ar', event) : this.complaintsService.detail(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Post()
  async create(
    @Body() dto: CreateComplaintDto,
    @Req() req: { user: { name: string; username: string; userId: string } },
  ) {
    const submittedBy = req.user.name || req.user.username;
    const submittedById = req.user.userId;
    return this.complaintsService.create(dto, submittedBy, submittedById);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Roles('admin')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateComplaintDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const author = req.user.name || req.user.username;
    return this.complaintsService.update(id, dto, author);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Roles('admin')
  @Post(':id/resolve')
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveComplaintDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const resolvedBy = req.user.name || req.user.username;
    return this.complaintsService.resolve(id, dto, resolvedBy);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Roles('admin')
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.complaintsService.remove(id,req.user);
    return { message: 'تم حذف الشكوى' };
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Post(':id/progress-stage')
  async updateProgressStage(
    @Param('id') id: string,
    @Body() dto: UpdateProgressStageDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const author = req.user.name || req.user.username;
    return this.complaintsService.updateProgressStage(
      id,
      dto.progressStage,
      author,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Post(':id/notes')
  async addNote(
    @Param('id') id: string,
    @Body() dto: CreateNoteDto,
    @Req() req: { user: { name: string; username: string; userId: string } },
  ) {
    const author = req.user.name || req.user.username;
    return this.complaintsService.addNote(id, dto, author, req.user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Post(':id/notes/:noteId')
  async updateNote(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Body() dto: UpdateNoteDto,
    @Req() req: { user: { userId: string; role: string } },
  ) {
    return this.complaintsService.updateNote(
      id,
      noteId,
      dto,
      req.user.userId,
      req.user.role === 'admin',
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard, ComplaintsAccessGuard)
  @Delete(':id/notes/:noteId')
  async removeNote(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Req() req: { user: { userId: string; role: string } },
  ) {
    return this.complaintsService.removeNote(
      id,
      noteId,
      req.user.userId,
      req.user.role === 'admin',
    );
  }
}
