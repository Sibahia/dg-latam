import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

function client(name: string, token: number, entityId: number): any {
    const sent: Array<{ id: number; payload: Buffer }> = [];
    return {
        token,
        clientEntID: entityId,
        userId: token,
        character: { name },
        currentLevel: 'NewbieRoad',
        levelInstanceId: 'party-invite-authority',
        currentRoomId: 0,
        playerSpawned: true,
        sent,
        send(id: number, payload: Buffer): void { sent.push({ id, payload: Buffer.from(payload) }); },
        sendBitBuffer(id: number, packet: BitBuffer): void { sent.push({ id, payload: packet.toBuffer() }); }
    };
}

function invitePacket(name: string): Buffer {
    const packet = new BitBuffer(false);
    packet.writeMethod26(name);
    return packet.toBuffer();
}

function answerPacket(token: number, accepted: boolean): Buffer {
    const packet = new BitBuffer(false);
    packet.writeMethod9(token);
    packet.writeMethod26('');
    packet.writeMethod15(accepted);
    return packet.toBuffer();
}

async function main(): Promise<void> {
    const inviter = client('Inviter', 81_001, 91_001);
    const invitee = client('Invitee', 81_002, 91_002);
    GlobalState.sessionsByToken.set(inviter.token, inviter);
    GlobalState.sessionsByToken.set(invitee.token, invitee);

    try {
        await SocialHandler.handleQueryMessageAnswer(invitee, answerPacket(inviter.clientEntID, true));
        assert.equal(GlobalState.partyByMember.size, 0, 'a fabricated answer must not create a party');

        SocialHandler.handleGroupInvite(inviter, invitePacket(invitee.character.name));
        const prompt = invitee.sent.find((entry: any) => entry.id === 0x58);
        assert.ok(prompt, 'a valid invitation must produce a prompt');
        const promptToken = new BitReader(prompt.payload).readMethod9();
        assert.ok(promptToken >= 3_000_000, 'party prompts must use opaque server tokens');

        await SocialHandler.handleQueryMessageAnswer(invitee, answerPacket(promptToken, true));
        assert.equal(GlobalState.partyByMember.get('inviter'), GlobalState.partyByMember.get('invitee'));
        const partyCount = GlobalState.partyGroups.size;

        await SocialHandler.handleQueryMessageAnswer(invitee, answerPacket(promptToken, true));
        assert.equal(GlobalState.partyGroups.size, partyCount, 'an accepted invitation must be one-time');
    } finally {
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
    }

    console.log('party_invite_authority_regression: ok');
}

void main();
