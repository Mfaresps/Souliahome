import {
  Controller, Get, Post, Delete,
  Body, Param, Req, UseGuards,
  HttpException, HttpStatus, ForbiddenException,
} from '@nestjs/common';
import { DraftsService } from './drafts.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

type AuthReq = { user: { name?: string; username?: string; role?: string; perms?: string[] } };

/* Manufacturing spec sheets («نماذج التصنيع») share this endpoint with transaction drafts,
   told apart by the `spec:` id prefix (index.html SPEC_DRAFT_PREFIX). They carry the supplier
   and the design, so they have their own permissions (Nov 25, 2026):
   products-specs-view = see/print · products-specs-manage = create/edit/delete. */
const SPEC_PREFIX = 'spec:';
const isSpec = (id: unknown) => String(id || '').startsWith(SPEC_PREFIX);
function canViewSpecs(u: AuthReq['user']): boolean {
  if (u?.role === 'admin') return true;
  const p = u?.perms || [];
  return p.includes('products-specs-view') || p.includes('products-specs-manage');
}
function canManageSpecs(u: AuthReq['user']): boolean {
  return u?.role === 'admin' || (u?.perms || []).includes('products-specs-manage');
}
function assertSpecWrite(draftId: unknown, u: AuthReq['user']) {
  if (isSpec(draftId) && !canManageSpecs(u)) throw new ForbiddenException('ليست لديك صلاحية على نماذج التصنيع');
}

@UseGuards(JwtAuthGuard)
@Controller('drafts')
export class DraftsController {
  constructor(private readonly draftsService: DraftsService) {}

  @Get()
  async findAll(@Req() req: AuthReq) {
    const all = await this.draftsService.findAll();
    return canViewSpecs(req.user) ? all : all.filter((d: any) => !isSpec(d?.draftId));
  }

  @Post()
  async upsert(
    @Body() body: { draftId: string; snap: Record<string, any>; now: number; isNew?: boolean },
    @Req() req: AuthReq,
  ) {
    assertSpecWrite(body?.draftId, req.user);
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
    assertSpecWrite(draftId, req.user);
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
  async deleteAll(@Req() req: AuthReq) {
    // Without the spec permission only transaction drafts are cleared.
    await this.draftsService.deleteAll(!canManageSpecs(req.user));
    return { ok: true };
  }

  @Delete(':draftId')
  async delete(@Param('draftId') draftId: string, @Req() req: AuthReq) {
    assertSpecWrite(draftId, req.user);
    const callerUsername = req.user?.username || '';
    const isAdmin = req.user?.role === 'admin';
    await this.draftsService.delete(draftId, callerUsername, isAdmin);
    return { ok: true };
  }
}
