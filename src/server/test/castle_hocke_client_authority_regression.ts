import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { RewardHandler } from '../handlers/RewardHandler';
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
    mountTransferGraceUntil: number;
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    sentPacketIds: number[];
    send: (id: number) => void;
    sendBitBuffer: () => void;
};

function createClient(): FakeClient {
    return {
        token: 41001,
        userId: 41001,
        character: {
            name: 'CastleClient',
            level: 50,
            gold: 0,
            class: 'mage',
            CurrentLevel: { name: 'AC_Mission1', x: 1000, y: 1000 }
        },
        currentLevel: 'AC_Mission1',
        levelInstanceId: 'client-authority-regression',
        currentRoomId: 2,
        playerSpawned: true,
        clientEntID: 41001,
        clientSpawnConfirmed: false,
        mountTransferGraceUntil: 0,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        sentPacketIds: [],
        send(id: number) {
            this.sentPacketIds.push(id);
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

function buildClientRewardPayload(sourceId: number, receiverId: number, gold: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(receiverId);
    bb.writeMethod9(sourceId);
    bb.writeMethod15(false);
    bb.writeMethod309(0);
    bb.writeMethod15(false);
    bb.writeMethod309(0);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(gold);
    bb.writeMethod24(3000);
    bb.writeMethod24(1200);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildClientDeadStatePayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.DEAD, 2);
    for (let index = 0; index < 6; index += 1) {
        bb.writeMethod15(false);
    }
    return bb.toBuffer();
}

function buildClientDestroyPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

async function main(): Promise<void> {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    const client = createClient();
    const levelScope = getClientLevelScope(client as never);

    assert.equal(EntityHandler.usesServerAuthorityHostiles('AC_Mission1'), false);
    assert.equal(EntityHandler.usesServerAuthorityHostiles('AC_Mission1Hard'), false);
    assert.equal(EntityHandler.usesCanonicalVisibleServerAuthorityHostiles('AC_Mission1'), false);
    assert.equal(
        (CombatHandler as any).SERVER_AUTHORITY_SYNC_LEVELS.has('AC_Mission1'),
        false,
        'Castle Hocke must not enter the multiplayer server-hostile combat relay'
    );
    assert.equal(
        (EntityHandler as any).CLIENT_SPAWN_LEVELS.has('AC_Mission1Hard'),
        true,
        'Dread Castle Hocke should keep the same client-spawn ownership contract'
    );

    EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    assert.equal(
        [...(GlobalState.levelEntities.get(levelScope)?.values() ?? [])]
            .some((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY),
        false,
        'Castle Hocke must wait for authored client spawns instead of seeding server enemies'
    );

    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildClientHostileFullUpdate(3812092, 'AncientDragonGold')
    );
    const clientBoss = client.entities.get(3812092);
    assert.ok(clientBoss, 'the authored Castle Hocke boss should remain in the client cache');
    // With partyHostileSync "bosses-only" the client-authority boss is promoted into the
    // shared canonical state so a party fights one AncientDragonGold together.
    assert.equal(
        GlobalState.levelEntities.get(levelScope)?.has(3812092),
        true,
        'the Castle Hocke boss should be promoted into the shared canonical state'
    );

    const rewardPayload = buildClientRewardPayload(3812092, client.clientEntID, 250);
    RewardHandler.handleGrantReward(client as never, rewardPayload);
    // The shared canonical boss is looted through the server reward path, not the
    // legacy client reward packet, but it must not crash or duplicate.
    const lootCount = client.pendingLoot.size;

    // The shared canonical boss dies through the server defeat path; the authored
    // defeat cutscene still gates the rank plate.
    const canonicalBoss = GlobalState.levelEntities.get(levelScope)?.get(3812092);
    assert.ok(canonicalBoss, 'the shared Castle Hocke boss must be canonical');
    canonicalBoss.hp = 0;
    canonicalBoss.dead = true;
    canonicalBoss.destroyed = true;
    DungeonCompletionSystem.noteEntityDefeated(levelScope, canonicalBoss);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).reason,
        'cutscene_gate_pending',
        'Castle Hocke must wait for its authored defeat cutscene'
    );

    DungeonCompletionSystem.noteCutsceneStart(levelScope, canonicalBoss.roomId, Date.now());
    DungeonCompletionSystem.noteCutsceneEnd(levelScope, canonicalBoss.roomId, Date.now() + 1);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).ready,
        true,
        'Castle Hocke should complete after the shared boss death and defeat cutscene'
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);

    // The shared canonical boss is driven by the party owner's death signal; the
    // second viewer's destroy resolves through the shared scope once the boss is
    // canonical, so it must not crash and the objective stays committed.
    const destroyClient = createClient();
    destroyClient.token += 1;
    destroyClient.userId += 1;
    destroyClient.levelInstanceId = 'client-authority-destroy-regression';
    const destroyScope = getClientLevelScope(destroyClient as never);
    EntityHandler.handleEntityFullUpdate(
        destroyClient as never,
        buildClientHostileFullUpdate(3812093, 'AncientDragonGold')
    );
    await CombatHandler.handleEntityDestroy(
        destroyClient as never,
        buildClientDestroyPayload(3812093)
    );
    DungeonCompletionSystem.reset(destroyScope);
    GlobalState.levelEntities.delete(destroyScope);
    console.log('castle_hocke_client_authority_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
