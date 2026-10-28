import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Post, Param, Query, Request, UseFilters, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsMongoId, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { ShopifySyncService } from './sync.service';
import { SyncApiError } from './sync-api.service';
import { SyncReview } from './sync-plan';

@Catch(SyncApiError, SyncReview)
class SyncExceptionFilter implements ExceptionFilter {
  catch(error: SyncApiError | SyncReview, host: ArgumentsHost) {
    const status = error instanceof SyncReview ? 409 : error.transient ? 503 : 400;
    host.switchToHttp().getResponse().status(status).json({ statusCode: status, message: error.message });
  }
}

class ConfigDto {
  @IsBoolean() enabled!: boolean;
  @IsBoolean() includePayments!: boolean;
}
class PreviewDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsMongoId({ each: true }) transactionIds!: string[];
  @IsBoolean() includePayments!: boolean;
}
class ExecuteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsUUID('4', { each: true }) tokens!: string[];
}
class ListDto {
  @IsOptional() @IsString() @MaxLength(80) ref?: string;
  @IsOptional() @IsMongoId() cursor?: string;
  @IsOptional() @IsIn(['pending', 'running', 'error', 'review', 'synced', 'metadata_only', 'paused']) state?: string;
}

@Controller('shopify/sync')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(new SyncExceptionFilter())
@Roles('admin')
export class ShopifySyncController {
  constructor(private readonly sync: ShopifySyncService) {}
  @Get('status') status() { return this.sync.status(); }
  @Get('orders') list(@Query() q: ListDto) { return this.sync.list(q.ref, q.cursor, q.state); }
  @Get('orders/:id') order(@Param('id') id: string) { return this.sync.orderStatus(id); }
  @Post('config') configure(@Body() b: ConfigDto, @Request() req: any) {
    return this.sync.configure(b.enabled, b.includePayments, String(req.user.userId));
  }
  @Post('preview') preview(@Body() b: PreviewDto, @Request() req: any) {
    return this.sync.preview(b.transactionIds, b.includePayments, String(req.user.userId));
  }
  @Post('execute') execute(@Body() b: ExecuteDto, @Request() req: any) {
    return this.sync.execute(b.tokens, String(req.user.userId));
  }
  @Post('jobs/:id/retry') retry(@Param('id') id: string, @Request() req: any) {
    return this.sync.retry(id, String(req.user.userId));
  }
}
