/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { EntityState, EntityTeam } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { MissionHandler } from '../handlers/MissionHandler';

function boss(hp: number, opts: { damage?: boolean; dead?: boolean; destroyed?: boolean; clientSpawned?: boolean } = {}): any {
    return {
        id: 5001,
        name: 'SwampKing',
        characterName: ',SwampKing',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        hp,
        maxHp: 5000,
        dead: opts.dead ?? false,
        destroyed: opts.destroyed ?? false,
        entState: opts.dead ?? false ? EntityState.DEAD : EntityState.ACTIVE,
        clientSpawned: opts.clientSpawned ?? true,
        playerDamageContributed: opts.damage ?? false
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('SRN_Mission2')) {
        LevelConfig.load(dataDir);
    }

    // Auto-derivation: SRN_Mission2 (Mystery of the Yornak) originally had NO
    // clientAuthorityBosses, so its boss kill was rejected. After normalization it
    // must be derived from bossGroups.
    const condition = DungeonCompletionConditions.get('SRN_Mission2');
    assert.ok(condition, 'SRN_Mission2 condition should exist');
    assert.ok(
        Array.isArray(condition?.clientAuthorityBosses) && condition!.clientAuthorityBosses!.includes('SwampKing'),
        'clientAuthorityBosses should be auto-derived for SRN_Mission2 (SwampKing)'
    );

    // A legit terminal boss kill (the player dealt damage) must NOT be discarded.
    assert.equal(
        MissionHandler.shouldIgnoreUnverifiedDungeonBossDefeat('SRN_Mission2', boss(0, { damage: true, dead: true, destroyed: true }), ''),
        false,
        'a terminal required boss with player damage must be accepted as a verified kill'
    );

    // A scripted dead copy (no damage, no verified defeat) must be ignored so the
    // run cannot complete before the boss is really killed.
    assert.equal(
        MissionHandler.shouldIgnoreUnverifiedDungeonBossDefeat('SRN_Mission2', boss(0, { dead: true, destroyed: true }), ''),
        true,
        'a scripted terminal copy without player damage must not satisfy the boss'
    );

    // A live client-authority boss (not terminal) is trusted (client-owned fight).
    assert.equal(
        MissionHandler.shouldIgnoreUnverifiedDungeonBossDefeat('SRN_Mission2', boss(900, { clientSpawned: true }), ''),
        false,
        'a live client-authority boss must not be ignored'
    );

    // Auto-complete regression: a dead clientSpawned boss copy with NO evidence
    // (scripted dead duplicate) must NOT satisfy completion on evaluate().
    const { GlobalState } = require('../core/GlobalState');
    const { DungeonCompletionSystem } = require('../core/DungeonCompletionSystem');
    const { getLevelScopeKey } = require('../core/LevelScope');
    const emptyScope = getLevelScopeKey('SRN_Mission2', 'auto-complete-reg');
    GlobalState.levelEntities.set(emptyScope, new Map([[7001, boss(0, { dead: true, destroyed: true, clientSpawned: true })]]));
    assert.equal(
        DungeonCompletionSystem.evaluate(emptyScope).objectivesMet,
        false,
        'a scripted dead clientSpawned boss copy must not auto-complete the dungeon'
    );
    // A dead copy backed by real player damage (legit kill) completes.
    GlobalState.levelEntities.set(emptyScope, new Map([[7002, boss(0, { dead: true, destroyed: true, clientSpawned: true, damage: true })]]));
    assert.equal(
        DungeonCompletionSystem.evaluate(emptyScope).objectivesMet,
        true,
        'a dead boss copy with player damage must complete the dungeon'
    );
    GlobalState.levelEntities.delete(emptyScope);

    console.log('unified_boss_acceptance_regression: ok');
}

main();
