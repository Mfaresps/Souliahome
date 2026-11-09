import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { AccessRolesService, RoleInput } from './access-roles.service';

@Controller('roles')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AccessRolesController {
  constructor(private readonly service: AccessRolesService) {}

  private requireOwner(req: { user?: { username?: string } }) {
    if (req.user?.username !== 'admin') throw new ForbiddenException('Only the Super Admin can manage roles and assignments');
  }

  @Get()
  async list(@Req() req: {user?: {username?: string}}) {
    return { roles: await this.service.list(), canManage: req.user?.username === 'admin' };
  }

  @Post()
  create(@Req() req: any, @Body() input: RoleInput) { this.requireOwner(req); return this.service.create(input); }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() input: RoleInput) { this.requireOwner(req); return this.service.update(id, input); }

  @Delete(':id')
  delete(@Req() req: any, @Param('id') id: string) { this.requireOwner(req); return this.service.delete(id); }

  @Post(':id/assign')
  assign(@Req() req: any, @Param('id') id: string, @Body() body: { userId:string }) { this.requireOwner(req); return this.service.assign(id, body.userId); }

  @Post(':id/unassign')
  unassign(@Req() req: any, @Param('id') id: string, @Body() body: { userId:string }) { this.requireOwner(req); return this.service.unassign(id, body.userId); }
}
