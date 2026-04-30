import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { FollowUpsService } from './followups.service';
import { CreateFollowUpDto, UpdateFollowUpDto } from './dto/followup.dto';
import { PresenceGateway } from '../auth/presence.gateway';

interface AuthRequest {
  user: { sub?: string; userId?: string; username?: string; name?: string };
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
}
