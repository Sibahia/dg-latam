import { strict as assert } from 'assert';
import type { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import {
    adjustMammothIdols,
    broadcastMaintenanceWarning,
    DiscordAdminRateLimiter
} from '../integrations/DiscordMaintenanceApi';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

function character(name: string, mammothIdols: number): Character {
    return { name, class: 'Mage', gender: 'Male', level: 1, mammothIdols };
}

function cloneCharacters(characters: Character[]): Character[] {
    return characters.map((entry) => ({ ...entry }));
}

function createStore(initialCharacters: Character[], failSave: boolean = false) {
    let storedCharacters = cloneCharacters(initialCharacters);
    let saveCalls = 0;
    return {
        get saveCalls(): number {
            return saveCalls;
        },
        get storedCharacters(): Character[] {
            return cloneCharacters(storedCharacters);
        },
        async loadCharacters(): Promise<Character[]> {
            return cloneCharacters(storedCharacters);
        },
        async saveCharacterSnapshot(_userId: number, updated: Character): Promise<Character[]> {
            saveCalls += 1;
            if (failSave) {
                throw new Error('injected save failure');
            }
            const index = storedCharacters.findIndex(
                (entry) => entry.name.toLowerCase() === updated.name.toLowerCase()
            );
            if (index >= 0) storedCharacters[index] = { ...updated };
            else storedCharacters.push({ ...updated });
            return cloneCharacters(storedCharacters);
        }
    };
}

function createSession(
    token: number,
    userId: number,
    activeCharacter: Character,
    characters: Character[],
    closed: boolean = false
) {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        userId,
        character: activeCharacter,
        characters,
        socket: { destroyed: closed, readyState: closed ? 'closed' : 'open' },
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, payload: BitBuffer): void {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

async function testOfflineTargetWhileAccountIsOnline(): Promise<void> {
    const alpha = character('Alpha', 10);
    const beta = character('Beta', 20);
    const store = createStore([alpha, beta]);
    const session = createSession(1, 74, beta, [alpha, beta]);
    GlobalState.sessionsByToken.set(session.token, session as never);

    const result = await adjustMammothIdols(74, 'Alpha', 'add', 5, store);

    assert.deepEqual(result, { before: 10, after: 15, onlineRecipients: 0 });
    assert.equal(store.storedCharacters.find((entry) => entry.name === 'Alpha')?.mammothIdols, 15);
    assert.equal(session.characters.find((entry) => entry.name === 'Alpha')?.mammothIdols, 15);
    assert.equal(session.sentPackets.some((packet) => packet.id === 0xA1), false);
}

async function testActiveTargetReceivesPersistedUpdate(): Promise<void> {
    const alpha = character('Alpha', 10);
    const beta = character('Beta', 20);
    const store = createStore([alpha, beta]);
    const session = createSession(2, 74, alpha, [alpha, beta]);
    GlobalState.sessionsByToken.set(session.token, session as never);

    const result = await adjustMammothIdols(74, 'alpha', 'sub', 4, store);

    assert.deepEqual(result, { before: 10, after: 6, onlineRecipients: 1 });
    assert.equal(store.storedCharacters.find((entry) => entry.name === 'Alpha')?.mammothIdols, 6);
    const walletPacket = session.sentPackets.find((packet) => packet.id === 0xA1);
    assert.ok(walletPacket, 'active target character should receive packet 0xA1 after persistence');
    assert.equal(new BitReader(walletPacket.payload).readMethod4(), 6);
}

async function testSaveFailureRollsBackLiveState(): Promise<void> {
    const activeAlpha = character('Alpha', 10);
    const listedAlpha = character('Alpha', 10);
    const store = createStore([character('Alpha', 10)], true);
    const session = createSession(3, 74, activeAlpha, [listedAlpha]);
    GlobalState.sessionsByToken.set(session.token, session as never);

    await assert.rejects(
        adjustMammothIdols(74, 'Alpha', 'add', 5, store),
        /injected save failure/
    );
    assert.equal(activeAlpha.mammothIdols, 10);
    assert.equal(listedAlpha.mammothIdols, 10);
    assert.equal(session.sentPackets.some((packet) => packet.id === 0xA1), false);
}

async function testInsufficientBalanceDoesNotSave(): Promise<void> {
    const store = createStore([character('Alpha', 3)]);
    const result = await adjustMammothIdols(74, 'Alpha', 'sub', 4, store);
    assert.deepEqual(result, { before: 3, after: 3, onlineRecipients: -1 });
    assert.equal(store.saveCalls, 0);
}

function testMaintenanceBroadcastAndChat(): void {
    const open = createSession(4, 74, character('Alpha', 10), []);
    const closed = createSession(5, 75, character('Beta', 20), [], true);
    GlobalState.sessionsByToken.set(open.token, open as never);
    GlobalState.sessionsByToken.set(closed.token, closed as never);

    assert.equal(broadcastMaintenanceWarning(90), 1);
    const warning = open.sentPackets.find((packet) => packet.id === 0x101);
    const chat = open.sentPackets.find((packet) => packet.id === 0x44);
    assert.ok(warning);
    assert.ok(chat);
    assert.equal(new BitReader(warning.payload).readMethod4(), 90);
    assert.equal(new BitReader(chat.payload).readMethod13(), 'Server maintenance starts in 90 seconds.');
    assert.equal(closed.sentPackets.length, 0);
}

function testAdminRateLimits(): void {
    const limiter = new DiscordAdminRateLimiter();
    const windowMs = 60_000;
    const startedAt = 1_000_000;

    for (let index = 0; index < 3; index++) {
        const result = limiter.consume('command:maintenance:credential', 3, windowMs, startedAt + index);
        assert.equal(result.allowed, true, `maintenance request ${index + 1} was rejected early`);
        assert.equal(result.remaining, 2 - index);
    }
    const maintenanceBlocked = limiter.consume('command:maintenance:credential', 3, windowMs, startedAt + 3);
    assert.equal(maintenanceBlocked.allowed, false, 'fourth maintenance request bypassed its one-minute limit');
    assert.equal(maintenanceBlocked.retryAfterSeconds, 60);
    assert.equal(maintenanceBlocked.resetSeconds, 60, 'rate-limit reset must be seconds remaining, not an epoch');

    const independentIdolCommand = limiter.consume('command:idols:credential', 20, windowMs, startedAt + 3);
    assert.equal(independentIdolCommand.allowed, true, 'maintenance traffic consumed the Idol command bucket');

    for (let index = 0; index < 5; index++) {
        assert.equal(
            limiter.consume('target:idols:credential:74:alpha', 5, windowMs, startedAt + index).allowed,
            true,
            `Idol target request ${index + 1} was rejected early`
        );
    }
    assert.equal(
        limiter.consume('target:idols:credential:74:alpha', 5, windowMs, startedAt + 5).allowed,
        false,
        'sixth Idol mutation for one character bypassed its target limit'
    );
    assert.equal(
        limiter.consume('target:idols:credential:74:beta', 5, windowMs, startedAt + 5).allowed,
        true,
        'one character target bucket blocked a different character'
    );

    for (let index = 0; index < 10; index++) {
        assert.equal(
            limiter.consume('failed-auth:127.0.0.1', 10, 5 * windowMs, startedAt + index).allowed,
            true,
            `failed authorization attempt ${index + 1} was rejected early`
        );
    }
    assert.equal(
        limiter.consume('failed-auth:127.0.0.1', 10, 5 * windowMs, startedAt + 10).allowed,
        false,
        'failed authorization attempts were not rate-limited'
    );

    assert.equal(
        limiter.consume('command:maintenance:credential', 3, windowMs, startedAt + windowMs + 1).allowed,
        true,
        'maintenance bucket did not recover after its sliding window expired'
    );
}

async function main(): Promise<void> {
    try {
        GlobalState.sessionsByToken.clear();
        await testOfflineTargetWhileAccountIsOnline();
        GlobalState.sessionsByToken.clear();
        await testActiveTargetReceivesPersistedUpdate();
        GlobalState.sessionsByToken.clear();
        await testSaveFailureRollsBackLiveState();
        GlobalState.sessionsByToken.clear();
        await testInsufficientBalanceDoesNotSave();
        GlobalState.sessionsByToken.clear();
        testMaintenanceBroadcastAndChat();
        testAdminRateLimits();
        console.log('Discord admin API regression checks passed.');
    } finally {
        GlobalState.sessionsByToken.clear();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
