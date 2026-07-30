import { Controller, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { SettingsService } from './settings.service';

/** Unauthenticated endpoint hit by the local git post-commit hook to bump the system version on every deploy. */
@Controller('deploy')
export class DeployController {
  constructor(private readonly settingsService: SettingsService) {}

  @Post('bump-version')
  async bumpVersion(@Headers('x-deploy-secret') secret: string) {
    if (!secret || secret !== process.env.DEPLOY_HOOK_SECRET) {
      throw new UnauthorizedException('رمز النشر غير صحيح');
    }
    const settings = await this.settingsService.bumpVersion();
    return { success: true, systemVersion: settings.systemVersion };
  }
}
