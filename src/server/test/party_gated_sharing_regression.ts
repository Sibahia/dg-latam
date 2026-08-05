/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

function makeClient(name: string, token: number, levelInstanceId: string): any {
    return {
        token,
        userId: token,
        character: { name, level: 40, CurrentLevel: { name: 'JC_Mission8', x: 0, y: 0 } },
        currentLevel: 'JC_Mission8',
        levelInstanceId,
        currentRoomId: 2,
        playerSpawned: true,
        clientEntID: token,
        entities: new Map<number, any>()
    };
}

function hostile(): any {
    return {
        id: 9001,
        name: 'GuardCaptain',
        characterName: ',GuardCaptain',
        clientSpawned: true,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        destroyed: false
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission8')) {
        LevelConfig.load(dataDir);
    }

    // Two players in SEPARATE instances of the SAME mission, not in a party.
    const alice = makeClient('Alice', 1001, '1001');
    const bob = makeClient('Bob', 1002, '1002');
    GlobalState.sessionsByToken.set(alice.token, alice as never);
    GlobalState.sessionsByToken.set(bob.token, bob as never);

    const aliceScope = getLevelScopeKey('JC_Mission8', alice.levelInstanceId);
    const bobScope = getLevelScopeKey('JC_Mission8', bob.levelInstanceId);

    assert.notEqual(aliceScope, bobScope, 'separate instances must use distinct scopes');
    assert.equal(
        DungeonCompletionConditions.isSharedDungeonScope(aliceScope),
        false,
        'two unrelated players in separate instances must not be treated as a shared dungeon'
    );
    assert.equal(
        DungeonCompletionConditions.sharesClientHostileWithParty('JC_Mission8', hostile(), aliceScope),
        false,
        'a solo non-party player must keep hostiles private'
    );

    // A scope with no instance id (ambiguous) must never count as shared.
    assert.equal(
        DungeonCompletionConditions.isSharedDungeonScope('JC_Mission8'),
        false,
        'a bare scope without an instance id must never be shared'
    );

    // The same two players in the SAME party + SAME scope DO share everything.
    bob.levelInstanceId = alice.levelInstanceId;
    GlobalState.partyByMember.set('alice', 5555);
    GlobalState.partyByMember.set('bob', 5555);
    GlobalState.partyGroups.set(5555, {
        id: 5555,
        leader: 'Alice',
        members: ['Alice', 'Bob'],
        locked: false
    });
    GlobalState.refreshSessionIndexes(bob as never);

    const sharedScope = getLevelScopeKey('JC_Mission8', alice.levelInstanceId);
    assert.equal(
        DungeonCompletionConditions.isSharedDungeonScope(sharedScope),
        true,
        'two players in the same party and same dungeon scope must be a shared dungeon'
    );
    assert.equal(
        DungeonCompletionConditions.sharesClientHostileWithParty('JC_Mission8', hostile(), sharedScope),
        true,
        'party members in the same dungeon must share hostiles'
    );

    GlobalState.sessionsByToken.delete(alice.token);
    GlobalState.sessionsByToken.delete(bob.token);
    GlobalState.partyByMember.delete('alice');
    GlobalState.partyByMember.delete('bob');
    GlobalState.partyGroups.delete(5555);

    console.log('party_gated_sharing_regression: ok');
}

main();
