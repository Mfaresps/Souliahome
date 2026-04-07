import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';

// In-memory user status tracker
const usersStatus: Record<string, { status: 'online' | 'offline'; lastSeen: Date }> = {};

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    username: string;
    name: string;
    role: string;
    phone: string;
    avatar: string;
    perms: string[];
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const user = await this.usersService.findByUsername(loginDto.username);
    if (!user) {
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غلط');
    }
    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غلط');
    }
    if (user.isActive === false) {
      throw new UnauthorizedException('هذا الحساب معطل، تواصل مع المدير');
    }
    await this.usersService.updateLastLogin(user._id.toString());
    const payload = { sub: user._id.toString(), username: user.username };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user._id.toString(),
        username: user.username,
        name: user.name,
        role: user.role,
        phone: user.phone || '',
        avatar: user.avatar || '',
        perms: user.perms || [],
      },
    };
  }

  async setUserStatus(
    userId: string,
    status: 'online' | 'offline',
  ): Promise<{ message: string }> {
    usersStatus[userId] = {
      status,
      lastSeen: new Date(),
    };
    return { message: `تم تحديث الحالة إلى ${status === 'online' ? 'متصل' : 'غير متصل'}` };
  }

  async getUsersStatus(): Promise<{
    online: Record<string, { status: string; lastSeen: string }>;
  }> {
    const online: Record<string, { status: string; lastSeen: string }> = {};
    for (const [userId, status] of Object.entries(usersStatus)) {
      online[userId] = {
        status: status.status,
        lastSeen: status.lastSeen.toISOString(),
      };
    }
    return { online };
  }
}
