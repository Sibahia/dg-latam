import * as crypto from 'crypto';
import { GlobalState } from './GlobalState';
import { LevelConfig } from './LevelConfig';
import { getScopeLevelName } from './LevelScope';

export class TransferTokenAllocator {
    // The legacy packet field supports at most 32 bits. Use the complete field
    // with a CSPRNG and bind/expire the pending transfer separately.
    private static readonly TOKEN_SPACE_SIZE = 0x100000000;
    private static readonly RANDOM_ATTEMPTS = 1024;

    static createLoginChallenge(): { value: string; hash: string } {
        const value = crypto.randomBytes(32).toString('hex');
        return {
            value,
            hash: crypto.createHash('sha256').update(value, 'utf8').digest('hex')
        };
    }

    static verifyLoginChallenge(expectedHash: string | null | undefined, value: string | null | undefined): boolean {
        const normalizedHash = String(expectedHash ?? '').trim().toLowerCase();
        const presentedValue = String(value ?? '');
        if (!/^[0-9a-f]{64}$/.test(normalizedHash) || !/^[0-9a-f]{64}$/.test(presentedValue)) {
            return false;
        }
        const actualHash = crypto.createHash('sha256').update(presentedValue, 'utf8').digest();
        const expected = Buffer.from(normalizedHash, 'hex');
        return expected.length === actualHash.length && crypto.timingSafeEqual(expected, actualHash);
    }

    private static normalizeTargetLevel(targetLevel: string | null | undefined): string {
        return LevelConfig.normalizeLevelName(String(targetLevel ?? '')) || String(targetLevel ?? '');
    }

    private static collectBlockedIds(targetLevel: string | null | undefined): Set<number> {
        const blockedIds = new Set<number>([0]);
        const normalizedTargetLevel = TransferTokenAllocator.normalizeTargetLevel(targetLevel);

        for (const token of GlobalState.pendingWorld.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.pendingExtended.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.usedTransferTokens.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.sessionsByToken.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.tokenChar.keys()) {
            blockedIds.add(token);
        }
        for (const token of GlobalState.pendingTeleports.keys()) {
            blockedIds.add(token);
        }
        for (const [aliasToken, targetToken] of GlobalState.transferTokenAliases.entries()) {
            blockedIds.add(aliasToken);
            blockedIds.add(targetToken);
        }

        if (!normalizedTargetLevel) {
            return blockedIds;
        }

        for (const [scopeKey, levelMap] of GlobalState.levelEntities.entries()) {
            if (getScopeLevelName(scopeKey) !== normalizedTargetLevel) {
                continue;
            }
            for (const entityId of levelMap.keys()) {
                if (entityId > 0) {
                    blockedIds.add(entityId);
                }
            }
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            const sessionLevel = TransferTokenAllocator.normalizeTargetLevel(session.currentLevel);
            if (sessionLevel !== normalizedTargetLevel) {
                continue;
            }
            if (session.clientEntID > 0) {
                blockedIds.add(session.clientEntID);
            }
        }

        return blockedIds;
    }

    static allocate(targetLevel: string | null | undefined): number {
        const blockedIds = TransferTokenAllocator.collectBlockedIds(targetLevel);
        for (let attempt = 0; attempt < TransferTokenAllocator.RANDOM_ATTEMPTS; attempt++) {
            const candidate = crypto.randomInt(1, TransferTokenAllocator.TOKEN_SPACE_SIZE);
            if (candidate > 0 && !blockedIds.has(candidate)) {
                return candidate;
            }
        }

        const normalizedTargetLevel = TransferTokenAllocator.normalizeTargetLevel(targetLevel) || '(unknown level)';
        throw new Error(`[TransferTokenAllocator] No free transfer token available for ${normalizedTargetLevel}`);
    }
}
