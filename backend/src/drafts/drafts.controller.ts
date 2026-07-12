import {
  Controller, Get, Post, Delete,
  Body, Param, Req, UseGuards,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { DraftsService } from './drafts.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

type AuthReq = { user: { name?: string; username?: string; role?: string } };

@UseGuards(JwtAuthGuard)
@Controller('drafts')
export class DraftsController {
  constructor(private readonly draftsService: DraftsService) {}

  @Get()
  async findAll() {
    return this.draftsService.findAll();
  }

  @Post()
  async upsert(
    @Body() body: { draftId: string; snap: Record<string, any>; now: number; isNew?: boolean },
    @Req() req: AuthReq,
  ) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    const byUsername = req.user?.username || '';
    return this.draftsService.upsert(
      body.draftId,
      body.snap,
      by,
      byUsername,
      body.now || Date.now(),
      body.isNew ?? false,
    );
  }

  @Post(':draftId/lock')
  async acquireLock(@Param('draftId') draftId: string, @Req() req: AuthReq) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    const byUsername = req.user?.username || '';
    const result = await this.draftsService.acquireLock(draftId, by, byUsername);
    if (!result.ok) {
      throw new HttpException(
        { message: `هذه المسودة قيد التعديل بواسطة ${result.lockedBy}`, lockedBy: result.lockedBy },
        HttpStatus.CONFLICT,
      );
    }
    return { ok: true };
  }

  @Post(':draftId/unlock')
  async releaseLock(@Param('draftId') draftId: string, @Req() req: AuthReq) {
    const byUsername = req.user?.username || '';
    const isAdmin = req.user?.role === 'admin';
    await this.draftsService.releaseLock(draftId, byUsername, isAdmin);
    return { ok: true };
  }

  @Delete('all')
  async deleteAll() {
    await this.draftsService.deleteAll();
    return { ok: true };
  }

  @Delete(':draftId')
  async delete(@Param('draftId') draftId: string, @Req() req: AuthReq) {
    const callerUsername = req.user?.username || '';
    const isAdmin = req.user?.role === 'admin';
    await this.draftsService.delete(draftId, callerUsername, isAdmin);
    return { ok: true };
  }
}
