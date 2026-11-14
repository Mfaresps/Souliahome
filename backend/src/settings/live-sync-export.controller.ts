import { Controller, Get, Headers, Logger, NotFoundException, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { LIVE_SYNC_HEADER, exportEnabled, syncTokenMatches } from './live-sync.util';

/**
 * GET /api/settings/sync-export — the live server's half of «مزامنة من النسخة الحية».
 *
 * ⚠ No JWT on purpose: the local copy has no live login (admins need 2FA). It is protected by
 * LIVE_SYNC_EXPORT_TOKEN instead, and answers 404 when that is not set, so on a server
 * without the key the route does not exist. The reply is the same document a backup file
 * holds (secrets already stripped by backupConfiguration) — but it still holds every
 * account and order, so the key must be long, random and kept only in the two .env files.
 */
@Controller('settings')
export class LiveSyncExportController {
  private readonly logger = new Logger('LiveSyncExport');

  constructor(private readonly settingsService: SettingsService) {}

  @UseGuards(ThrottlerGuard)
  @Get('sync-export')
  async export(@Headers(LIVE_SYNC_HEADER) token: string, @Req() req: any, @Res() res: any) {
    if (!exportEnabled(process.env)) throw new NotFoundException();
    const ip = req.headers?.['x-real-ip'] || req.ip || '';
    if (!syncTokenMatches(String(process.env.LIVE_SYNC_EXPORT_TOKEN).trim(), token)) {
      this.logger.warn(`Refused sync export (bad key) from ${ip}`);
      throw new UnauthorizedException();
    }
    const startedAt = Date.now();
    const body = JSON.stringify(await this.settingsService.buildBackupData());
    this.logger.log(`Sync export sent to ${ip}: ${(body.length / 1048576).toFixed(1)} MB in ${Date.now() - startedAt} ms`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}
