/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// Eye of the Tyrant (OMM_Mission3) completed after killing the FIRST ordinary
// mob. Its boss config is minimal (bossGroups: CyclopsChieftain), and at entry
// the CyclopsChieftain stays in levelEntities as a live hybrid canonical. When
// the first mob dies, its 0x0D destroy is alias-resolved to the ALIVE boss
// canonical and funneled through noteEntityDefeated, which had no verification
// gate: the alive boss was recorded as defeated and evaluate() returned ready.
//
// The fix gates the boss add inside noteEntityDefeated with isVerifiedBossDefeat,
// so an alive or un-verified copy can never satisfy the boss objective.

function makeCyclopsBoss(id: number, overrides: Record<string, any> = {}): any {
    return {
        id,
        name: 'CyclopsChieftain',
        EntName: 'CyclopsChieftain',
        characterName: ',CyclopsChieftain',
        isPlayer: false,
        clientSpawned: false,
        hybridCanonicalHostile: true,
        team: EntityTeam.ENEMY,
        roomId: 3,
        hp: 46_000,
        maxHp: 46_000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        ...overrides
    };
}

function run(): void {
    const condition = DungeonCompletionConditions.get('OMM_Mission3');
    assert.ok(condition, 'OMM_Mission3 must have a completion condition');
    assert.deepEqual(
        condition?.clientAuthorityBosses,
        ['CyclopsChieftain'],
        'auto-derivation must make CyclopsChieftain a client-authority boss so the gate applies'
    );

    // Scenario A: a mob's destroy is alias-resolved to the ALIVE boss canonical.
    const scopeAlive = getLevelScopeKey('OMM_Mission3', 'eye-alive-boss');
    const aliveBoss = makeCyclopsBoss(9001);
    GlobalState.levelEntities.set(scopeAlive, new Map([[aliveBoss.id, aliveBoss]]));
    DungeonCompletionSystem.noteEntityDefeated(scopeAlive, aliveBoss);

    assert.equal(
        DungeonCompletionSystem.evaluate(scopeAlive).objectivesMet,
        false,
        'OMM_Mission3 must not complete while the CyclopsChieftain canonical is still alive'
    );

    DungeonCompletionSystem.reset(scopeAlive);
    GlobalState.levelEntities.delete(scopeAlive);

    // Scenario B: the boss dies without a verified defeat (no damage/defeat
    // signal) -- a dead-at-start or scripted copy must not satisfy completion.
    const scopeUnverified = getLevelScopeKey('OMM_Mission3', 'eye-unverified-dead');
    const deadUnverified = makeCyclopsBoss(9002, {
        hp: 0,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    });
    GlobalState.levelEntities.set(scopeUnverified, new Map([[deadUnverified.id, deadUnverified]]));
    DungeonCompletionSystem.noteEntityDefeated(scopeUnverified, deadUnverified);

    assert.equal(
        DungeonCompletionSystem.evaluate(scopeUnverified).objectivesMet,
        false,
        'OMM_Mission3 must not complete from an un-verified dead CyclopsChieftain copy'
    );

    DungeonCompletionSystem.reset(scopeUnverified);
    GlobalState.levelEntities.delete(scopeUnverified);

    // Scenario C: the real kill (verified defeat) must still complete.
    const scopeVerified = getLevelScopeKey('OMM_Mission3', 'eye-verified-kill');
    const verifiedBoss = makeCyclopsBoss(9003, {
        hp: 0,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD,
        clientDefeatVerified: true,
        playerDamageContributed: true
    });
    GlobalState.levelEntities.set(scopeVerified, new Map([[verifiedBoss.id, verifiedBoss]]));
    DungeonCompletionSystem.noteEntityDefeated(scopeVerified, verifiedBoss);

    assert.equal(
        DungeonCompletionSystem.evaluate(scopeVerified).objectivesMet,
        true,
        'OMM_Mission3 must complete from a verified CyclopsChieftain kill'
    );

    DungeonCompletionSystem.reset(scopeVerified);
    GlobalState.levelEntities.delete(scopeVerified);
}

LevelConfig.load(path.resolve(__dirname, '../data'));

run();
console.log('note_entity_defeated_gate_regression: ok');
