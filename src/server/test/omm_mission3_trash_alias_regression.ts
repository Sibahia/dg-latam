/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

// Eye of the Tyrant (OMM_Mission3) completed after killing the FIRST mob: the
// tracked CyclopsChieftain boss copy carries the client's start room (or no
// room), so findSingleRoomBossForUnknownClientHostile resolved ANY trash mob
// (CyclopsBerserker/CyclopsCoward/...) to the boss. The 0x78 HP delta then
// stamped playerDamageContributed on the boss and the 0x0D destroy marked the
// alive boss dead, so the mission auto-completed. The alias now requires the
// unknown hostile to share the boss's identity (bossGroups/bossAliases).

function buildHpDeltaPayload(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function createClient(ordinal: number): any {
    return {
        currentLevel: 'OMM_Mission3',
        levelInstanceId: `eye-of-the-tyrant-${ordinal}`,
        currentRoomId: 3,
        token: 70_000 + ordinal,
        userId: 80_000 + ordinal,
        playerSpawned: true,
        clientEntID: 90_000 + ordinal,
        character: {
            name: `EyeKiller${ordinal}`,
            level: 26,
            class: 'mage',
            CurrentLevel: { name: 'OMM_Mission3', x: 0, y: 0 },
            missions: {}
        },
        entities: new Map<number, any>(),
        entityIdAliases: new Map<number, number>(),
        knownEntityIds: new Set<number>(),
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartAt: 0,
        sentPackets: [] as Array<{ packetId: number; data: Buffer }>,
        send() { return undefined; }
    };
}

function makeBoss(id: number): any {
    return {
        id,
        name: 'CyclopsChieftain',
        EntName: 'CyclopsChieftain',
        characterName: ',CyclopsChieftain',
        character_name: ',CyclopsChieftain',
        isPlayer: false,
        clientSpawned: false,
        hybridCanonicalHostile: true,
        team: EntityTeam.ENEMY,
        roomId: 3,
        hp: 46_000,
        maxHp: 46_000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function makeMob(id: number): any {
    return {
        id,
        name: 'CyclopsBerserker',
        EntName: 'CyclopsBerserker',
        characterName: ',CyclopsBerserker',
        character_name: ',CyclopsBerserker',
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 3,
        hp: 5_000,
        maxHp: 5_000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

async function main(): Promise<void> {
    LevelConfig.load(path.resolve(__dirname, '../data'));

    const client = createClient(1);
    const scope = getClientLevelScope(client as never);
    assert(scope, 'OMM_Mission3 must resolve a level scope');
    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.refreshSessionIndexes(client as never);

    // Scenario A: a trash mob is damaged and destroyed in the boss's (start)
    // room. Its damage and kill must never be attributed to the boss.
    const boss = makeBoss(9001);
    const mob = makeMob(7001);
    client.entities.set(mob.id, mob);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(mob.id, -500));
    assert.equal(
        Boolean(boss.playerDamageContributed),
        false,
        'OMM_Mission3: trash mob damage must not be attributed to the CyclopsChieftain boss'
    );

    await CombatHandler.handleEntityDestroy(client as never, buildDestroyEntityPayload(mob.id));
    assert.equal(boss.dead, false, 'OMM_Mission3: trash mob destroy must not kill the alive boss canonical');
    assert.equal(boss.hp, 46_000, 'OMM_Mission3: trash mob destroy must not touch the boss HP');
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        'OMM_Mission3: killing a CyclopsBerserker must not complete Eye of the Tyrant'
    );

    cleanup(scope);

    // Scenario B: the real CyclopsChieftain kill still completes the mission.
    // The boss canonical is verified through the damage-contribution + destroy
    // path (the player fought it), not the 0x78 HP relay.
    const boss2 = makeBoss(9002);
    client.entities.set(boss2.id, boss2);
    GlobalState.levelEntities.set(scope, new Map([[boss2.id, boss2]]));
    GlobalState.combatContributions.set(
        `${scope}:${boss2.id}:0`,
        new Map([['EyeKiller1', boss2.maxHp]])
    );

    await CombatHandler.handleEntityDestroy(client as never, buildDestroyEntityPayload(boss2.id));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'OMM_Mission3: a verified CyclopsChieftain kill must complete Eye of the Tyrant'
    );

    cleanup(scope);
    GlobalState.sessionsByToken.delete(client.token);
    console.log('omm_mission3_trash_alias_regression: ok');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
