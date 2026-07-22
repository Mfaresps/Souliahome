import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { FollowUpsService } from './followups.service';
import { CreateFollowUpDto, UpdateFollowUpDto } from './dto/followup.dto';
import { PresenceGateway } from '../auth/presence.gateway';

interface AuthRequest {
  user: { sub?: string; userId?: string; username?: string; name?: string; role?: string };
}

@UseGuards(JwtAuthGuard)
@Controller('followups')
export class FollowUpsController {
  constructor(
    private readonly service: FollowUpsService,
    private readonly presence: PresenceGateway,
  ) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  async create(@Body() dto: CreateFollowUpDto, @Req() req: AuthRequest) {
    const doc = await this.service.create(dto);
    // Emit real-time update to all connected users
    try { this.presence.emitEvent('followup:changed', { action: 'create', id: String(doc._id) }); } catch (_) {}
    return doc;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateFollowUpDto, @Req() req: AuthRequest) {
    const doc = await this.service.update(id, dto);
    // If reason changed and responsible user exists, emit notification
    if (dto.reason && doc) {
      try {
        this.presence.emitToUser(String((doc as any).responsibleId), 'followup:notify', {
          id: String((doc as any)._id),
          orderRef: (doc as any).orderRef,
          reason: dto.reason,
          fromName: req.user?.name || req.user?.username || '',
        });
      } catch (_) {}
    }
    try { this.presence.emitEvent('followup:changed', { action: 'update', id }); } catch (_) {}
    return doc;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    try { this.presence.emitEvent('followup:changed', { action: 'delete', id }); } catch (_) {}
    return { ok: true };
  }

  @Post(':id/comments')
  async addComment(@Param('id') id: string, @Body() body: { text: string }, @Req() req: AuthRequest) {
    const authorId = String(req.user?.userId || req.user?.sub || '');
    const authorName = req.user?.name || req.user?.username || '';
    const text = String(body?.text || '').trim();
    if (!text) throw new ForbiddenException('نص التعليق مطلوب');
    const doc = await this.service.addComment(id, authorId, authorName, text);
    try { this.presence.emitEvent('followup:changed', { action: 'update', id }); } catch (_) {}
    return doc;
  }

  @Patch(':id/comments/:commentId')
  async editComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: { text: string },
    @Req() req: AuthRequest,
  ) {
    const authorId = String(req.user?.userId || req.user?.sub || '');
    const isAdmin = req.user?.role === 'admin';
    const text = String(body?.text || '').trim();
    if (!text) throw new ForbiddenException('نص التعليق مطلوب');
    try {
      const doc = await this.service.editComment(id, commentId, authorId, text, isAdmin);
      try { this.presence.emitEvent('followup:changed', { action: 'update', id }); } catch (_) {}
      return doc;
    } catch (e: any) {
      if (e.message === 'FORBIDDEN') throw new ForbiddenException('لا يمكنك تعديل تعليق شخص آخر');
      throw e;
    }
  }

  @Delete(':id/comments/:commentId')
  async deleteComment(@Param('id') id: string, @Param('commentId') commentId: string, @Req() req: AuthRequest) {
    const authorId = String(req.user?.userId || req.user?.sub || '');
    const isAdmin = req.user?.role === 'admin';
    try {
      const doc = await this.service.deleteComment(id, commentId, authorId, isAdmin);
      try { this.presence.emitEvent('followup:changed', { action: 'update', id }); } catch (_) {}
      return doc;
    } catch (e: any) {
      if (e.message === 'FORBIDDEN') throw new ForbiddenException('لا يمكنك حذف تعليق شخص آخر');
      throw e;
    }
  }
}
