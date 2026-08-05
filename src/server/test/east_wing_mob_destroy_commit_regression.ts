/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

function makeClient(name: string, token: number): any {
    return {
        token,
        userId: token,
        character: {
            name,
            level: 50,
            class: 'mage',
            CurrentLevel: { name: 'JC_Mini2', x: 1000, y: 1000 }
        },
        currentLevel: 'JC_Mini2',
        levelInstanceId: `east-wing-destroy-commit-${token}`,
        currentRoomId: 3,
        playerSpawned: true,
        clientEntID: token + 1000,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        sentPackets: [] as Array<{ id: number; payload: Buffer }>,
        send(id: number, payload: Buffer) { (this.sentPackets as Array<{ id: number; payload: Buffer }>).push({ id, payload: Buffer.from(payload) }); },
        sendBitBuffer() { return undefined; }
    };
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mini2')) {
        LevelConfig.load(dataDir);
    }

    const client = makeClient('EastWingMobKiller', 60001);
    const scope = getLevelScopeKey('JC_Mini2', client.levelInstanceId);
    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.refreshSessionIndexes(client as never);

    // A server-authority sync NPC whose canonical HP never reached 0 through the
    // damage-accounting relay (e.g. killed by an AoE blast / HP-report kill).
    const mob: any = {
        id: 920001,
        name: 'GreaterDemonMaligner',
        EntName: 'GreaterDemonMaligner',
        characterName: ',GreaterDemonMaligner',
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 3,
        hp: 100,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
    GlobalState.levelEntities.set(scope, new Map([[mob.id, mob]]));
    client.entities.set(mob.id, { ...mob });

    // The client resolves the kill and reports a destroy while the canonical HP is
    // still > 0. The server must trust the terminal signal and commit the death so
    // loot and completion are granted.
    void (async () => {
        await CombatHandler.handleEntityDestroy(client as never, buildDestroyEntityPayload(mob.id));
        assert.equal(mob.hp, 0, 'server-authority mob destroy with canonical HP>0 must commit the kill');
        assert.equal(mob.dead, true, 'server-authority mob destroy must mark the canonical dead');
        assert.equal(mob.destroyed, true, 'server-authority mob destroy must mark the canonical destroyed');
        assert.equal(Number(mob.deathFinalizedAt ?? 0) > 0, true, 'server-authority mob destroy must finalize the death (loot path)');
        assert.equal(mob.lootDropped, true, 'server-authority mob destroy must grant server-side loot');

        GlobalState.sessionsByToken.delete(client.token);
        GlobalState.levelEntities.delete(scope);
        console.log('east_wing_mob_destroy_commit_regression: ok');
    })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

main();
