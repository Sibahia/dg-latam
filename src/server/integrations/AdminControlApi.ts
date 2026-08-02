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

const registeredApps = new WeakSet<express.Application>();
const grantDb = new JsonAdapter();

type CharacterStore = Pick<JsonAdapter, 'loadCharacters' | 'saveCharacterSnapshot'>;

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

    const mutatedCharacters = new Map<Character, Character>();
    mutatedCharacters.set(authoritativeCharacter, { ...authoritativeCharacter });
    let outcome = apply(authoritativeCharacter);
    const applyToCopy = (character: Character | null | undefined): void => {
        if (!character || character === authoritativeCharacter) {
            return;
        }
        if (normalizeGrantCharacterName(character.name) !== normalizedName) {
            return;
        }
        if (!mutatedCharacters.has(character)) {
            mutatedCharacters.set(character, { ...character });
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
            character.gold = previous.gold;
            character.inventoryGears = previous.inventoryGears;
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
            character.gold = previous.gold;
            character.inventoryGears = previous.inventoryGears;
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

            res.status(400).json({ error: 'Invalid kind. Must be "gold" or "gear".' });
        } catch (error) {
            console.error('[AdminPanel] Grant failed:', error);
            res.status(500).json({ error: 'The grant failed.' });
        }
    });
}
