import * as net from 'net';
import { Client } from './Client';
import { PacketRouter } from '../network/packetRouter';
import { Config } from './config';
import { GlobalState } from './GlobalState';

export class GameServer {
    private server: net.Server;
    private port: number;
    private host: string;
    private router: PacketRouter;
    private readonly sockets = new Set<net.Socket>();
    private readonly connectionsByAddress = new Map<string, number>();
    private stopPromise: Promise<void> | null = null;

    constructor(port: number = 8080, router: PacketRouter, host: string = Config.BIND_HOST) {
        this.port = port;
        this.router = router;
        this.host = host;
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.on('error', (error) => {
            const socketError = error as NodeJS.ErrnoException;
            if (socketError.code === 'EADDRINUSE') {
                console.error(
                    `[GameServer] Cannot listen on ${this.host}:${this.port} because the port is already in use.`
                );
                console.error('[GameServer] Stop the previous dev server or change GAME_PORT before restarting.');
                process.exitCode = 1;
                setImmediate(() => process.exit(1));
                return;
            }

            console.error('[GameServer] Server error:', error);
        });
    }

    public start(): void {
        this.server.listen(this.port, this.host, () => {
            console.log(`[GameServer] Listening on ${this.host}:${this.port}`);
        });
    }

    public stop(): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }

        this.stopPromise = new Promise((resolve) => {
            let settled = false;
            const finish = (): void => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const deadline = setTimeout(() => {
                for (const socket of this.sockets) socket.destroy();
                finish();
            }, Config.SHUTDOWN_GRACE_MS);
            deadline.unref?.();

            if (!this.server.listening) {
                clearTimeout(deadline);
                for (const socket of this.sockets) socket.destroy();
                finish();
                return;
            }

            this.server.close((error) => {
                if (error) {
                    console.error('[GameServer] Stop error:', error);
                }
                clearTimeout(deadline);
                finish();
            });
        });
        return this.stopPromise;
    }

    private handleConnection(socket: net.Socket): void {
        const remoteAddress = GlobalState.normalizeRemoteAddress(socket.remoteAddress) || 'unknown';
        const addressConnections = this.connectionsByAddress.get(remoteAddress) ?? 0;
        if (
            this.sockets.size >= Config.MAX_GAME_CONNECTIONS ||
            addressConnections >= Config.MAX_GAME_CONNECTIONS_PER_IP
        ) {
            console.warn(
                `[GameServer] Refused connection address=${remoteAddress} ` +
                `active=${this.sockets.size} addressActive=${addressConnections}`
            );
            socket.destroy();
            return;
        }

        this.sockets.add(socket);
        this.connectionsByAddress.set(remoteAddress, addressConnections + 1);
        socket.setNoDelay(true);
        socket.setKeepAlive(true);
        socket.setTimeout(Config.GAME_SOCKET_IDLE_TIMEOUT_MS, () => {
            console.warn(`[GameServer] Closing idle connection address=${remoteAddress}`);
            socket.destroy();
        });
        const client = new Client(socket, this.router);
        const authDeadline = setTimeout(() => {
            if (!client.authenticated && !socket.destroyed) {
                console.warn(`[GameServer] Closing unauthenticated connection address=${remoteAddress}`);
                socket.destroy();
            }
        }, Config.GAME_AUTH_TIMEOUT_MS);
        authDeadline.unref?.();

        socket.once('close', () => {
            clearTimeout(authDeadline);
            this.sockets.delete(socket);
            const remaining = Math.max(0, (this.connectionsByAddress.get(remoteAddress) ?? 1) - 1);
            if (remaining === 0) this.connectionsByAddress.delete(remoteAddress);
            else this.connectionsByAddress.set(remoteAddress, remaining);
        });
        GlobalState.clients.add(client);
        const addr = `${socket.remoteAddress}:${socket.remotePort}`;
        console.log(`[GameServer] Client connected: ${addr}`);
    }
}
