/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { RewardHandler } from '../handlers/RewardHandler';

type SentPacket = { id: number; payload: Buffer };

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
        levelInstanceId: 'east-wing-loot',
        currentRoomId: 3,
        playerSpawned: true,
        clientEntID: token + 1000,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        entities: new Map<number, any>(),
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sentPackets: [] as SentPacket[],
        send(id: number, payload: Buffer) { (this.sentPackets as SentPacket[]).push({ id, payload: Buffer.from(payload) }); },
        sendBitBuffer(id: number) { (this.sentPackets as SentPacket[]).push({ id, payload: Buffer.alloc(0) }); }
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mini2')) {
        LevelConfig.load(dataDir);
    }
    GameData.load(dataDir);

    // TowerGuard1/2 must have a weapon drop table (the GuardCaptain pool).
    const tower1 = GameData.GEAR_DATA.boss_drops?.TowerGuard1;
    const tower2 = GameData.GEAR_DATA.boss_drops?.TowerGuard2;
    assert.ok(Array.isArray(tower1) && tower1.length > 0, 'TowerGuard1 must have boss_drops');
    assert.ok(Array.isArray(tower2) && tower2.length > 0, 'TowerGuard2 must have boss_drops');
    const guardPool = GameData.GEAR_DATA.boss_drops?.GuardCaptain ?? [];
    assert.deepEqual(new Set(tower2 ?? []), new Set(guardPool), 'TowerGuard2 must reuse the GuardCaptain drop pool');

    // Hard variants resolve through normalizeEntityDropName.
    assert.ok(
        GameData.getGearIdForEntity('TowerGuard2', undefined, undefined, 'JC_Mini2') > 0,
        'TowerGuard2 must yield a weapon id in JC_Mini2'
    );
    assert.ok(
        GameData.getGearIdForEntity('TowerGuard1', undefined, undefined, 'JC_Mini1') > 0,
        'TowerGuard1 must yield a weapon id in JC_Mini1'
    );
    assert.ok(
        GameData.getGearIdForEntity('GuardCaptain', undefined, undefined, 'JC_Mission8') > 0,
        'GuardCaptain must yield a weapon id in JC_Mission8'
    );

    // Killing the East Wing boss must grant server-side loot (gold, health orb, gear).
    const first = makeClient('EastWingLead', 40001);
    const scope = getLevelScopeKey('JC_Mini2', 'east-wing-loot');
    GlobalState.sessionsByToken.set(first.token, first as never);
    GlobalState.refreshSessionIndexes(first as never);

    const boss: any = {
        id: 920004,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 3,
        x: 2000,
        y: 2000,
        hp: 0,
        maxHp: 400_000,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD,
        lifeNonce: 1,
        deathFinalizedAt: Date.now(),
        finalDeathReason: 'east_wing_boss_kill',
        lootDropNonce: `${scope}:920004:1`
    };
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));

    (CombatHandler as any).grantTutorialCompletionBossReward(first, scope, boss, 'east_wing_boss_kill_test');

    const lootPackets = first.sentPackets.filter((packet: SentPacket) => packet.id === 0x32);
    assert.ok(lootPackets.length > 0, 'East Wing boss must drop loot (gold / orb / gear)');
    assert.equal(boss.lootDropped, true, 'East Wing boss must be marked lootDropped');

    GlobalState.sessionsByToken.delete(first.token);
    GlobalState.levelEntities.delete(scope);

    console.log('east_wing_boss_loot_regression: ok');
}

main();
