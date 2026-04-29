import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as http from 'http';

interface ConnectedUser {
  userId: string;
  username: string;
  name: string;
  role: string;
  socketId: string;
  ip: string;
  userAgent: string;
  device: string;
  browser: string;
  os: string;
  location: { city: string; region: string; country: string; lat?: number; lon?: number; isp?: string } | null;
  connectedAt: string;
  lastActivity: string;
}

const geoCache = new Map<string, ConnectedUser['location']>();

function fetchGeo(ip: string): Promise<ConnectedUser['location']> {
  return new Promise((resolve) => {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      resolve({ city: 'محلي', region: '', country: 'شبكة داخلية' });
      return;
    }
    if (geoCache.has(ip)) {
      resolve(geoCache.get(ip) || null);
      return;
    }
    const url = `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,isp&lang=ar`;
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'success') {
            const loc = { city: j.city || '', region: j.regionName || '', country: j.country || '', lat: j.lat, lon: j.lon, isp: j.isp || '' };
            geoCache.set(ip, loc);
            resolve(loc);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function parseUA(ua: string): { device: string; browser: string; os: string } {
  const u = ua || '';
  let device = 'كمبيوتر';
  if (/Mobile|Android|iPhone/i.test(u)) device = 'موبايل';
  else if (/iPad|Tablet/i.test(u)) device = 'تابلت';
  let browser = 'متصفح';
  if (/Edg\//i.test(u)) browser = 'Edge';
  else if (/Chrome\//i.test(u)) browser = 'Chrome';
  else if (/Firefox\//i.test(u)) browser = 'Firefox';
  else if (/Safari\//i.test(u)) browser = 'Safari';
  let os = '';
  if (/Windows/i.test(u)) os = 'Windows';
  else if (/Android/i.test(u)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(u)) os = 'iOS';
  else if (/Mac OS/i.test(u)) os = 'macOS';
  else if (/Linux/i.test(u)) os = 'Linux';
  return { device, browser, os };
}

function extractIp(client: Socket): string {
  const xff = (client.handshake.headers['x-forwarded-for'] as string) || '';
  if (xff) return xff.split(',')[0].trim();
  const real = client.handshake.headers['x-real-ip'] as string;
  if (real) return real;
  const addr = client.handshake.address || '';
  return addr.replace(/^::ffff:/, '');
}

@WebSocketGateway({
  cors: { origin: true },
  namespace: '/',
})
export class PresenceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  // Map socketId -> user info
  private connectedUsers = new Map<string, ConnectedUser>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.query?.token as string);

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      const user = await this.usersService.findById(payload.sub);

      if (!user) {
        client.disconnect();
        return;
      }

      const ip = extractIp(client);
      const ua = (client.handshake.headers['user-agent'] as string) || '';
      const parsed = parseUA(ua);
      const now = new Date().toISOString();

      const entry: ConnectedUser = {
        userId: user._id.toString(),
        username: user.username,
        name: user.name,
        role: user.role,
        socketId: client.id,
        ip,
        userAgent: ua,
        device: parsed.device,
        browser: parsed.browser,
        os: parsed.os,
        location: null,
        connectedAt: now,
        lastActivity: now,
      };
      this.connectedUsers.set(client.id, entry);
      this.broadcastOnlineUsers();

      // Resolve geo asynchronously, then update
      fetchGeo(ip).then((loc) => {
        const cur = this.connectedUsers.get(client.id);
        if (cur) {
          cur.location = loc;
          this.broadcastOnlineUsers();
        }
      });

      client.on('activity', () => {
        const cur = this.connectedUsers.get(client.id);
        if (cur) cur.lastActivity = new Date().toISOString();
      });
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.connectedUsers.delete(client.id);
    this.broadcastOnlineUsers();
  }

  getOnlineUserIds(): string[] {
    const ids = new Set<string>();
    for (const u of this.connectedUsers.values()) {
      ids.add(u.userId);
    }
    return [...ids];
  }

  /** Detailed sessions list — admin-only consumer should filter on client side */
  getActiveSessions() {
    return [...this.connectedUsers.values()].map((u) => ({
      userId: u.userId,
      username: u.username,
      name: u.name,
      role: u.role,
      socketId: u.socketId,
      ip: u.ip,
      device: u.device,
      browser: u.browser,
      os: u.os,
      location: u.location,
      connectedAt: u.connectedAt,
      lastActivity: u.lastActivity,
    }));
  }

  /** Generic broadcaster used by services to push real-time events */
  emitEvent(event: string, payload: unknown) {
    if (this.server) {
      this.server.emit(event, payload);
    }
  }

  /** Emit an event only to sockets belonging to the given userId */
  emitToUser(userId: string, event: string, payload: unknown): boolean {
    if (!this.server || !userId) return false;
    let delivered = false;
    for (const u of this.connectedUsers.values()) {
      if (u.userId === String(userId)) {
        this.server.to(u.socketId).emit(event, payload);
        delivered = true;
      }
    }
    return delivered;
  }

  private async broadcastOnlineUsers() {
    const onlineIds = this.getOnlineUserIds();
    const allUsers = await this.usersService.findAll();
    const usersWithStatus = allUsers.map((u) => ({
      id: u._id.toString(),
      username: u.username,
      name: u.name,
      isOnline: onlineIds.includes(u._id.toString()),
      lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
    }));
    this.server.emit('users:status', {
      users: usersWithStatus,
      onlineUserIds: onlineIds,
      sessions: this.getActiveSessions(),
    });
  }
}
