import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ComplaintsService } from './complaints.service';
import {
  CreateComplaintDto,
  ResolveComplaintDto,
  SurveyResponseDto,
  UpdateProgressStageDto,
  CreateNoteDto,
  UpdateNoteDto,
} from './dto/complaint.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  /* Public survey endpoint — no auth */
  @Get('survey/:token')
  async getSurvey(@Param('token') token: string) {
    return this.complaintsService.findBySurveyToken(token);
  }

  @Post('survey/:token')
  async submitSurvey(
    @Param('token') token: string,
    @Body() dto: SurveyResponseDto,
  ) {
    return this.complaintsService.submitSurvey(token, dto);
  }

  /* Protected endpoints */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get()
  async findAll() {
    return this.complaintsService.findAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.complaintsService.findById(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post()
  async create(
    @Body() dto: CreateComplaintDto,
    @Req() req: { user: { name: string; username: string; userId: string } },
  ) {
    const submittedBy = req.user.name || req.user.username;
    const submittedById = req.user.userId;
    return this.complaintsService.create(dto, submittedBy, submittedById);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.complaintsService.remove(id);
    return { message: 'تم حذف الشكوى' };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(':id/notes')
  async addNote(
    @Param('id') id: string,
    @Body() dto: CreateNoteDto,
    @Req() req: { user: { name: string; username: string; userId: string } },
  ) {
    const author = req.user.name || req.user.username;
    return this.complaintsService.addNote(id, dto, author, req.user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
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
