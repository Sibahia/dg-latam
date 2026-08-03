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

function cleanup(client: FakeClient): void {
    const scope = getClientLevelScope(client as never);
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelQuestProgress.delete(scope);
    GlobalState.sessionsByToken.delete(client.token);
}

// AC_Mission6 (Capstone) is a client-authority dungeon: the server initializes 0
// NPCs (no src/server/data/npcs/AC_Mission6.json), so GlobalState.levelEntities
// stays empty for the scope. The NephitSpireMarker boss exists only in the
// client's local cache. The live server showed the kill stuck forever:
//
//   [CombatHandler] Deferred required boss kill: health pool is a server estimate
//     { scope: 'AC_Mission6#...', entityId: ..., name: 'NephitSpireMarker',
//       derivedMaxHp: 134560, totalReportedDamage: 134560 }
//
// with no bossDeathDetected ever emitted. Root cause: AC_Mission6 lacked
// clientAuthorityBosses + partyHostileSync:"none", so the client's destroy
// signal was discarded (shouldProcessDefeatState=false and the mirror branch
// healed the boss back to ALIVE because no contribution could be recorded in
// an empty scope). This test reproduces the empty-scope destroy flow.
async function verifyDestroyCommitsCompletion(levelName: string, bossName: string, ordinal: number): Promise<void> {
    const client = createClient(levelName, ordinal);
    const scope = getClientLevelScope(client as never);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildClientHostileFullUpdate(95_000 + ordinal, bossName)
    );
    const boss = client.entities.get(95_000 + ordinal);
    assert.ok(boss, `${levelName}: boss should exist in the client local cache`);
    assert.equal(boss.clientSpawned, true, `${levelName}: the boss must be client-owned`);
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(boss.id),
        false,
        `${levelName}: the scope should have no canonical boss (empty levelEntities)`
    );

    // The client first reports its damage via HP deltas; with only a derived
    // health pool the server must defer rather than commit the kill.
    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -134_560));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        `${levelName}: HP telemetry alone must not complete an empty-scope Capstone run`
    );

    // The authored defeat signal (entity destroy) must commit the objective even
    // with an empty scope and no recorded contribution.
    await CombatHandler.handleEntityDestroy(
        client as never,
        buildDestroyEntityPayload(boss.id)
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: the client destroy signal did not commit the Capstone objective`
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        `${levelName}: the rank plate appeared before the authored ending cutscene`
    );

    cleanup(client);
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
