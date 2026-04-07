import { Controller, Post, Body, Get, UseGuards, Req } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { Request } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(ThrottlerGuard)
  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getProfile(@Req() req: Request) {
    const user = req.user as Record<string, unknown>;
    return {
      id: user.userId,
      username: user.username,
      name: user.name,
      role: user.role,
      phone: user.phone || '',
      avatar: user.avatar || '',
      perms: user.perms || [],
    };
  }

  @Post('set-status')
  async setStatus(
    @Req() req: Request,
    @Body() body: { status: 'online' | 'offline'; userId?: string },
  ) {
    try {
      const user = req.user as Record<string, unknown> | undefined;
      const userId = body.userId || (user?.sub as string);
      if (!userId) {
        return { message: 'No userId provided' };
      }
      return this.authService.setUserStatus(userId, body.status);
    } catch (err) {
      return { message: 'Status updated', error: err.message };
    }
  }

  @Get('users-status')
  async getUsersStatus() {
    try {
      return this.authService.getUsersStatus();
    } catch (err) {
      return { online: {}, error: err.message };
    }
  }
}
