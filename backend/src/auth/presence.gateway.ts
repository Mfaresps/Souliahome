import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import {
  buildClientContext,
  extractIpFrom,
  GeoLocation,
} from '../shared/client-context.util';
import { fetchGeo } from '../shared/geo-lookup.util';

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
  location: GeoLocation | null;
  connectedAt: string;
  lastActivity: string;
}

// Latest published banner config — persists in-process so new connections receive it
let latestBannerCfg: unknown = null;

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

  // Map socketId -> txId being edited (for cleanup on disconnect)
  private editingLocks = new Map<string, string>();

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

      const ctx = buildClientContext(client.handshake);
      const ip = ctx.ipAddress || extractIpFrom({ address: client.handshake.address });
      const ua = ctx.userAgent;
      const parsed = { device: ctx.device, browser: ctx.browser, os: ctx.os };
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

      // Banner publish: admin emits banner:publish → server stores + rebroadcasts to all clients
      client.on('banner:publish', (cfg: unknown) => {
        const sender = this.connectedUsers.get(client.id);
        if (!sender || sender.role !== 'admin') return; // only admins may publish
        if (!cfg || typeof cfg !== 'object') return;
        latestBannerCfg = cfg;
        this.server.emit('banner:changed', cfg);
      });

      // Send current banner state to the newly connected client immediately
      if (latestBannerCfg) {
        client.emit('banner:changed', latestBannerCfg);
      }

      // Allow any authenticated client to request current banner state
      client.on('banner:request', () => {
        if (latestBannerCfg) {
          client.emit('banner:changed', latestBannerCfg);
        }
      });
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const lockedTxId = this.editingLocks.get(client.id);
    if (lockedTxId) {
      this.editingLocks.delete(client.id);
      this.server.emit('tx:editing-done', { txId: lockedTxId });
    }
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
    // Track which socket holds which tx edit lock for disconnect cleanup
    if (event === 'tx:editing' && payload && typeof payload === 'object' && 'txId' in payload) {
      const txId = String((payload as { txId: string }).txId);
      const userId = (payload as { userId?: string }).userId;
      for (const [socketId, u] of this.connectedUsers) {
        if (userId && u.userId === userId) {
          this.editingLocks.set(socketId, txId);
          break;
        }
      }
    }
    if (event === 'tx:editing-done' && payload && typeof payload === 'object' && 'txId' in payload) {
      const txId = String((payload as { txId: string }).txId);
      for (const [socketId, lockedId] of this.editingLocks) {
        if (lockedId === txId) this.editingLocks.delete(socketId);
      }
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
