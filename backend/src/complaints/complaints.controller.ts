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
import { CreateComplaintDto, ResolveComplaintDto, SurveyResponseDto } from './dto/complaint.dto';
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
}
