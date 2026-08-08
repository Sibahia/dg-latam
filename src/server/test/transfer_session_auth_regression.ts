import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { Config } from '../core/config';
import { GlobalState, PendingTransfer } from '../core/GlobalState';
import { TransferTokenAllocator } from '../core/TransferTokenAllocator';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitReader } from '../network/protocol/bitReader';
import { WorldEnter } from '../utils/WorldEnter';

function client(remoteAddress: string, identity: { userId?: number; name?: string; token?: number } = {}): any {
    return {
        socket: { remoteAddress, destroyed: false, readyState: 'open' },
        userId: identity.userId ?? null,
        character: identity.name ? { name: identity.name } : null,
        token: identity.token ?? 0
    };
}

function pending(overrides: Partial<PendingTransfer> = {}): PendingTransfer {
    return {
        character: { name: 'OwnerHero', class: 'Mage', gender: 'Male', level: 1 },
        targetLevel: 'NewbieRoad',
        previousLevel: 'NewbieRoad',
        userId: 17,
        sourceRemoteAddress: '203.0.113.10',
        pendingSince: Date.now(),
        expiresAt: Date.now() + 60_000,
        ...overrides
    };
}

function main(): void {
    const originalMultiplayerMode = Config.MULTIPLAYER_MODE;
    (Config as any).MULTIPLAYER_MODE = true;
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.transferTokenAliases.clear();

    try {
        const allocated = new Set(Array.from({ length: 32 }, () => TransferTokenAllocator.allocate('NewbieRoad')));
        assert.equal(allocated.size, 32, 'CSPRNG transfer tokens should not collide in a focused sample');
        assert.ok([...allocated].some((token) => token > 0xffff), 'allocator should use more than the old 16-bit token space');

        const capabilityToken = 0x10203040;
        const ownerChallenge = TransferTokenAllocator.createLoginChallenge();
        const enterWorld = WorldEnter.buildEnterWorldPacket(
            capabilityToken,
            0,
            ownerChallenge.value,
            false,
            0,
            0,
            'localhost',
            8080,
            'NewbieRoad.swf',
            1,
            1,
            'NewbieRoad',
            '',
            '',
            false,
            false,
            0,
            0,
            null
        );
        const enterReader = new BitReader(enterWorld.toBuffer());
        assert.equal(enterReader.readMethod4(), capabilityToken);
        assert.equal(enterReader.readMethod4(), 0);
        assert.equal(
            enterReader.readMethod13(),
            ownerChallenge.value,
            'enter-world packet should deliver the challenge in the client-echoed transfer field'
        );
        GlobalState.pendingWorld.set(capabilityToken, pending({ loginChallengeHash: ownerChallenge.hash }));
        assert.equal(
            Object.values(GlobalState.pendingWorld.get(capabilityToken)!).includes(ownerChallenge.value),
            false,
            'pending transfer must store only the challenge hash'
        );
        const attacker = client('203.0.113.10');
        assert.equal(
            (CharacterHandler as any).resolvePendingGameLogin(attacker, capabilityToken, 'b'.repeat(64)),
            null,
            'a same-NAT caller with only the 32-bit token must not claim a pending login'
        );
        assert.equal(attacker.userId, null, 'rejected token must not copy account identity');
        assert.equal(attacker.character, null, 'rejected token must not copy character identity');

        const owner = client('198.51.100.77');
        const claimed = (CharacterHandler as any).resolvePendingGameLogin(
            owner,
            capabilityToken,
            ownerChallenge.value
        );
        assert.equal(claimed?.entry.userId, 17, 'the challenge holder may claim after an address change');
        assert.equal(
            (CharacterHandler as any).resolvePendingGameLogin(
                client('203.0.113.10'),
                capabilityToken,
                ownerChallenge.value
            ),
            null,
            'a claimed token must not be consumed concurrently by another client'
        );

        const expiredToken = 0x10203041;
        const expiredChallenge = TransferTokenAllocator.createLoginChallenge();
        GlobalState.pendingWorld.set(expiredToken, pending({
            expiresAt: Date.now() - 1,
            loginChallengeHash: expiredChallenge.hash
        }));
        assert.equal(
            (CharacterHandler as any).resolvePendingGameLogin(owner, expiredToken, expiredChallenge.value),
            null,
            'expired transfer must fail'
        );
        assert.equal(GlobalState.pendingWorld.has(expiredToken), false, 'expired transfer should be purged');

        const victimToken = 0x10203042;
        const victimSession = client('203.0.113.20', { userId: 99, name: 'VictimHero', token: victimToken });
        GlobalState.sessionsByToken.set(victimToken, victimSession);
        const unauthenticated = client('203.0.113.20');
        assert.equal(
            (LevelHandler as any).recoverTransferSessionState(unauthenticated, victimToken),
            null,
            'level transfer recovery must not bootstrap identity from an active token'
        );
        assert.equal(unauthenticated.userId, null);
        assert.equal(unauthenticated.character, null);

        const unrelated = client('203.0.113.30', { userId: 100, name: 'OtherHero', token: 0x10203043 });
        GlobalState.sessionsByToken.set(unrelated.token, unrelated);
        assert.equal(
            (LevelHandler as any).recoverTransferSessionState(unrelated, victimToken),
            null,
            'an authenticated client must not recover another session token'
        );
        assert.deepEqual(unrelated.character, { name: 'OtherHero' }, 'rejected recovery must preserve caller identity');

        assert.deepEqual(
            (LevelHandler as any).recoverTransferSessionState(victimSession, victimToken),
            { resolvedToken: victimToken, source: 'authenticated-client' },
            'the authoritative owner should retain normal level transfer behavior'
        );

        console.log('transfer_session_auth_regression: ok');
    } finally {
        (Config as any).MULTIPLAYER_MODE = originalMultiplayerMode;
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.transferTokenAliases.clear();
    }
}

main();
