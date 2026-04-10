import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

interface ConnectedUser {
  userId: string;
  username: string;
  name: string;
  socketId: string;
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

      this.connectedUsers.set(client.id, {
        userId: user._id.toString(),
        username: user.username,
        name: user.name,
        socketId: client.id,
      });

      this.broadcastOnlineUsers();
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

  private async broadcastOnlineUsers() {
    const onlineIds = this.getOnlineUserIds();
    // Get all users with their lastSeen data
    const allUsers = await this.usersService.findAll();
    const usersWithStatus = allUsers.map(u => ({
      id: u._id.toString(),
      username: u.username,
      name: u.name,
      isOnline: onlineIds.includes(u._id.toString()),
      lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
    }));
    this.server.emit('users:status', { users: usersWithStatus, onlineUserIds: onlineIds });
  }
}
