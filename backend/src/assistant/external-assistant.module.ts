import { Body, Controller, Get, Module, Post, Query, Req, UseGuards, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { ExternalAssistantService } from './external-assistant.service';

/**
 * The SOULIA chat's side of the external assistant: send a question (target = external) and read
 * the asker's own external messages. Same permission as the chat itself.
 * The external assistant answers through POST /api/v1/assistant/replies (public-api module).
 */
@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('assistant/external')
export class ExternalAssistantController {
  constructor(private readonly service: ExternalAssistantService) {}

  @Post()
  @RequirePerms('assistant')
  ask(@Req() req: any, @Body() body: any) {
    return this.service.ask(req.user, body || {});
  }

  @Get()
  @RequirePerms('assistant')
  mine(@Req() req: any, @Query() q: any) {
    return this.service.listMine(req.user, q || {});
  }
}

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [ExternalAssistantController],
  providers: [ExternalAssistantService],
  exports: [ExternalAssistantService],
})
export class ExternalAssistantModule {}
