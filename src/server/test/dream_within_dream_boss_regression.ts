/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// Dream Within a Dream (JC_Mission6) never completed after killing the boss.
// The level was configured for PortalMaster, but the live client reports the
// boss as NephitDragon / NephitDragonMarker / NephitDragonPortal, so every kill
// report failed isRequiredBoss and was dropped silently (same shape as the
// Fable of the Lost Temple fix). The condition now keys on NephitDragon and
// aliases every reported variant (plus the old PortalMaster names and the
// "The Last Bad Dream" display name) onto it.

const REPORTED_BOSS_NAMES: Array<[string, string]> = [
    ['JC_Mission6', 'NephitDragon'],
    ['JC_Mission6', 'NephitDragonMarker'],
    ['JC_Mission6', 'NephitDragonPortal'],
    ['JC_Mission6', 'PortalMaster'],
    ['JC_Mission6', 'The Last Bad Dream'],
    ['JC_Mission6Hard', 'NephitDragonHard'],
    ['JC_Mission6Hard', 'NephitDragonMarkerHard'],
    ['JC_Mission6Hard', 'NephitDragonPortalHard'],
    ['JC_Mission6Hard', 'NephitDragon'],
    ['JC_Mission6Hard', 'PortalMaster'],
    ['JC_Mission6Hard', 'PortalMasterHard'],
    ['JC_Mission6Hard', 'The Last Bad Dream']
];

const OBSERVED_TRASH = [
    'GreaterDemonMaligner',
    'BoneGolem',
    'ShadeSummoner2',
    'GreaterDemonMalignerHard',
    'BoneGolemHard',
    'ShadeSummoner2Hard'
];

function createDead(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 5,
        hp: 0,
        maxHp: 320_000,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD,
        playerDamageContributed: true
    };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// Every name the client reported for the boss must resolve to NephitDragon,
// or the HP-report path silently drops the kill again.
function verifyReportedBossNamesResolve(levelName: string, canonical: string): void {
    for (const [reportedLevel, name] of REPORTED_BOSS_NAMES) {
        if (reportedLevel !== levelName) {
            continue;
        }
        assert.equal(
            DungeonCompletionConditions.getCanonicalBossName(levelName, {
                id: 1,
                name,
                characterName: `,${name}`
            }),
            canonical,
            `${levelName}: boss reported as ${name} does not resolve to ${canonical}, ` +
            `so completeRequiredBossFromClientHpReport drops the kill`
        );
    }
}

// Defeating the NephitDragon boss must complete the mission.
function verifyNephitDragonCompletesTheRun(levelName: string, bossName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `dream-boss-${ordinal}`);
    const boss = createDead(80_000 + ordinal, bossName);

    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: defeating ${bossName} does not satisfy the objectives, so the ` +
        `kill is dropped and the run stays on objectives_pending`
    );

    cleanup(scope);
}

// The trash the player clears on the way must never end the dungeon.
function verifyObservedTrashDoesNotComplete(levelName: string, ordinal: number): void {
    for (const [index, name] of OBSERVED_TRASH.entries()) {
        const scope = getLevelScopeKey(levelName, `dream-trash-${ordinal}-${index}`);
        const mob = createDead(81_000 + ordinal * 10 + index, name);

        GlobalState.levelEntities.set(scope, new Map([[mob.id, mob]]));
        DungeonCompletionSystem.noteEntityDefeated(scope, mob);

        assert.equal(
            DungeonCompletionSystem.evaluate(scope).objectivesMet,
            false,
            `${levelName}: killing ${name} completed the dungeon`
        );

        cleanup(scope);
    }
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));

    verifyNephitDragonCompletesTheRun('JC_Mission6', 'NephitDragon', 1);
    verifyNephitDragonCompletesTheRun('JC_Mission6Hard', 'NephitDragonHard', 2);
    verifyReportedBossNamesResolve('JC_Mission6', 'NephitDragon');
    verifyReportedBossNamesResolve('JC_Mission6Hard', 'NephitDragonHard');
    verifyObservedTrashDoesNotComplete('JC_Mission6', 1);
    verifyObservedTrashDoesNotComplete('JC_Mission6Hard', 2);

    console.log('dream_within_dream_boss_regression: ok');
}

main();
