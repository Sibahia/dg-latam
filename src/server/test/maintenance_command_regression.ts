import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

function createClient(email: string, token: number) {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        userId: token,
        account: { email },
        character: { name: `Player${token}` },
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildPublicChat(message: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(0);
    bb.writeMethod13(message);
    return bb.toBuffer();
}

async function main(): Promise<void> {
    const arda = createClient('ArdaArican3399@GMAIL.COM', 1);
    const neo = createClient('neodevils_contact@icloud.com', 2);
    const player = createClient('player@example.com', 3);
    const maintenanceOperator = createClient('1@GMAIL.COM', 4);

    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByToken.set(arda.token, arda as never);
    GlobalState.sessionsByToken.set(neo.token, neo as never);
    GlobalState.sessionsByToken.set(player.token, player as never);
    GlobalState.sessionsByToken.set(maintenanceOperator.token, maintenanceOperator as never);

    await SocialHandler.handlePublicChat(arda as never, buildPublicChat('/maintenance:90'));
    for (const session of [arda, neo, player, maintenanceOperator]) {
        const warning = session.sentPackets.find((packet) => packet.id === 0x101);
        assert.ok(warning, 'authorized command should broadcast packet 0x101 to every active session');
        assert.equal(new BitReader(warning.payload).readMethod4(), 90);
        session.sentPackets.length = 0;
    }

    await SocialHandler.handlePublicChat(neo as never, buildPublicChat('/maintenance:45'));
    assert.equal(player.sentPackets.filter((packet) => packet.id === 0x101).length, 1);
    for (const session of [arda, neo, player, maintenanceOperator]) {
        session.sentPackets.length = 0;
    }

    await SocialHandler.handlePublicChat(maintenanceOperator as never, buildPublicChat('/maintenance:300'));
    for (const session of [arda, neo, player, maintenanceOperator]) {
        const warning = session.sentPackets.find((packet) => packet.id === 0x101);
        assert.ok(warning, '1@gmail.com should broadcast the maintenance warning to every active session');
        assert.equal(new BitReader(warning.payload).readMethod4(), 300);
        session.sentPackets.length = 0;
    }

    await SocialHandler.handlePublicChat(player as never, buildPublicChat('/maintenance:30'));
    assert.equal(arda.sentPackets.some((packet) => packet.id === 0x101), false);
    assert.equal(neo.sentPackets.some((packet) => packet.id === 0x101), false);
    assert.equal(player.sentPackets.some((packet) => packet.id === 0x101), false);
    assert.equal(player.sentPackets.some((packet) => packet.id === 0x44), true, 'unauthorized caller should receive a status message');

    GlobalState.sessionsByToken.clear();
    console.log('Maintenance command regression checks passed.');
}

main().catch((error) => {
    GlobalState.sessionsByToken.clear();
    console.error(error);
    process.exitCode = 1;
});
