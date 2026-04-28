import { Controller, Post, Body, Get, UseGuards, Req } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PresenceGateway } from './presence.gateway';
import { Request } from 'express';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly presenceGateway: PresenceGateway,
    private readonly usersService: UsersService,
  ) {}

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

  @UseGuards(JwtAuthGuard)
  @Post('update-last-seen')
  async updateLastSeen(@Req() req: Request) {
    try {
      const user = req.user as Record<string, unknown> | undefined;
      const userId = user?.sub as string;
      if (!userId) {
        return { success: false, message: 'No userId' };
      }
      await this.usersService.updateLastSeen(userId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('active-sessions')
  getActiveSessions(@Req() req: Request) {
    const user = req.user as Record<string, unknown> | undefined;
    if (!user || user.role !== 'admin') {
      return { sessions: [], error: 'forbidden' };
    }
    return { sessions: this.presenceGateway.getActiveSessions() };
  }

  @Get('users-status')
  async getUsersStatus() {
    try {
      const onlineIds = this.presenceGateway.getOnlineUserIds();
      const allUsers = await this.usersService.findAll();
      const usersWithStatus = allUsers.map(u => ({
        id: u._id.toString(),
        username: u.username,
        name: u.name,
        isOnline: onlineIds.includes(u._id.toString()),
        lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
      }));
      return { users: usersWithStatus };
    } catch (err) {
      return { users: [], error: err.message };
    }
  }
}
