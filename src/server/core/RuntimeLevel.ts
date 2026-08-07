import type { Character } from '../database/Database';
import { GameData } from './GameData';
import { GlobalState } from './GlobalState';
import type { Client } from './Client';
import { LevelConfig } from './LevelConfig';
import { getScopeLevelName } from './LevelScope';
import { getPartyIdForClient } from './PartySync';

export function clampRuntimeLevel(value: unknown, fallbackLevel: number = 1): number {
    const fallback = Math.max(1, Math.min(50, Math.round(Number(fallbackLevel) || 1)));
    const level = Math.round(Number(value));
    if (!Number.isFinite(level) || level <= 0) {
        return fallback;
    }

    return Math.max(1, Math.min(50, level));
}

export function getCharacterRuntimeLevel(
    character: Partial<Pick<Character, 'level' | 'xp'>> | null | undefined,
    fallbackLevel: number = 1
): number {
    const xpLevel = GameData.getPlayerLevelFromXp(Math.max(0, Number(character?.xp ?? 0)));
    const characterLevel = Math.max(1, Number(character?.level ?? 0));
    const resolvedLevel = xpLevel > 1 ? xpLevel : characterLevel;
    return clampRuntimeLevel(resolvedLevel, fallbackLevel);
}

export function getPartyRuntimeLevelForClient(
    client: Pick<Client, 'character'> | null | undefined,
    fallbackCharacter: Partial<Pick<Character, 'level' | 'xp'>> | null | undefined = client?.character,
    fallbackLevel: number = 1
): number {
    const ownRuntimeLevel = getCharacterRuntimeLevel(fallbackCharacter, fallbackLevel);
    const partyId = getPartyIdForClient(client);
    if (partyId <= 0) {
        return ownRuntimeLevel;
    }

    let maxLevel = ownRuntimeLevel;
    for (const session of GlobalState.sessionsByToken.values()) {
        if (!GlobalState.isSessionOpen(session) || getPartyIdForClient(session) !== partyId) {
            continue;
        }

        maxLevel = Math.max(maxLevel, getCharacterRuntimeLevel(session.character, ownRuntimeLevel));
    }

    return clampRuntimeLevel(maxLevel, ownRuntimeLevel);
}

const scopeRuntimeLevels = new Map<string, number>();

/**
 * The level a scope's hostiles are sized at, resolved once and cached.
 *
 * A dungeon's difficulty is the dungeon's, not the party's. Deriving it from the highest
 * player level in the scope meant the number depended on who the server believed was
 * standing there at that instant -- so a level 22 and a level 50 in one run could be
 * handed two different sets of enemies, and adding a high level player to a party silently
 * re-tuned the dungeon for everyone. The authored tier is fixed per level, so every party
 * member gets the recommended difficulty and gets the same one, in every ordering.
 */
export function getScopeRuntimeLevel(
    levelScope: string | null | undefined,
    joiningClient: Pick<Client, 'character'> | null | undefined,
    fallbackLevel: number = 1
): number {
    const scopeKey = String(levelScope ?? '').trim();

    const authoredLevel = LevelConfig.getAuthoredDungeonEnemyLevel(getScopeLevelName(scopeKey));
    if (authoredLevel > 0) {
        scopeRuntimeLevels.set(scopeKey, authoredLevel);
        return authoredLevel;
    }

    if (!scopeKey) {
        return getPartyRuntimeLevelForClient(joiningClient, joiningClient?.character, fallbackLevel);
    }

    const cached = scopeRuntimeLevels.get(scopeKey);
    if (cached) {
        return cached;
    }

    const runtimeLevel = getPartyRuntimeLevelForClient(joiningClient, joiningClient?.character, fallbackLevel);
    scopeRuntimeLevels.set(scopeKey, runtimeLevel);
    return runtimeLevel;
}
