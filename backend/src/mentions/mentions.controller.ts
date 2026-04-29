import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { MentionsService } from './mentions.service';
import { PresenceGateway } from '../auth/presence.gateway';

interface MentionPayload {
  targetUserId: string;
  targetUsername?: string;
  targetName?: string;
  txId: string;
  txRef?: string;
  commentId?: number;
  commentText: string;
}

interface AuthRequest {
  user: { sub?: string; userId?: string; username?: string; name?: string };
}

@UseGuards(JwtAuthGuard)
@Controller('mentions')
export class MentionsController {
  constructor(
    private readonly mentionsService: MentionsService,
    private readonly presence: PresenceGateway,
  ) {}

  @Post()
  async create(@Body() body: { mentions: MentionPayload[] }, @Req() req: AuthRequest) {
    const fromUserId = String(req.user?.userId || req.user?.sub || '');
    const fromUsername = String(req.user?.username || '').toLowerCase();
    const fromName = String(req.user?.name || req.user?.username || '');
    // Drop self-mentions and de-duplicate by targetUserId
    const seen = new Set<string>();
    const rows = (body.mentions || [])
      .filter(m => {
        const tid = String(m.targetUserId || '');
        const tuname = String(m.targetUsername || '').toLowerCase();
        if (!tid || !m.txId || !m.commentText) return false;
        if (tid === fromUserId) return false;
        if (tuname && tuname === fromUsername) return false;
        if (seen.has(tid)) return false;
        seen.add(tid);
        return true;
      })
      .map(m => ({
        targetUserId: String(m.targetUserId),
        targetUsername: String(m.targetUsername || '').toLowerCase(),
        targetName: m.targetName || '',
        fromUserId,
        fromName,
        txId: String(m.txId),
        txRef: String(m.txRef || ''),
        commentId: Number(m.commentId || 0),
        commentText: String(m.commentText || ''),
        read: false,
      }));
    const created = await this.mentionsService.createMany(rows);
    // Emit a real-time event to each target user (best-effort)
    created.forEach((m: any) => {
      const payload = {
        id: String(m._id),
        _id: String(m._id),
        targetUserId: m.targetUserId,
        targetUsername: m.targetUsername,
        targetName: m.targetName,
        fromUserId: m.fromUserId,
        fromName: m.fromName,
        txId: m.txId,
        txRef: m.txRef,
        commentId: m.commentId,
        commentText: m.commentText,
        read: false,
        ts: (m.createdAt instanceof Date) ? m.createdAt.toISOString() : new Date().toISOString(),
      };
      try { this.presence.emitToUser(String(m.targetUserId), 'mention:new', payload); } catch(_) {}
    });
    return { count: created.length };
  }

  @Get()
  async list(@Req() req: AuthRequest) {
    const userId = String(req.user?.userId || req.user?.sub || '');
    const username = String(req.user?.username || '');
    const docs = await this.mentionsService.findForUser(userId, username);
    return docs.map((m: any) => ({
      id: String(m._id),
      _id: String(m._id),
      targetUserId: m.targetUserId,
      targetUsername: m.targetUsername,
      targetName: m.targetName,
      fromUserId: m.fromUserId,
      fromName: m.fromName,
      txId: m.txId,
      txRef: m.txRef,
      commentId: m.commentId,
      commentText: m.commentText,
      read: m.read,
      ts: (m.createdAt instanceof Date) ? m.createdAt.toISOString() : new Date(m.createdAt).toISOString(),
    }));
  }

  @Post(':id/read')
  async markRead(@Param('id') id: string) {
    await this.mentionsService.markRead(id);
    return { ok: true };
  }

  @Post('read-all')
  async readAll(@Req() req: AuthRequest) {
    const userId = String(req.user?.userId || req.user?.sub || '');
    const username = String(req.user?.username || '');
    await this.mentionsService.markAllRead(userId, username);
    return { ok: true };
  }

  @Delete()
  async clear(@Req() req: AuthRequest) {
    const userId = String(req.user?.userId || req.user?.sub || '');
    const username = String(req.user?.username || '');
    await this.mentionsService.clearForUser(userId, username);
    return { ok: true };
  }
}
