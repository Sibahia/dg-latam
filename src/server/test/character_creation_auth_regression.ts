import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as path from 'path';
import { Config } from '../core/config';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

function packet(overrides: Partial<Record<string, string>> = {}): Buffer {
    const values = {
        name: 'Valid Hero',
        className: 'Mage',
        gender: 'Male',
        head: 'Head02',
        hair: 'Do02',
        mouth: 'M01',
        face: 'F12',
        ...overrides
    };
    const bb = new BitBuffer(false);
    bb.writeMethod26(values.name);
    bb.writeMethod26(values.className);
    bb.writeMethod26(values.gender);
    bb.writeMethod26(values.head);
    bb.writeMethod26(values.hair);
    bb.writeMethod26(values.mouth);
    bb.writeMethod26(values.face);
    for (const color of [0x102030, 0x405060, 0x708090, 0xa0b0c0]) {
        bb.writeMethod20(24, color);
    }
    return bb.toBuffer();
}

function fakeClient(authenticated = true): any {
    const sent: Array<{ id: number; payload: Buffer }> = [];
    return {
        authenticated,
        userId: authenticated ? 7 : null,
        account: authenticated ? { email: 'owner@example.com', user_id: 7 } : null,
        characters: [],
        character: null,
        sent,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sent.push({ id, payload: bb.toBuffer() });
        }
    };
}

function popup(client: any): string {
    const packet = client.sent.find((entry: any) => entry.id === 0x1b);
    assert.ok(packet, 'rejected creation should send a popup');
    return new BitReader(packet.payload).readMethod13();
}

async function main(): Promise<void> {
    CharacterTemplates.load(path.join(Config.DATA_DIR, 'data'));
    const originalDb = CharacterHandler.db;
    const calls: any[] = [];
    CharacterHandler.db = {
        async createCharacter(userId: number, character: any, maxCharacters: number) {
            calls.push({ userId, character, maxCharacters });
            return { ok: false, reason: 'name-taken', characters: [] };
        }
    } as any;

    try {
        const unauthenticated = fakeClient(false);
        await CharacterHandler.handleLoginCharacterCreate(unauthenticated, packet());
        assert.match(popup(unauthenticated), /Sign in/);
        assert.equal(calls.length, 0, 'unauthenticated creation must not reach persistence');

        for (const [overrides, expected] of [
            [{ name: 'A\u0000B' }, /3-20 Latin/],
            [{ name: 'Сyrillic' }, /3-20 Latin/],
            [{ className: 'Necromancer' }, /class is unavailable/],
            [{ gender: 'Robot' }, /gender is unavailable/],
            [{ head: '../Head02' }, /appearance selections/]
        ] as Array<[Record<string, string>, RegExp]>) {
            const invalid = fakeClient();
            await CharacterHandler.handleLoginCharacterCreate(invalid, packet(overrides));
            assert.match(popup(invalid), expected);
        }
        assert.equal(calls.length, 0, 'invalid character data must not reach persistence');

        const valid = fakeClient();
        await CharacterHandler.handleLoginCharacterCreate(valid, packet({ name: '  V\uFF41lid   Hero  ' }));
        assert.equal(calls.length, 1, 'validated character should use atomic persistence');
        assert.equal(calls[0].character.name, 'Valid Hero', 'name should be NFKC and whitespace normalized');
        assert.equal(calls[0].maxCharacters, 8, 'atomic persistence should enforce the advertised slot limit');
        assert.match(popup(valid), /name is unavailable/);

        CharacterHandler.db = {
            async createCharacter() {
                return { ok: false, reason: 'character-limit', characters: Array(8).fill({ name: 'Existing' }) };
            }
        } as any;
        const ninth = fakeClient();
        await CharacterHandler.handleLoginCharacterCreate(ninth, packet({ name: 'Ninth Hero' }));
        assert.match(popup(ninth), /maximum number/);

        console.log('character_creation_auth_regression: ok');
    } finally {
        CharacterHandler.db = originalDb;
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
