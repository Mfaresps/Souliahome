import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { IsEmail, MaxLength, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { ClientsService } from './clients.service';

export class ClientEmailDto {
  @ValidateIf((_object, value) => value !== '')
  @IsEmail()
  @MaxLength(254)
  email: string;
}
@Controller('clients')
@UseGuards(JwtAuthGuard, PermsGuard)
@RequirePerms('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}
  @Get()
  list() { return this.clients.list(); }
  @Get('profile')
  profile(@Query('key') key: string) { return this.clients.profile(String(key || '')); }
  @Get('order-profile')
  orderProfile(@Query('id') id: string, @Query('source') source?: string) { return this.clients.orderProfile(String(id || ''), source); }
  @Get('tickets')
  @RequirePerms('clients', 'complaints')
  tickets(@Query('key') key: string) { return this.clients.tickets(String(key || '')); }
  @Patch('email')
  updateEmail(@Query('key') key: string, @Body() body: ClientEmailDto, @Req() req: any) {
    return this.clients.updateEmail(String(key || ''), body.email.trim().toLowerCase(), String(req.user?.username || req.user?.userId || ''));
  }
}
