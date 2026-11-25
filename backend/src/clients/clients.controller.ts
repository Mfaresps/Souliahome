import { Body, BadRequestException, Controller, ForbiddenException, Get, Optional, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { IsEmail, MaxLength, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { ClientsService } from './clients.service';
import { BrowseAccessService, MIN_SEARCH_CHARS, maskRowPhones } from '../browse-access/browse-access.service';

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
  constructor(private readonly clients: ClientsService, @Optional() private readonly browseAccess?: BrowseAccessService) {}
  @Get()
  async list(@Query('page') rawPage: string, @Query('q') query: string, @Req() req: any) {
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('Invalid client page');
    // Customer privacy (Nov 25, 2026): browsing past the first page — with or without a search, or a
    // one-letter search would list everyone — needs «تصفح قائمة العملاء كاملة» (`clients-browse`).
    // Whoever may browse also gets the total, i.e. full pagination.
    const canBrowse = this.browseAccess
      ? await this.browseAccess.canBrowse(req.user, 'clients')
      : req.user?.role === 'admin' || (req.user?.perms || []).includes('clients-browse');
    if (!canBrowse && page > 1) {
      throw new ForbiddenException({ message: 'حفاظًا على خصوصية العملاء، لا يمكنك تصفّح صفحات القائمة الأخرى. للوصول إلى عميل محدد، ابحث باسمه أو رقم هاتفه.', code: 'CLIENTS_PRIVATE' });
    }
    let q = String(query || '').trim().slice(0, 100);
    if (!canBrowse && q && q.length < MIN_SEARCH_CHARS) q = '';
    const result: any = await this.clients.list(page, canBrowse, q);
    return result && Array.isArray(result.rows) ? { ...result, rows: maskRowPhones(result.rows, req.user) } : result;
  }
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
