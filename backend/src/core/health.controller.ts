import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    if (this.connection.readyState !== 1 || !this.connection.db) {
      throw new ServiceUnavailableException('Service is not ready');
    }
    try {
      await this.connection.db.command({ ping: 1 }, { timeoutMS: 2000 });
    } catch {
      throw new ServiceUnavailableException('Service is not ready');
    }
    return { status: 'ok' };
  }
}
