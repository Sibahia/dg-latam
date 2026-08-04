/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    token: number;
    userId: number;
    character: { name: string; level: number; gold: number; class: string; CurrentLevel: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    clientSpawnConfirmed: boolean;
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    lastDungeonCutsceneStartAt: number;
    sentPackets: Array<{ packetId: number; data: Buffer }>;
    send: (packetId: number, data: Buffer) => void;
    sendBitBuffer: () => void;
};

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildHpDeltaPayload(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function createClient(levelName: string, ordinal: number): FakeClient {
    return {
        token: 60_000 + ordinal,
        userId: 70_000 + ordinal,
        character: {
            name: `CapstoneClient${ordinal}`,
            level: 50,
            gold: 0,
            class: 'mage',
            CurrentLevel: { name: levelName, x: 1000, y: 1000 }
        },
        currentLevel: levelName,
        levelInstanceId: `capstone-empty-scope-${ordinal}`,
        currentRoomId: 6,
        playerSpawned: true,
        clientEntID: 80_000 + ordinal,
        clientSpawnConfirmed: false,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartAt: 0,
        sentPackets: [] as Array<{ packetId: number; data: Buffer }>,
        send(packetId: number, data: Buffer): void {
            this.sentPackets.push({ packetId, data });
        },
        sendBitBuffer: () => undefined
    };
}

function buildClientHostileFullUpdate(entityId: number, name: string): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x: 3000,
        y: 1200,
        v: 0,
        team: EntityTeam.ENEMY,
        renderDepthOffset: 0,
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId: 6
    });
    return Buffer.concat([payload, Buffer.from([0])]);
}

function cleanup(client: FakeClient, partner: FakeClient | null = null): void {
    const scope = getClientLevelScope(client as never);
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelQuestProgress.delete(scope);
    GlobalState.sessionsByToken.delete(client.token);
    if (partner) {
        GlobalState.sessionsByToken.delete(partner.token);
    }
}

// AC_Mission6 (Capstone) is a client-authority dungeon: the server initializes 0
// NPCs (no src/server/data/npcs/AC_Mission6.json). The NephitSpireMarker boss is
// promoted into the shared canonical state when partyHostileSync is "bosses-only",
// so a party fights one boss. This test validates that the shared boss objective
// commits through the HP report and stays committed through the destroy signal.
async function verifyDestroyCommitsCompletion(levelName: string, bossName: string, ordinal: number): Promise<void> {
    const client = createClient(levelName, ordinal);
    const scope = getClientLevelScope(client as never);
    GlobalState.sessionsByToken.set(client.token, client as never);

    // The dynamic sharing rule promotes a client-authority boss into the shared
    // canonical state only when 2+ players are inside the same dungeon scope.
    const partner = createClient(levelName, ordinal + 5000);
    partner.levelInstanceId = client.levelInstanceId;
    GlobalState.sessionsByToken.set(partner.token, partner as never);

    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildClientHostileFullUpdate(95_000 + ordinal, bossName)
    );
    const boss = client.entities.get(95_000 + ordinal);
    assert.ok(boss, `${levelName}: boss should exist in the client local cache`);
    // With partyHostileSync "bosses-only" the client-authority boss is promoted into
    // the shared canonical state (hybrid canonical), so a party can fight one boss.
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(95_000 + ordinal),
        true,
        `${levelName}: the shared boss should be canonical in the scope levelEntities`
    );

    // The client reports its damage via HP deltas. With the shared canonical boss the
    // kill commits through the HP report; the authored defeat signal (entity destroy)
    // must keep it committed.
    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -134_560));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: the HP report did not complete the shared boss objective`
    );

    await CombatHandler.handleEntityDestroy(
        client as never,
        buildDestroyEntityPayload(boss.id)
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: the client destroy signal regressed the objective`
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        `${levelName}: the rank plate appeared before the authored ending cutscene`
    );

    cleanup(client, partner);
}

async function main(): Promise<void> {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    await verifyDestroyCommitsCompletion('AC_Mission6', 'NephitSpireMarker', 1);
    await verifyDestroyCommitsCompletion('AC_Mission6Hard', 'NephitSpireMarkerHard', 2);
    console.log('capstone_empty_scope_destroy_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
