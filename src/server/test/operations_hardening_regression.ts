import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as net from 'net';

process.env.MULTIPLAYER_MODE = 'true';
process.env.MULTIPLAYER_BASE_IP = 'game.example.invalid';
process.env.MAX_GAME_CONNECTIONS = '2';
process.env.MAX_GAME_CONNECTIONS_PER_IP = '1';
process.env.SHUTDOWN_GRACE_MS = '25';
process.env.SHUTDOWN_TIMEOUT_MS = '100';
process.env.SOCKET_POLICY_DOMAINS = 'game.example.invalid';

const { GameServer } = require('../core/server') as typeof import('../core/server');
const { PacketRouter } = require('../network/packetRouter') as typeof import('../network/packetRouter');
const { PolicyServer } = require('../network/policyServer') as typeof import('../network/policyServer');
const { buildSocketPolicy } = require('../network/socketPolicy') as typeof import('../network/socketPolicy');
const { resolveDefaultMultiplayerHost, resolveMultiplayerHost } = require('../core/config') as typeof import('../core/config');

class FakeSocket extends EventEmitter {
    destroyed = false;
    destroy(): this {
        this.destroyed = true;
        return this;
    }
}

function waitForEvent(emitter: EventEmitter, event: string, timeoutMs: number = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
        emitter.once(event, () => {
            clearTimeout(timeout);
            resolve();
        });
        emitter.once('error', reject);
    });
}

function testNetworkDiscoveryFallbacks(): void {
    let calls = 0;
    const blocked = (): string => {
        calls += 1;
        throw new Error('network enumeration should not run');
    };
    assert.equal(resolveMultiplayerHost(false, undefined, blocked), 'localhost');
    assert.equal(resolveMultiplayerHost(true, 'explicit.example.invalid', blocked), 'explicit.example.invalid');
    assert.equal(calls, 0, 'unused network discovery was evaluated eagerly');

    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
        assert.equal(resolveDefaultMultiplayerHost(() => { throw new Error('blocked'); }), 'localhost');
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(warned, true, 'network discovery failure did not emit an operator warning');
}

async function testPacketAdmission(): Promise<void> {
    const router = new PacketRouter();
    let handled = 0;
    router.register(0x2c, () => { handled += 1; });

    const unauthenticatedSocket = new FakeSocket();
    const unauthenticatedClient = { authenticated: false, socket: unauthenticatedSocket, token: 0 };
    await router.handle(unauthenticatedClient as never, 0x2c, Buffer.from('hello'));
    assert.equal(handled, 0);
    assert.equal(unauthenticatedSocket.destroyed, true, 'unauthenticated gameplay opcode stayed connected');

    const chatSocket = new FakeSocket();
    const chatClient = { authenticated: true, socket: chatSocket, token: 42 };
    for (let index = 0; index < 12; index += 1) {
        await router.handle(chatClient as never, 0x2c, Buffer.from('hello'));
    }
    assert.equal(handled, 6, 'chat token bucket did not bound a burst');

    const oversizedSocket = new FakeSocket();
    const oversizedClient = { authenticated: true, socket: oversizedSocket, token: 43 };
    await router.handle(oversizedClient as never, 0x2c, Buffer.alloc(1025));
    assert.equal(oversizedSocket.destroyed, true, 'oversized chat payload stayed connected');
}

async function testConnectionLimitAndShutdown(): Promise<void> {
    const router = new PacketRouter();
    const gameServer = new GameServer(0, router, '127.0.0.1');
    gameServer.start();
    const nativeServer = (gameServer as any).server as net.Server;
    if (!nativeServer.listening) await waitForEvent(nativeServer, 'listening');
    const port = Number((nativeServer.address() as net.AddressInfo).port);

    const first = net.createConnection({ host: '127.0.0.1', port });
    await waitForEvent(first, 'connect');
    const second = net.createConnection({ host: '127.0.0.1', port });
    await waitForEvent(second, 'connect');
    await waitForEvent(second, 'close');
    assert.equal(first.destroyed, false, 'connection ceiling removed an admitted client');

    const startedAt = Date.now();
    await gameServer.stop();
    assert(Date.now() - startedAt < 500, 'idle TCP client blocked bounded shutdown');
    if (!first.destroyed) await waitForEvent(first, 'close');
    assert.equal(first.destroyed, true);
}

async function testPolicyServer(): Promise<void> {
    const expected = buildSocketPolicy(8080, ['game.example.invalid']);
    assert.match(expected, /domain="game\.example\.invalid" to-ports="8080"/);
    assert.doesNotMatch(expected, /domain="\*"|1-65535/);

    const policyServer = new PolicyServer(0, '127.0.0.1');
    assert.equal((policyServer as any).policyXml, expected, 'dedicated policy server did not use shared narrowed policy');
    policyServer.start();
    const nativeServer = (policyServer as any).server as net.Server;
    if (!nativeServer.listening) await waitForEvent(nativeServer, 'listening');
    await policyServer.stop();
}

async function main(): Promise<void> {
    testNetworkDiscoveryFallbacks();
    await testPacketAdmission();
    await testConnectionLimitAndShutdown();
    await testPolicyServer();
    console.log('operations_hardening_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
