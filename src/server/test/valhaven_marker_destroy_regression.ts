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
            name: `ValhavenClient${ordinal}`,
            level: 50,
            gold: 0,
            class: 'mage',
            CurrentLevel: { name: levelName, x: 1000, y: 1000 }
        },
        currentLevel: levelName,
        levelInstanceId: `valhaven-empty-scope-${ordinal}`,
        currentRoomId: 2,
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
        roomId: 2
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

// Valhaven (JC_*) dungeons are client-authority. The client kills the boss and
// reports HP deltas (deferred against a server-derived pool) and then sends the
// authored defeat signal (entity destroy). Without partyHostileSync:"none" the
// mirror branch healed the boss back to ALIVE in an empty scope and the run sat
// on objectives_pending forever — the exact Capstone bug. Every JC_* bosses
// dungeon must commit via the empty-scope destroy.
async function verifyDestroyCommitsCompletion(levelName: string, bossNames: string[], ordinal: number): Promise<void> {
    const client = createClient(levelName, ordinal);
    const scope = getClientLevelScope(client as never);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const spawnedBosses: any[] = [];
    for (const [index, bossName] of bossNames.entries()) {
        const entityId = 95_000 + ordinal * 10 + index;
        EntityHandler.handleEntityFullUpdate(
            client as never,
            buildClientHostileFullUpdate(entityId, bossName)
        );
        const boss = client.entities.get(entityId);
        assert.ok(boss, `${levelName}: boss ${bossName} should exist in the client local cache`);
        assert.equal(boss.clientSpawned, true, `${levelName}: the boss must be client-owned`);
        assert.equal(
            GlobalState.levelEntities.get(scope)?.has(boss.id),
            false,
            `${levelName}: the scope should have no canonical boss (empty levelEntities)`
        );
        spawnedBosses.push(boss);
    }

    for (const boss of spawnedBosses) {
        CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -300_000));
    }
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        `${levelName}: HP telemetry alone must not complete an empty-scope run`
    );

    // Missions with requirePlayerDamageForClientBosses (JC_Mission2/2Hard) only commit
    // a verified client-boss destroy once the player has contributed damage. The HP
    // delta above is the contribution signal; mirror the verified-damage flag the
    // server sets for a real damaged boss.
    const condition = (await import('../core/DungeonCompletionConditions')).DungeonCompletionConditions.get(levelName);
    if (condition?.requirePlayerDamageForClientBosses) {
        for (const boss of spawnedBosses) {
            boss.playerDamageContributed = true;
        }
        for (const entity of GlobalState.levelEntities.get(scope)?.values() ?? []) {
            if (!entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY) {
                entity.playerDamageContributed = true;
            }
        }
    }

    for (const boss of spawnedBosses) {
        await CombatHandler.handleEntityDestroy(
            client as never,
            buildDestroyEntityPayload(boss.id)
        );
    }
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: the client destroy signal did not commit the objective`
    );

    cleanup(client);
}

const BOSSES: Array<[string, string[]]> = [
    ['JC_Mission1', ['ImperialChampion']],
    ['JC_Mission1Hard', ['ImperialChampionHard']],
    ['JC_Mission2', ['GreaterBoneGolem', 'GreaterBoneGolem2']],
    ['JC_Mission2Hard', ['GreaterBoneGolemHard', 'GreaterBoneGolem2Hard']],
    ['JC_Mission4', ['RatlingKing']],
    ['JC_Mission4Hard', ['RatlingKingHard']],
    ['JC_Mission5', ['PhantomKnightMarker']],
    ['JC_Mission5Hard', ['PhantomKnightMarkerHard']],
    ['JC_Mission6', ['PortalMaster']],
    ['JC_Mission6Hard', ['PortalMasterHard']],
    ['JC_Mission7', ['EmperorMarker']],
    ['JC_Mission7Hard', ['EmperorMarkerHard']],
    ['JC_Mission9', ['RisenBandit', 'RisenBandit2']],
    ['JC_Mission9Hard', ['RisenBanditHard', 'RisenBandit2Hard']],
    ['JC_Mission10', ['DragonTemple']],
    ['JC_Mission10Hard', ['DragonTempleHard']]
];

async function main(): Promise<void> {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    for (const [index, [level, bosses]] of BOSSES.entries()) {
        await verifyDestroyCommitsCompletion(level, bosses, index + 1);
    }
    console.log('valhaven_marker_destroy_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
