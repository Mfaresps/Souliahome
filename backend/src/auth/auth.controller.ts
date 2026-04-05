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
}
