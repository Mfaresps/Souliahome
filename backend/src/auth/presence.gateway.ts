import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
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
  private bannerWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    @InjectConnection() private readonly connection: Connection,
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

      if (!user || user.isActive === false || !client.connected) {
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
      client.on('banner:publish', (cfg: unknown, ack?: (result: { ok: boolean }) => void) => {
        const sender = this.connectedUsers.get(client.id);
        if (!sender || sender.role !== 'admin' || !cfg || typeof cfg !== 'object' || typeof (cfg as any).enabled !== 'boolean') {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        // Serialize saves so a rapid disable cannot be overtaken by an older publish.
        this.bannerWrites = this.bannerWrites.then(async () => {
          await this.connection.collection<{ _id: string; config: object }>('bannerconfig').updateOne(
            { _id: 'current' }, { $set: { config: cfg } }, { upsert: true },
          );
          this.server.emit('banner:changed', cfg);
          if (typeof ack === 'function') ack({ ok: true });
        }).catch(() => { if (typeof ack === 'function') ack({ ok: false }); });
      });

      // Always answer, including an unconfigured/disabled banner, to clear stale caches.
      const sendBanner = async () => {
        try {
          await this.bannerWrites;
          const saved = await this.connection.collection<{ _id: string; config: object }>('bannerconfig').findOne({ _id: 'current' });
          if (client.connected) client.emit('banner:changed', saved?.config || { enabled: false });
        } catch { if (client.connected) client.emit('banner:changed', { enabled: false }); }
      };
      client.on('banner:request', sendBanner);
      await sendBanner();
    } catch {
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const lockedTxId = this.editingLocks.get(client.id);
    if (lockedTxId) {
      this.editingLocks.delete(client.id);
      this.server.emit('tx:editing-done', { txId: lockedTxId });
    }
    const disconnected = this.connectedUsers.get(client.id);
    this.connectedUsers.delete(client.id);
    if (disconnected && !this.getOnlineUserIds().includes(disconnected.userId)) {
      await this.usersService.updateLastSeen(disconnected.userId).catch(() => {});
    }
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
    const allUsers = await this.usersService.findAll();
    // Read live sockets after the database await; a disconnect may have occurred meanwhile.
    const onlineIds = this.getOnlineUserIds();
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
