/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { EntityHandler } from '../handlers/EntityHandler';
import { getLevelScopeKey, getClientLevelScope } from '../core/LevelScope';

type FakeClient = {
    token: number;
    userId: number;
    character: any;
    currentLevel: string;
    levelInstanceId: string;
    playerSpawned: boolean;
    clientEntID: number;
    entities: Map<number, any>;
    currentRoomId: number;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission5')) {
        LevelConfig.load(dataDir);
    }
}

function makeClient(name: string, token: number): FakeClient {
    return {
        token,
        userId: token,
        character: {
            name,
            level: 50,
            class: 'mage',
            CurrentLevel: { name: 'JC_Mission5', x: 1000, y: 1000 }
        },
        currentLevel: 'JC_Mission5',
        levelInstanceId: `party-scope-${token}`,
        playerSpawned: true,
        clientEntID: token + 1000,
        entities: new Map<number, any>(),
        currentRoomId: 2
    };
}

function setParty(...clients: FakeClient[]): void {
    const partyId = 9911;
    for (const client of clients) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: clients[0].character.name,
        members: clients.map((c) => c.character.name),
        locked: false
    });
}

// Two party members entering the same client-authority dungeon must share one
// level scope. Previously ensureJcMini1PartySharedScope only realigned
// server-authority levels (JC_Mini1/Mini2/Tutorial), so a joiner who raced the
// anchor's spawn landed in a different levelInstanceId and the pair never saw
// each other (invisible) — and the client-authority boss spawned in the wrong
// scope never registered for the other player.
function main(): void {
    ensureDataLoaded();
    const anchor = makeClient('ValhavenAnchor', 30001);
    const joiner = makeClient('ValhavenJoiner', 30002);
    setParty(anchor, joiner);
    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    // Simulate the race: the joiner has its own instanceId, the anchor another.
    const anchorScope = getLevelScopeKey('JC_Mission5', 'shared-valhaven-run');
    anchor.levelInstanceId = 'shared-valhaven-run';
    joiner.levelInstanceId = 'divergent-instance';

    const joinerScope = EntityHandler.ensureJcMini1PartySharedScope(
        joiner as never,
        'JC_Mission5',
        'party_dungeon_shared_scope_regression'
    );

    assert.equal(
        getClientLevelScope(joiner as never),
        anchorScope,
        'joiner must adopt the party anchor level scope in a client-authority dungeon'
    );
    assert.equal(
        joiner.levelInstanceId,
        'shared-valhaven-run',
        'joiner levelInstanceId must match the anchor'
    );
    assert.ok(joinerScope === anchorScope || joiner.levelInstanceId === 'shared-valhaven-run', 'shared scope reached');

    GlobalState.sessionsByToken.delete(anchor.token);
    GlobalState.sessionsByToken.delete(joiner.token);
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();

    console.log('party_dungeon_shared_scope_regression: ok');
}

main();
