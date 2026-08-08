import { Client } from '../core/Client';
import { Config } from '../core/config';
import { performance } from 'perf_hooks';

type PacketHandler = (client: Client, data: Buffer) => void | Promise<void>;
export type PacketQueueContext = { enqueuedAt: number; depthAtEnqueue: number };
export type PacketHandlerMetrics = {
    calls: number;
    errors: number;
    totalQueueWaitMs: number;
    maxQueueWaitMs: number;
    totalHandlerDurationMs: number;
    maxHandlerDurationMs: number;
};

type RateClass = 'login' | 'movement' | 'combat' | 'chat' | 'state';
type RateBudget = { capacity: number; refillPerSecond: number };
type RateState = { tokens: number; updatedAt: number; warned: boolean };

const PRE_AUTH_PACKET_IDS = new Set([0x11, 0x13, 0x14, 0x1f]);
const MOVEMENT_PACKET_IDS = new Set([0x07, 0x08]);
const COMBAT_PACKET_IDS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x77, 0x78, 0x79, 0x82]);
const CHAT_PACKET_IDS = new Set([0x2c, 0x46, 0x5f, 0x61, 0x63]);
const RATE_BUDGETS: Record<RateClass, RateBudget> = {
    login: { capacity: 12, refillPerSecond: 0.2 },
    movement: { capacity: 120, refillPerSecond: 120 },
    combat: { capacity: 80, refillPerSecond: 40 },
    chat: { capacity: 6, refillPerSecond: 0.5 },
    state: { capacity: 60, refillPerSecond: 30 }
};
const MAX_PACKET_PAYLOAD_BYTES = 32 * 1024;
const MAX_CHAT_PAYLOAD_BYTES = 1024;

export class PacketRouter {
    private handlers: Map<number, PacketHandler> = new Map();
    private metrics: Map<number, PacketHandlerMetrics> = new Map();
    private unhandledPacketIds: Set<number> = new Set();
    private rateStates = new WeakMap<Client, Map<RateClass, RateState>>();

    public register(packetId: number, handler: PacketHandler): void {
        this.handlers.set(packetId, handler);
    }

    public noteQueueDepth(_client: Client, _depth: number): void {
        // Queue depth is tracked for metrics only; do not warn or disconnect here.
    }

    public getMetrics(packetId: number): PacketHandlerMetrics | null {
        const metric = this.metrics.get(packetId);
        return metric ? { ...metric } : null;
    }

    public async handle(client: Client, packetId: number, data: Buffer, context?: PacketQueueContext): Promise<void> {
        if (!this.admit(client, packetId, data)) {
            return;
        }
        const handler = this.handlers.get(packetId);
        if (handler) {
            const startedAt = performance.now();
            const queueWaitMs = context ? Math.max(0, startedAt - context.enqueuedAt) : 0;
            const metric = this.metrics.get(packetId) ?? {
                calls: 0,
                errors: 0,
                totalQueueWaitMs: 0,
                maxQueueWaitMs: 0,
                totalHandlerDurationMs: 0,
                maxHandlerDurationMs: 0
            };
            metric.calls += 1;
            metric.totalQueueWaitMs += queueWaitMs;
            metric.maxQueueWaitMs = Math.max(metric.maxQueueWaitMs, queueWaitMs);
            try {
                await handler(client, data);
            } catch (err) {
                metric.errors += 1;
                console.error(`[Router] Error in handler for 0x${packetId.toString(16)}:`, err);
            } finally {
                const handlerDurationMs = performance.now() - startedAt;
                metric.totalHandlerDurationMs += handlerDurationMs;
                metric.maxHandlerDurationMs = Math.max(metric.maxHandlerDurationMs, handlerDurationMs);
                this.metrics.set(packetId, metric);
            }
        } else if (!this.unhandledPacketIds.has(packetId)) {
            // Silently dropping these is why "I click it and nothing happens, and
            // nothing is logged" was impossible to chase. Once per id, so a chatty
            // client cannot flood the log.
            this.unhandledPacketIds.add(packetId);
            console.warn(`[Router] No handler registered for packet 0x${packetId.toString(16)} (${data.length} bytes)`);
        }
    }

    private admit(client: Client, packetId: number, data: Buffer): boolean {
        if (!Config.MULTIPLAYER_MODE) {
            return true;
        }

        if (data.length > MAX_PACKET_PAYLOAD_BYTES || (CHAT_PACKET_IDS.has(packetId) && data.length > MAX_CHAT_PAYLOAD_BYTES)) {
            console.warn(`[Router] Closing oversized packet id=0x${packetId.toString(16)} bytes=${data.length}`);
            client.socket.destroy();
            return false;
        }

        if (!client.authenticated && !PRE_AUTH_PACKET_IDS.has(packetId)) {
            console.warn(`[Router] Closing unauthenticated opcode id=0x${packetId.toString(16)}`);
            client.socket.destroy();
            return false;
        }

        const rateClass = this.classify(packetId);
        const budget = RATE_BUDGETS[rateClass];
        const now = performance.now();
        let clientStates = this.rateStates.get(client);
        if (!clientStates) {
            clientStates = new Map();
            this.rateStates.set(client, clientStates);
        }
        const current = clientStates.get(rateClass) ?? { tokens: budget.capacity, updatedAt: now, warned: false };
        const elapsedSeconds = Math.max(0, now - current.updatedAt) / 1000;
        current.tokens = Math.min(budget.capacity, current.tokens + elapsedSeconds * budget.refillPerSecond);
        current.updatedAt = now;
        if (current.tokens < 1) {
            if (!current.warned) {
                current.warned = true;
                console.warn(`[Router] Dropping rate-limited ${rateClass} packet token=${client.token}`);
            }
            clientStates.set(rateClass, current);
            return false;
        }

        current.tokens -= 1;
        current.warned = false;
        clientStates.set(rateClass, current);
        return true;
    }

    private classify(packetId: number): RateClass {
        if (PRE_AUTH_PACKET_IDS.has(packetId)) return 'login';
        if (MOVEMENT_PACKET_IDS.has(packetId)) return 'movement';
        if (COMBAT_PACKET_IDS.has(packetId)) return 'combat';
        if (CHAT_PACKET_IDS.has(packetId)) return 'chat';
        return 'state';
    }
}
