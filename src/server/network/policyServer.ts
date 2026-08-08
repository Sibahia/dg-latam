import * as net from 'net';
import { Config } from '../core/config';
import { buildSocketPolicy } from './socketPolicy';

export class PolicyServer {
    private server: net.Server;
    private port: number;
    private host: string;
    private readonly sockets = new Set<net.Socket>();
    private readonly policyXml: string;
    private stopPromise: Promise<void> | null = null;

    constructor(port: number = 843, host: string = Config.BIND_HOST) {
        this.port = port;
        this.host = host;
        this.policyXml = buildSocketPolicy(Config.PORTS[0], Config.SOCKET_POLICY_DOMAINS);
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    public start(): void {
        this.server.listen(this.port, this.host, () => {
            console.log(`[Policy] Server listening on ${this.host}:${this.port}`);
        });

        this.server.on('error', (err) => {
            const socketError = err as NodeJS.ErrnoException;
            if (socketError.code === 'EADDRINUSE') {
                console.error(`[Policy] Cannot listen on ${this.host}:${this.port} because the port is already in use.`);
                process.exitCode = 1;
                setImmediate(() => process.exit(1));
                return;
            }

            console.error(`[Policy] Server error:`, err);
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
                    console.error('[Policy] Stop error:', error);
                }
                clearTimeout(deadline);
                finish();
            });
        });
        return this.stopPromise;
    }

    private handleConnection(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        socket.setTimeout(3000); // 3 seconds timeout
        socket.setEncoding('utf8');

        socket.on('data', (data) => {
            const strData = data.toString();
            if (strData.includes('<policy-file-request/>')) {
                // console.log(`[Policy] Sending policy to ${socket.remoteAddress}`);
                socket.write(this.policyXml);
            }
            socket.end();
        });

        socket.on('timeout', () => {
             socket.end();
        });

        socket.on('error', (err) => {
            // console.error(`[Policy] Socket error: ${err.message}`);
        });
    }
}
