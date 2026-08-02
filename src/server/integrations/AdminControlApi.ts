import type express from 'express';
import { StaticServer } from '../core/StaticServer';
import { GlobalState } from '../core/GlobalState';
import { AdminRuntimeSettings } from '../core/AdminRuntimeSettings';
import { DiscordAdminRateLimiter, requireAdminAuthorization } from './DiscordMaintenanceApi';
import { getClientLevelScope } from '../core/LevelScope';
import { EntityState, EntityTeam } from '../core/Entity';
import { getRoomBossAwareRoomId } from '../core/RoomBossState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { CombatHandler } from '../handlers/CombatHandler';
import { MovementAuthority } from '../core/MovementAuthority';
import { JsonAdapter } from '../database/JsonAdapter';
import type { Character } from '../database/Database';
import { upsertInventoryGear } from '../utils/GearInventory';
import { RewardHandler } from '../handlers/RewardHandler';
import { PetHandler } from '../handlers/PetHandler';
import { PetConfig } from '../core/PetConfig';
import { GameData } from '../core/GameData';
import { getActivePotionBonuses } from '../utils/ConsumableState';
import { ensureSigilStoreAlertState } from '../utils/AlertState';
import { EntityHandler } from '../handlers/EntityHandler';
import { LockboxHandler } from '../handlers/LockboxHandler';
import { normalizeCharacterKey, PartyGroup } from '../core/SocialState';

const registeredApps = new WeakSet<express.Application>();
const grantDb = new JsonAdapter();

type GearCatalogItem = { id: number; name: string; displayName: string; type: string; rarity: string; usedBy: string };

let mongoGearCache: GearCatalogItem[] | null = null;
let mongoGearCacheAt = 0;
const MONGO_GEAR_CACHE_TTL_MS = 60_000;

type CharacterStore = Pick<JsonAdapter, 'loadCharacters' | 'saveCharacterSnapshot' | 'saveCharacters' | 'isCharacterNameTaken' | 'getAccountIdByCharName'>;

async function loadMongoGearCatalog(): Promise<GearCatalogItem[] | null> {
    const now = Date.now();
    if (mongoGearCache && now - mongoGearCacheAt < MONGO_GEAR_CACHE_TTL_MS) {
        return mongoGearCache;
    }
    try {
        const entries = await grantDb.getGearCatalog();
        mongoGearCache = Array.isArray(entries) && entries.length > 0 ? entries as GearCatalogItem[] : null;
        mongoGearCacheAt = now;
    } catch {
        mongoGearCache = null;
        mongoGearCacheAt = now;
    }
    return mongoGearCache;
}

function activeSessions() {
    return [...GlobalState.sessionsByToken.values()]
        .filter((session) => session.playerSpawned && GlobalState.isClientConnectionOpen(session));
}

function countRoomHostiles(levelScope: string, roomId: number): number {
    const hostileIds = new Set<number>();
    const collect = (entity: any): void => {
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const dead = Boolean(entity?.dead) || Boolean(entity?.destroyed) ||
            Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
            (Number.isFinite(Number(entity?.hp)) && Number(entity.hp) <= 0);
        if (
            entityId > 0 &&
            entity &&
            !entity.isPlayer &&
            Number(entity.team ?? 0) === EntityTeam.ENEMY &&
            getRoomBossAwareRoomId(entity) === roomId &&
            !dead
        ) {
            hostileIds.add(entityId);
        }
    };
    for (const entity of GlobalState.levelEntities.get(levelScope)?.values() ?? []) {
        collect(entity);
    }
    for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
        for (const entity of session.entities.values()) {
            collect(entity);
        }
    }
    return hostileIds.size;
}

export function buildAdminSnapshot() {
    const sessions = activeSessions();
    const rooms = new Map<string, {
        key: string;
        levelScope: string;
        level: string;
        roomId: number;
        players: number;
        hostiles: number;
    }>();

    const players = sessions.map((session) => {
        const levelScope = getClientLevelScope(session);
        const roomId = Math.round(Number(session.currentRoomId ?? -1));
        const roomKey = `${levelScope}:${roomId}`;
        const room = rooms.get(roomKey) ?? {
            key: roomKey,
            levelScope,
            level: session.currentLevel,
            roomId,
            players: 0,
            hostiles: countRoomHostiles(levelScope, roomId)
        };
        room.players += 1;
        rooms.set(roomKey, room);

        return {
            token: session.token,
            userId: session.userId,
            name: String(session.character?.name ?? ''),
            className: String(session.character?.class ?? ''),
            level: session.currentLevel,
            levelScope,
            roomId,
            partyId: GlobalState.partyByMember.get(String(session.character?.name ?? '').trim().toLowerCase()) ?? 0,
            hp: Math.max(0, Math.round(Number(session.authoritativeCurrentHp ?? 0))),
            maxHp: Math.max(1, Math.round(Number(session.authoritativeMaxHp ?? 1))),
            speedMultiplier: Number((session as unknown as { movementSpeedMultiplier?: number }).movementSpeedMultiplier ?? 1),
            connectedAt: session.playSessionStartedAt
        };
    });

    return {
        ok: true,
        generatedAt: Date.now(),
        uptimeSeconds: Math.round(process.uptime()),
        connections: GlobalState.clients.size,
        onlinePlayers: players.length,
        settings: AdminRuntimeSettings.snapshot,
        players,
        rooms: [...rooms.values()].sort((a, b) => a.level.localeCompare(b.level) || a.roomId - b.roomId)
    };
}

function sendSpeed(session: ReturnType<typeof activeSessions>[number], multiplier: number): void {
    (session as unknown as { movementSpeedMultiplier: number }).movementSpeedMultiplier = multiplier;
    const entity = session.entities.get(session.clientEntID);
    if (entity && typeof entity === 'object') {
        entity.behaviorSpeedMod = multiplier;
    }
    MovementAuthority.resetFromEntity(session, entity, 'admin_speed_change');
    if (session.clientEntID > 0) {
        const payload = new BitBuffer(false);
        payload.writeMethod4(session.clientEntID);
        payload.writeMethod4(Math.round(multiplier * 10_000));
        session.sendBitBuffer(0x8A, payload);
    }
}

function healSession(session: ReturnType<typeof activeSessions>[number]): number {
    const maxHp = Math.max(1, Math.round(Number(session.authoritativeMaxHp ?? 1)));
    const currentHp = Math.max(0, Math.min(maxHp, Math.round(Number(session.authoritativeCurrentHp ?? maxHp))));
    const healed = maxHp - currentHp;
    session.authoritativeCurrentHp = maxHp;
    const entity = session.entities.get(session.clientEntID);
    if (entity && typeof entity === 'object') {
        entity.maxHp = maxHp;
        entity.hp = maxHp;
        entity.dead = false;
        entity.entState = EntityState.ACTIVE;
    }
    if (healed > 0 && session.clientEntID > 0) {
        const payload = new BitBuffer(false);
        payload.writeMethod4(session.clientEntID);
        payload.writeMethod45(healed);
        session.sendBitBuffer(0x78, payload);
    }
    return healed;
}

function escapeHtml(value: string): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function broadcastAnnouncement(message: string): number {
    let recipients = 0;
    for (const session of activeSessions()) {
        const payload = new BitBuffer(false);
        payload.writeMethod13(message);
        session.sendBitBuffer(0x44, payload);
        recipients += 1;
    }
    return recipients;
}

function normalizeGrantCharacterName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

const GRANT_SCALAR_FIELDS = ['gold', 'mammothIdols', 'xp', 'level', 'SilverSigils', 'DragonOre', 'DragonKeys'] as const;
const GRANT_ARRAY_FIELDS = ['mounts', 'pets', 'consumables', 'inventoryGears', 'lockboxes'] as const;

function snapshotGrantFields(character: Character): Partial<Character> {
    const snapshot: Partial<Character> = {};
    for (const key of GRANT_SCALAR_FIELDS) {
        snapshot[key] = character[key];
    }
    for (const key of GRANT_ARRAY_FIELDS) {
        snapshot[key] = Array.isArray(character[key])
            ? (character[key] as unknown[]).map((item) => (
                item && typeof item === 'object' ? { ...(item as Record<string, unknown>) } : item
            ))
            : undefined;
    }
    return snapshot;
}

function restoreGrantFields(character: Character, snapshot: Partial<Character>): void {
    for (const key of [...GRANT_SCALAR_FIELDS, ...GRANT_ARRAY_FIELDS]) {
        if (snapshot[key] !== undefined) {
            character[key] = snapshot[key];
        }
    }
}

async function mutateCharacterValue(
    userId: number,
    characterName: string,
    apply: (character: Character) => { before: number; after: number; applied: boolean },
    notify: (session: ReturnType<typeof activeSessions>[number]) => void,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; applied: boolean; onlineRecipients: number } | null> {
    const normalizedName = normalizeGrantCharacterName(characterName);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !normalizedName) {
        return null;
    }

    const accountSessions = GlobalState.getActiveSessionsByUserId(userId).filter((session) =>
        GlobalState.isClientConnectionOpen(session)
    );
    const targetSessions = accountSessions.filter((session) =>
        normalizeGrantCharacterName(session.character?.name) === normalizedName
    );
    const storedCharacters = await store.loadCharacters(userId);
    const authoritativeCharacter = targetSessions[0]?.character ?? storedCharacters.find((character) =>
        normalizeGrantCharacterName(character?.name) === normalizedName
    );
    if (!authoritativeCharacter) {
        return null;
    }

    const mutatedCharacters = new Map<Character, Partial<Character>>();
    mutatedCharacters.set(authoritativeCharacter, snapshotGrantFields(authoritativeCharacter));
    let outcome = apply(authoritativeCharacter);
    const applyToCopy = (character: Character | null | undefined): void => {
        if (!character || character === authoritativeCharacter) {
            return;
        }
        if (normalizeGrantCharacterName(character.name) !== normalizedName) {
            return;
        }
        if (!mutatedCharacters.has(character)) {
            mutatedCharacters.set(character, snapshotGrantFields(character));
        }
        apply(character);
    };

    for (const session of accountSessions) {
        applyToCopy(session.character);
        const listedCharacter = session.characters.find((character) =>
            normalizeGrantCharacterName(character?.name) === normalizedName
        );
        applyToCopy(listedCharacter);
    }

    if (!outcome.applied) {
        for (const [character, previous] of mutatedCharacters) {
            restoreGrantFields(character, previous);
        }
        return { before: outcome.before, after: outcome.after, applied: false, onlineRecipients: 0 };
    }

    let savedCharacters: Character[];
    try {
        savedCharacters = await store.saveCharacterSnapshot(userId, {
            ...authoritativeCharacter
        });
    } catch (error) {
        for (const [character, previous] of mutatedCharacters) {
            restoreGrantFields(character, previous);
        }
        throw error;
    }

    for (const session of accountSessions) {
        session.characters = savedCharacters;
    }
    for (const session of targetSessions) {
        notify(session);
    }

    return { before: outcome.before, after: outcome.after, applied: true, onlineRecipients: targetSessions.length };
}

function sendGoldRewardPacket(session: ReturnType<typeof activeSessions>[number], amount: number): void {
    RewardHandler.sendGoldReward(session, amount, false);
}

function sendGearRewardPacket(session: ReturnType<typeof activeSessions>[number], gearId: number, tier: number): void {
    if (session.clientEntID <= 0) {
        return;
    }
    const bb = new BitBuffer(false);
    bb.writeMethod6(gearId, 11);
    bb.writeMethod6(Math.max(1, Math.min(2, Math.round(tier))), 2);
    session.sendBitBuffer(0x33, bb);
}

function sendXpRewardPacket(session: ReturnType<typeof activeSessions>[number], amount: number): void {
    if (session.clientEntID <= 0 || amount <= 0) {
        return;
    }
    const bb = new BitBuffer(false);
    bb.writeMethod4(Math.round(amount));
    session.sendBitBuffer(0x2B, bb);
}

function sendMountRewardPacket(session: ReturnType<typeof activeSessions>[number], mountId: number): void {
    if (session.clientEntID <= 0) {
        return;
    }
    const bb = new BitBuffer(false);
    bb.writeMethod4(mountId);
    bb.writeMethod15(false);
    session.sendBitBuffer(0x36, bb);
}

function sendNewPetRewardPacket(
    session: ReturnType<typeof activeSessions>[number],
    petTypeId: number,
    specialId: number,
    level: number
): void {
    if (session.clientEntID <= 0) {
        return;
    }
    const bb = new BitBuffer(false);
    bb.writeMethod6(petTypeId, 7);
    bb.writeMethod4(specialId);
    bb.writeMethod6(level, 6);
    bb.writeMethod15(false);
    session.sendBitBuffer(0x37, bb);
}

function sendConsumableRewardPacket(
    session: ReturnType<typeof activeSessions>[number],
    consumableId: number,
    amount: number,
    newTotal: number
): void {
    if (session.clientEntID <= 0) {
        return;
    }
    const update = new BitBuffer(false);
    update.writeMethod6(consumableId, 5);
    update.writeMethod4(newTotal);
    session.sendBitBuffer(0x10C, update);

    const consumableDef = GameData.CONSUMABLES.find((consumable) => Number(consumable?.ConsumableID ?? 0) === consumableId);
    const displayAmount = String(consumableDef?.Type ?? '') === 'Potion' ? amount * 5000 : amount;

    const reward = new BitBuffer(false);
    reward.writeMethod6(consumableId, 5);
    reward.writeMethod4(displayAmount);
    reward.writeMethod15(false);
    session.sendBitBuffer(0x10B, reward);
}

function sendMammothIdolUpdatePacket(session: ReturnType<typeof activeSessions>[number]): void {
    if (session.clientEntID <= 0) {
        return;
    }
    const bb = new BitBuffer(false);
    bb.writeMethod4(Number(session.character?.mammothIdols ?? 0));
    bb.writeMethod4(0);
    bb.writeMethod11(session.character?.showHigher ? 1 : 0, 1);
    session.sendBitBuffer(0xA1, bb);
}

function sendSilverSigilRewardPacket(session: ReturnType<typeof activeSessions>[number], amount: number): void {
    if (session.clientEntID <= 0 || amount <= 0) {
        return;
    }
    const bb = new BitBuffer(false);
    bb.writeMethod4(Math.round(amount));
    session.sendBitBuffer(0x112, bb);
}

async function grantGoldToCharacter(
    userId: number,
    characterName: string,
    amount: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Math.max(0, Math.round(Number(character.gold ?? 0)));
            character.gold = before + Math.max(1, Math.round(amount));
            return { before, after: character.gold, applied: true };
        },
        (session) => sendGoldRewardPacket(session, amount),
        store
    );
    return result && result.applied
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : result && !result.applied ? { before: result.before, after: result.after, onlineRecipients: 0 } : null;
}

async function grantGearToCharacter(
    userId: number,
    characterName: string,
    gearId: number,
    tier: number,
    runes: number[],
    colors: number[],
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Array.isArray(character.inventoryGears) ? character.inventoryGears.length : 0;
            const upserted = upsertInventoryGear(character, gearId, tier, runes, colors);
            const after = Array.isArray(character.inventoryGears) ? character.inventoryGears.length : 0;
            return { before, after, applied: upserted.inserted };
        },
        (session) => sendGearRewardPacket(session, gearId, tier),
        store
    );
    return result
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : null;
}

async function grantXpToCharacter(
    userId: number,
    characterName: string,
    amount: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; granted: number; level: number; onlineRecipients: number } | null> {
    let granted = 0;
    let previousLevel = 1;
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const base = Math.max(1, Math.round(Number(amount)));
            const petBonuses = PetHandler.getEquippedPetBonusRates(character);
            const potionBonuses = getActivePotionBonuses(character, null);
            const multiplier = 1 + petBonuses.expBonus + potionBonuses.expBonus;
            granted = Math.max(1, Math.round(base * multiplier));
            previousLevel = Math.max(1, Math.round(Number(character.level ?? 1)));
            const before = Math.max(0, Math.round(Number(character.xp ?? 0)));
            character.xp = before + granted;
            character.level = GameData.getPlayerLevelFromXp(Number(character.xp ?? 0));
            return { before, after: character.xp, applied: true };
        },
        (session) => {
            sendXpRewardPacket(session, granted);
            if (Math.max(1, Math.round(Number(session.character?.level ?? 1))) !== previousLevel) {
                EntityHandler.refreshPlayerSnapshot(session);
            }
        },
        store
    );
    return result
        ? {
            before: result.before,
            after: result.after,
            granted,
            level: previousLevel,
            onlineRecipients: result.onlineRecipients
        }
        : null;
}

async function grantMammothCoinsToCharacter(
    userId: number,
    characterName: string,
    amount: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Math.max(0, Math.round(Number(character.mammothIdols ?? 0)));
            character.mammothIdols = before + Math.max(1, Math.round(Number(amount)));
            return { before, after: character.mammothIdols, applied: true };
        },
        (session) => sendMammothIdolUpdatePacket(session),
        store
    );
    return result
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : null;
}

async function grantMountToCharacter(
    userId: number,
    characterName: string,
    mountId: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    let grantedMountId = 0;
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Array.isArray(character.mounts) ? character.mounts.length : 0;
            const normalized = Math.round(Number(mountId));
            if (normalized <= 0) {
                return { before, after: before, applied: false };
            }
            if (!Array.isArray(character.mounts)) {
                character.mounts = [];
            }
            if (character.mounts.includes(normalized)) {
                return { before, after: character.mounts.length, applied: false };
            }
            character.mounts.push(normalized);
            grantedMountId = normalized;
            return { before, after: character.mounts.length, applied: true };
        },
        (session) => sendMountRewardPacket(session, grantedMountId),
        store
    );
    return result
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : null;
}

async function grantPetToCharacter(
    userId: number,
    characterName: string,
    petTypeId: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; petTypeId: number; specialId: number; onlineRecipients: number } | null> {
    let grantedPetTypeId = 0;
    let grantedSpecialId = 0;
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Array.isArray(character.pets) ? character.pets.length : 0;
            const normalized = Math.round(Number(petTypeId));
            if (normalized <= 0) {
                return { before, after: before, applied: false };
            }
            const pets = Array.isArray(character.pets) ? character.pets : [];
            const nextSpecialId = pets.reduce((max: number, pet: any) => {
                return Math.max(max, Number(pet?.special_id ?? 0));
            }, 0) + 1;
            pets.push({ typeID: normalized, special_id: nextSpecialId, level: 1, xp: 0 });
            character.pets = pets;
            grantedPetTypeId = normalized;
            grantedSpecialId = nextSpecialId;
            return { before, after: character.pets.length, applied: true };
        },
        (session) => sendNewPetRewardPacket(session, grantedPetTypeId, grantedSpecialId, 1),
        store
    );
    return result
        ? {
            before: result.before,
            after: result.after,
            petTypeId: grantedPetTypeId,
            specialId: grantedSpecialId,
            onlineRecipients: result.onlineRecipients
        }
        : null;
}

async function grantConsumableToCharacter(
    userId: number,
    characterName: string,
    consumableId: number,
    quantity: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; consumableId: number; quantity: number; onlineRecipients: number } | null> {
    let grantedConsumableId = 0;
    let grantedQuantity = 0;
    let grantedNewTotal = 0;
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Array.isArray(character.consumables) ? character.consumables.length : 0;
            const id = Math.round(Number(consumableId));
            const qty = Math.max(1, Math.round(Number(quantity)));
            if (id <= 0) {
                return { before, after: before, applied: false };
            }
            if (!Array.isArray(character.consumables)) {
                character.consumables = [];
            }
            const entry = character.consumables.find((consumable: any) => Number(consumable?.consumableID ?? 0) === id);
            const newTotal = entry ? Number(entry.count ?? 0) + qty : qty;
            if (entry) {
                entry.count = newTotal;
            } else {
                character.consumables.push({ consumableID: id, count: qty });
            }
            grantedConsumableId = id;
            grantedQuantity = qty;
            grantedNewTotal = newTotal;
            return { before, after: character.consumables.length, applied: true };
        },
        (session) => sendConsumableRewardPacket(session, grantedConsumableId, grantedQuantity, grantedNewTotal),
        store
    );
    return result
        ? {
            before: result.before,
            after: result.after,
            consumableId: grantedConsumableId,
            quantity: grantedQuantity,
            onlineRecipients: result.onlineRecipients
        }
        : null;
}

async function grantSilverSigilsToCharacter(
    userId: number,
    characterName: string,
    amount: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Math.max(0, Math.round(Number(character.SilverSigils ?? 0)));
            character.SilverSigils = before + Math.max(1, Math.round(Number(amount)));
            ensureSigilStoreAlertState(character);
            return { before, after: character.SilverSigils, applied: true };
        },
        (session) => sendSilverSigilRewardPacket(session, Math.max(1, Math.round(Number(amount)))),
        store
    );
    return result
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : null;
}

async function grantDragonResourceToCharacter(
    userId: number,
    characterName: string,
    field: 'DragonOre' | 'DragonKeys',
    amount: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = Math.max(0, Math.round(Number(character[field] ?? 0)));
            character[field] = before + Math.max(1, Math.round(Number(amount)));
            return { before, after: character[field], applied: true };
        },
        () => undefined,
        store
    );
    return result
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : null;
}

async function grantTrovesToCharacter(
    userId: number,
    characterName: string,
    amount: number,
    store: CharacterStore = grantDb
): Promise<{ before: number; after: number; onlineRecipients: number } | null> {
    const result = await mutateCharacterValue(
        userId,
        characterName,
        (character) => {
            const before = LockboxHandler.addLockboxesToCharacter(
                character,
                LockboxHandler.TROVE_LOCKBOX_ID,
                0
            );
            LockboxHandler.addLockboxesToCharacter(character, LockboxHandler.TROVE_LOCKBOX_ID, Math.max(1, Math.round(Number(amount))));
            const after = LockboxHandler.addLockboxesToCharacter(
                character,
                LockboxHandler.TROVE_LOCKBOX_ID,
                0
            );
            return { before, after, applied: after > before };
        },
        (session) => LockboxHandler.sendLockboxInventoryDeltaToClient(session, LockboxHandler.TROVE_LOCKBOX_ID, Math.max(1, Math.round(Number(amount)))),
        store
    );
    return result
        ? { before: result.before, after: result.after, onlineRecipients: result.onlineRecipients }
        : null;
}

class RenameConflictError extends Error {}

async function renameCharacter(
    userId: number,
    characterName: string,
    newName: string,
    store: CharacterStore = grantDb
): Promise<{ onlineRecipients: number } | null> {
    const normalizedOldName = normalizeGrantCharacterName(characterName);
    const normalizedNewName = normalizeGrantCharacterName(newName);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !normalizedOldName || !normalizedNewName) {
        return null;
    }
    if (normalizedOldName === normalizedNewName) {
        throw new RenameConflictError('The new name is identical to the current name.');
    }
    if (await store.isCharacterNameTaken(newName)) {
        throw new RenameConflictError('Character name is already taken.');
    }

    const accountSessions = GlobalState.getActiveSessionsByUserId(userId).filter((session) =>
        GlobalState.isClientConnectionOpen(session)
    );
    const targetSessions = accountSessions.filter((session) =>
        normalizeGrantCharacterName(session.character?.name) === normalizedOldName
    );

    const characters = await store.loadCharacters(userId);
    let index = characters.findIndex((character) =>
        normalizeGrantCharacterName(character?.name) === normalizedOldName
    );
    if (index < 0) {
        if (targetSessions.length === 0) {
            return null;
        }
        characters.push({ ...targetSessions[0].character } as Character);
        index = characters.length - 1;
    }
    characters[index] = { ...characters[index], name: newName };

    for (const session of targetSessions) {
        if (session.character) {
            session.character.name = newName;
        }
        for (const listedCharacter of session.characters) {
            if (normalizeGrantCharacterName(listedCharacter?.name) === normalizedOldName) {
                listedCharacter.name = newName;
            }
        }
    }

    try {
        await store.saveCharacters(userId, characters);
    } catch (error) {
        for (const session of targetSessions) {
            if (session.character) {
                session.character.name = characterName;
            }
            for (const listedCharacter of session.characters) {
                if (normalizeGrantCharacterName(listedCharacter?.name) === normalizedNewName) {
                    listedCharacter.name = characterName;
                }
            }
        }
        throw error;
    }

    const savedCharacters = await store.loadCharacters(userId);
    for (const session of accountSessions) {
        session.characters = savedCharacters;
    }

    const oldKey = normalizeCharacterKey(characterName);
    const newKey = normalizeCharacterKey(newName);
    for (const session of targetSessions) {
        if (oldKey && GlobalState.sessionsByCharacterName.get(oldKey) === session) {
            GlobalState.sessionsByCharacterName.delete(oldKey);
        }
        if (newKey) {
            GlobalState.sessionsByCharacterName.set(newKey, session);
        }
    }
    if (oldKey && newKey && oldKey !== newKey) {
        const partyId = GlobalState.partyByMember.get(oldKey);
        if (partyId) {
            GlobalState.partyByMember.delete(oldKey);
            GlobalState.partyByMember.set(newKey, partyId);
        }
        const group = GlobalState.partyGroups.get(partyId ?? 0);
        if (group) {
            const renamedMembers = group.members.map((member) =>
                normalizeCharacterKey(member) === oldKey ? newName : member
            );
            group.members = renamedMembers;
            if (normalizeCharacterKey(group.leader) === oldKey) {
                group.leader = newName;
            }
            GlobalState.partyGroups.set(group.id, group);
        }
        GlobalState.refreshSessionIndexesByCharacterName(newName);
    }

    return { onlineRecipients: targetSessions.length };
}

async function buildGearCatalog(): Promise<Array<{ id: number; name: string; displayName: string; type: string; rarity: string; usedBy: string }>> {
    // Prefer the Mongo-backed catalog (seeded from the committed gear_catalog.json)
    // so the "Equipo" dropdown is populated even when the XML isn't available.
    const mongoCatalog = await loadMongoGearCatalog();
    if (mongoCatalog && mongoCatalog.length > 0) {
        return mongoCatalog;
    }

    const details = (GameData.GEAR_DATA as unknown as {
        all_gear_details?: Record<string, Array<{ name?: string; type?: string; rarity?: string; realm?: string | null }>>;
    }).all_gear_details;
    if (!details || typeof details !== 'object') {
        return [];
    }

    const seen = new Map<number, { id: number; name: string; displayName: string; type: string; rarity: string; usedBy: string }>();
    for (const rawId of Object.keys(details)) {
        const id = Number(rawId);
        if (!Number.isSafeInteger(id) || id <= 0) {
            continue;
        }
        const variants = details[rawId];
        const base = Array.isArray(variants)
            ? variants.find((variant) => !variant?.realm) ?? variants[0]
            : null;
        if (!base) {
            continue;
        }
        const name = String(base.name ?? '').trim();
        if (!name) {
            continue;
        }
        if (!seen.has(id)) {
            const meta = GameData.getGearMetaById(id);
            seen.set(id, {
                id,
                name,
                displayName: meta?.displayName || name,
                type: String(base.type ?? ''),
                rarity: String(base.rarity ?? ''),
                usedBy: meta?.usedBy ?? ''
            });
        }
    }

    return [...seen.values()].sort((a, b) => a.id - b.id);
}

export function registerAdminControlApi(staticServer: StaticServer): void {
    const app = (staticServer as unknown as { app: express.Application }).app;
    if (registeredApps.has(app)) {
        return;
    }
    registeredApps.add(app);

    const authorize = requireAdminAuthorization(new DiscordAdminRateLimiter());
    app.get('/api/admin/control/snapshot', authorize, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(buildAdminSnapshot());
    });

    app.get('/api/admin/control/events', authorize, (req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const publish = (): void => {
            res.write(`event: snapshot\ndata: ${JSON.stringify(buildAdminSnapshot())}\n\n`);
        };
        publish();
        const interval = setInterval(publish, 1_000);
        req.on('close', () => clearInterval(interval));
    });

    app.patch('/api/admin/control/settings', authorize, (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
            const settings = AdminRuntimeSettings.update(body);
            for (const session of activeSessions()) {
                sendSpeed(session, settings.playerSpeedMultiplier);
            }
            console.log(`[AdminPanel] Runtime settings updated revision=${settings.revision}.`);
            res.json({ ok: true, settings });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid settings.' });
        }
    });

    app.post('/api/admin/control/reset', authorize, (_req, res) => {
        const settings = AdminRuntimeSettings.reset();
        for (const session of activeSessions()) {
            sendSpeed(session, settings.playerSpeedMultiplier);
        }
        res.json({ ok: true, settings });
    });

    app.post('/api/admin/control/action', authorize, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const action = String(body.action ?? '').trim();
        const token = Math.max(0, Math.round(Number(body.token ?? 0)));
        const target = token > 0 ? GlobalState.sessionsByToken.get(token) : null;

        if (action === 'kill-room') {
            if (!target || !target.playerSpawned) {
                res.status(404).json({ error: 'Target player session was not found.' });
                return;
            }
            const result = CombatHandler.adminDefeatRoomHostiles(target, Number(body.roomId ?? target.currentRoomId));
            console.log(`[AdminPanel] Defeated ${result.defeated} hostile(s) in ${target.currentLevel} room ${result.roomId}.`);
            res.json({ ok: true, ...result });
            return;
        }

        if (action === 'heal-player' || action === 'heal-all') {
            const targets = action === 'heal-all' ? activeSessions() : target ? [target] : [];
            if (targets.length === 0) {
                res.status(404).json({ error: 'No matching online player was found.' });
                return;
            }
            const healed = targets.reduce((total, session) => total + healSession(session), 0);
            res.json({ ok: true, players: targets.length, healed });
            return;
        }

        if (action === 'kick-player') {
            if (!target) {
                res.status(404).json({ error: 'Target player session was not found.' });
                return;
            }
            const name = String(target.character?.name ?? target.token);
            target.socket.end();
            setTimeout(() => target.socket.destroy(), 250).unref();
            console.log(`[AdminPanel] Disconnected ${name}.`);
            res.json({ ok: true, name });
            return;
        }

        if (action === 'announce') {
            const message = String(body.message ?? '').trim().slice(0, 240);
            if (!message) {
                res.status(400).json({ error: 'Announcement message is required.' });
                return;
            }
            const recipients = broadcastAnnouncement(`[ADMIN] ${message}`);
            res.json({ ok: true, recipients });
            return;
        }

        res.status(400).json({ error: 'Unknown admin action.' });
    });

    app.get('/api/admin/control/catalog', authorize, async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const mounts = Object.entries(GameData.MOUNT_IDS)
            .filter(([, id]) => Number(id) > 0)
            .map(([name, id]) => ({ id: Number(id), name }))
            .sort((a, b) => a.id - b.id);
        const pets = PetConfig.PET_TYPES
            .filter((pet) => Number(pet?.PetID ?? 0) > 0)
            .map((pet) => ({
                id: Number(pet.PetID),
                name: String(pet.PetName ?? ''),
                displayName: String(pet.DisplayName ?? '')
            }))
            .sort((a, b) => a.id - b.id);
        const consumables = GameData.CONSUMABLES
            .filter((consumable) => Number(consumable?.ConsumableID ?? 0) > 0)
            .map((consumable) => ({
                id: Number(consumable.ConsumableID),
                name: String(consumable.ConsumableName ?? ''),
                displayName: String(consumable.DisplayName ?? '')
            }))
            .sort((a, b) => a.id - b.id);
        res.json({
            ok: true,
            mounts,
            pets,
            consumables,
            gear: await buildGearCatalog()
        });
    });

    app.post('/api/admin/control/grant', authorize, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const body = req.body && typeof req.body === 'object'
            ? req.body as Record<string, unknown>
            : {};
        const userId = Number(body.userId);
        const characterName = String(body.characterName ?? '').trim();
        const kind = String(body.kind ?? '').trim();
        if (!Number.isSafeInteger(userId) || userId <= 0 || !characterName) {
            res.status(400).json({ error: 'Invalid userId or characterName.' });
            return;
        }

        try {
            if (kind === 'gold') {
                const amount = Number(body.amount);
                if (!Number.isSafeInteger(amount) || amount <= 0) {
                    res.status(400).json({ error: 'Invalid amount. Must be a positive integer.' });
                    return;
                }
                const result = await grantGoldToCharacter(userId, characterName, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${amount} gold to ${characterName} (${userId}): ` +
                    `${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    amount,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'xp') {
                const amount = Number(body.amount);
                if (!Number.isSafeInteger(amount) || amount <= 0) {
                    res.status(400).json({ error: 'Invalid amount. Must be a positive integer.' });
                    return;
                }
                const result = await grantXpToCharacter(userId, characterName, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${result.granted} XP (base ${amount}) to ${characterName} (${userId}): ` +
                    `${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    amount,
                    granted: result.granted,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'mammothcoins') {
                const amount = Number(body.amount);
                if (!Number.isSafeInteger(amount) || amount <= 0) {
                    res.status(400).json({ error: 'Invalid amount. Must be a positive integer.' });
                    return;
                }
                const result = await grantMammothCoinsToCharacter(userId, characterName, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${amount} Mammoth Coins to ${characterName} (${userId}): ` +
                    `${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    amount,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'mount') {
                const mountId = Math.round(Number(body.mountId ?? 0));
                if (!Number.isSafeInteger(mountId) || mountId <= 0) {
                    res.status(400).json({ error: 'Invalid mountId. Must be a positive integer.' });
                    return;
                }
                const result = await grantMountToCharacter(userId, characterName, mountId);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                if (result.before === result.after) {
                    res.status(400).json({ error: 'The player already owns that mount.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted mount ${mountId} to ${characterName} (${userId}): ` +
                    `owned ${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    mountId,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'pet') {
                const petTypeId = Math.round(Number(body.petTypeId ?? 0));
                if (!Number.isSafeInteger(petTypeId) || petTypeId <= 0) {
                    res.status(400).json({ error: 'Invalid petTypeId. Must be a positive integer.' });
                    return;
                }
                const result = await grantPetToCharacter(userId, characterName, petTypeId);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted pet ${petTypeId} (special ${result.specialId}) to ${characterName} (${userId}): ` +
                    `owned ${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    petTypeId,
                    specialId: result.specialId,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'consumable') {
                const consumableId = Math.round(Number(body.consumableId ?? 0));
                const quantity = Math.round(Number(body.quantity ?? 1));
                if (!Number.isSafeInteger(consumableId) || consumableId <= 0) {
                    res.status(400).json({ error: 'Invalid consumableId. Must be a positive integer.' });
                    return;
                }
                if (!Number.isSafeInteger(quantity) || quantity <= 0) {
                    res.status(400).json({ error: 'Invalid quantity. Must be a positive integer.' });
                    return;
                }
                const result = await grantConsumableToCharacter(userId, characterName, consumableId, quantity);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${quantity}x consumable ${consumableId} to ${characterName} (${userId}): ` +
                    `entries ${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    consumableId,
                    quantity,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'silversigils') {
                const amount = Number(body.amount);
                if (!Number.isSafeInteger(amount) || amount <= 0) {
                    res.status(400).json({ error: 'Invalid amount. Must be a positive integer.' });
                    return;
                }
                const result = await grantSilverSigilsToCharacter(userId, characterName, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${amount} Silver Sigils to ${characterName} (${userId}): ` +
                    `${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    amount,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'dragonore' || kind === 'dragonkeys') {
                const field = kind === 'dragonore' ? 'DragonOre' : 'DragonKeys';
                const amount = Number(body.amount);
                if (!Number.isSafeInteger(amount) || amount <= 0) {
                    res.status(400).json({ error: 'Invalid amount. Must be a positive integer.' });
                    return;
                }
                const result = await grantDragonResourceToCharacter(userId, characterName, field, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${amount} ${field} to ${characterName} (${userId}): ` +
                    `${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    amount,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'gear') {
                const gearId = Math.round(Number(body.gearId ?? 0));
                const tier = Math.round(Number(body.tier ?? 1));
                const runes = Array.isArray(body.runes)
                    ? body.runes.map((value) => Math.max(0, Math.round(Number(value ?? 0)))).slice(0, 3)
                    : [0, 0, 0];
                const colors = Array.isArray(body.colors)
                    ? body.colors.map((value) => Math.max(0, Math.round(Number(value ?? 0)))).slice(0, 2)
                    : [0, 0];
                if (!Number.isSafeInteger(gearId) || gearId <= 0) {
                    res.status(400).json({ error: 'Invalid gearId. Must be a positive integer.' });
                    return;
                }
                const result = await grantGearToCharacter(userId, characterName, gearId, tier, runes, colors);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                if (result.before === result.after) {
                    res.status(400).json({ error: 'The player already owns that gear at an equal or higher tier.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted gear ${gearId} (tier ${tier}) to ${characterName} (${userId}); ` +
                    `inventory ${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    gearId,
                    tier,
                    inventoryBefore: result.before,
                    inventoryAfter: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            if (kind === 'trove') {
                const amount = Number(body.amount);
                if (!Number.isSafeInteger(amount) || amount <= 0) {
                    res.status(400).json({ error: 'Invalid amount. Must be a positive integer.' });
                    return;
                }
                const result = await grantTrovesToCharacter(userId, characterName, amount);
                if (!result) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                console.log(
                    `[AdminPanel] Granted ${amount} Treasure Troves to ${characterName} (${userId}): ` +
                    `${result.before} -> ${result.after}; onlineRecipients=${result.onlineRecipients}`
                );
                res.json({
                    ok: true,
                    kind,
                    userId,
                    characterName,
                    amount,
                    before: result.before,
                    after: result.after,
                    onlineRecipients: result.onlineRecipients
                });
                return;
            }

            res.status(400).json({
                error: 'Invalid kind. Must be one of: gold, xp, mammothcoins, mount, pet, consumable, silversigils, dragonore, dragonkeys, gear, trove.'
            });
        } catch (error) {
            console.error('[AdminPanel] Grant failed:', error);
            res.status(500).json({ error: 'The grant failed.' });
        }
    });

    app.post('/api/admin/control/rename', authorize, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const body = req.body && typeof req.body === 'object'
            ? req.body as Record<string, unknown>
            : {};
        const characterName = String(body.characterName ?? '').trim();
        const newName = String(body.newName ?? '').trim();
        const rawUserId = Number(body.userId);
        let userId = Number.isSafeInteger(rawUserId) && rawUserId > 0 ? rawUserId : 0;
        if (!characterName || !newName) {
            res.status(400).json({ error: 'characterName and newName are required.' });
            return;
        }

        try {
            if (userId <= 0) {
                const resolved = await grantDb.getAccountIdByCharName(characterName);
                if (!resolved) {
                    res.status(404).json({ error: 'Player character was not found.' });
                    return;
                }
                userId = resolved;
            }

            const result = await renameCharacter(userId, characterName, newName);
            if (!result) {
                res.status(404).json({ error: 'Player character was not found.' });
                return;
            }
            console.log(
                `[AdminPanel] Renamed ${characterName} (${userId}) to ${newName}; ` +
                `onlineRecipients=${result.onlineRecipients}`
            );
            res.json({
                ok: true,
                userId,
                characterName,
                newName,
                onlineRecipients: result.onlineRecipients
            });
        } catch (error) {
            if (error instanceof RenameConflictError) {
                res.status(409).json({ error: error.message });
                return;
            }
            console.error('[AdminPanel] Rename failed:', error);
            res.status(500).json({ error: 'The rename failed.' });
        }
    });
}
