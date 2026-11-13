import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { AccessRolesService, RoleInput } from './access-roles.service';

type Req = { user?: { userId?: string; sub?: string; username?: string } };
const actorId = (req: Req) => String(req.user?.userId || req.user?.sub || '');

/**
 * Roles are the ONLY place access is granted (Nov 13, 2026): an account gets its permissions
 * by being assigned a role, never by a per-user list. Every administrator manages roles; the
 * owner account itself stays protected in the service, and nobody can change their own role.
 */
@Controller('roles')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AccessRolesController {
  constructor(private readonly service: AccessRolesService) {}

  @Get()
  async list() {
    const [roles, unassigned] = await Promise.all([this.service.list(), this.service.unassigned()]);
    return { roles, unassigned, canManage: true };
  }

  @Post()
  create(@Body() input: RoleInput) { return this.service.create(input); }

  /** Moves accounts that still hold their own permission list onto roles. Dry run unless
   *  `{dryRun:false}` is sent. Declared before `:id` routes. */
  @Post('migrate-legacy')
  migrateLegacy(@Body() body: { dryRun?: boolean }) { return this.service.migrateLegacy(body?.dryRun !== false); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() input: RoleInput) { return this.service.update(id, input); }

  @Delete(':id')
  delete(@Param('id') id: string) { return this.service.delete(id); }

  @Post(':id/assign')
  assign(@Req() req: Req, @Param('id') id: string, @Body() body: { userId: string }) { return this.service.assign(id, body?.userId, actorId(req)); }

  @Post(':id/unassign')
  unassign(@Req() req: Req, @Param('id') id: string, @Body() body: { userId: string }) { return this.service.unassign(id, body?.userId, actorId(req)); }
}
