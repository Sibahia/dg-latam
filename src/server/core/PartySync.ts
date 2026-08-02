import { Client } from './Client';
import { GlobalState } from './GlobalState';
import { areClientsInSameLevelScope } from './LevelScope';
import { normalizeCharacterKey } from './SocialState';

export function sharesRoomIds(leftRoomId: number, rightRoomId: number): boolean {
    const left = Number.isFinite(leftRoomId) ? leftRoomId : -1;
    const right = Number.isFinite(rightRoomId) ? rightRoomId : -1;

    if (left < 0 || right < 0) {
        return true;
    }

    return left === right;
}

export function getClientCharacterKey(client: Pick<Client, 'character'> | null | undefined): string {
    return normalizeCharacterKey(client?.character?.name);
}

export function getPartyIdForClient(client: Pick<Client, 'character'> | null | undefined): number {
    const key = getClientCharacterKey(client);
    if (!key) {
        return 0;
    }

    return Number(GlobalState.partyByMember.get(key) ?? 0);
}

export function getPartyLeaderCharacterKeyForClient(client: Pick<Client, 'character'> | null | undefined): string {
    const partyId = getPartyIdForClient(client);
    if (partyId <= 0) {
        return '';
    }

    const group = GlobalState.partyGroups.get(partyId);
    return normalizeCharacterKey(group?.leader);
}

export function isClientPartyLeader(client: Pick<Client, 'character'> | null | undefined): boolean {
    const clientKey = getClientCharacterKey(client);
    if (!clientKey) {
        return false;
    }

    return clientKey === getPartyLeaderCharacterKeyForClient(client);
}

export function areClientsInSameParty(
    left: Pick<Client, 'character'> | null | undefined,
    right: Pick<Client, 'character'> | null | undefined
): boolean {
    const leftPartyId = getPartyIdForClient(left);
    return leftPartyId > 0 && leftPartyId === getPartyIdForClient(right);
}

export function shouldShareCombatView(anchor: Client, other: Client): boolean {
    if (!anchor.playerSpawned || !other.playerSpawned || !anchor.currentLevel || !areClientsInSameLevelScope(anchor, other)) {
        return false;
    }

    if (areClientsInSameParty(anchor, other)) {
        return true;
    }

    return sharesRoomIds(anchor.currentRoomId, other.currentRoomId);
}
