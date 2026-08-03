/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { LevelConfig } from '../core/LevelConfig';

// Valhaven (JC_*) dungeons are client-authority: the server initializes 0 NPCs
// and the boss is a scripted *Marker proxy (same convention as Capstone). The
// completion flags (clientAuthorityBosses) were missing on several of them, so
// the client destroy signal was discarded and the run sat on objectives_pending.
// This test pins the canonical boss names and the client-authority flags so the
// reported-name matcher cannot drift again.

type Case = {
    level: string;
    boss: string;
    aliases: string[];
    clientAuthority: boolean;
};

const CASES: Case[] = [
    { level: 'JC_Mission2', boss: 'GreaterBoneGolem', aliases: ['GreaterBoneGolemMarker'], clientAuthority: true },
    { level: 'JC_Mission2Hard', boss: 'GreaterBoneGolemHard', aliases: ['GreaterBoneGolemMarkerHard'], clientAuthority: true },
    { level: 'JC_Mission5', boss: 'PhantomKnightMarker', aliases: [], clientAuthority: true },
    { level: 'JC_Mission7', boss: 'EmperorMarker', aliases: ['Emperor'], clientAuthority: true },
    { level: 'JC_Mission7Hard', boss: 'EmperorMarkerHard', aliases: ['Emperor', 'EmperorMarker'], clientAuthority: true },
    { level: 'JC_Mission9', boss: 'RisenBandit', aliases: [], clientAuthority: true }
];

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);

    for (const testCase of CASES) {
        const condition = DungeonCompletionConditions.get(testCase.level);
        assert.ok(condition, `${testCase.level}: condition must exist`);
        assert.equal(
            condition?.mode,
            'bosses',
            `${testCase.level}: must be a bosses dungeon`
        );

        const canonical = DungeonCompletionConditions.getCanonicalBossName(testCase.level, {
            id: 1,
            name: testCase.boss,
            characterName: `,${testCase.boss}`
        });
        assert.equal(
            canonical,
            testCase.boss,
            `${testCase.level}: boss reported as ${testCase.boss} must resolve to itself`
        );

        for (const alias of testCase.aliases) {
            const aliasCanonical = DungeonCompletionConditions.getCanonicalBossName(testCase.level, {
                id: 1,
                name: alias,
                characterName: `,${alias}`
            });
            assert.equal(aliasCanonical, testCase.boss, `${testCase.level}: alias ${alias} must resolve to ${testCase.boss}`);
        }

        if (testCase.clientAuthority) {
            const allowed = new Set((condition?.clientAuthorityBosses ?? []).map((name) => name.toLowerCase()));
            assert.ok(
                allowed.has(testCase.boss.toLowerCase()),
                `${testCase.level}: must declare ${testCase.boss} in clientAuthorityBosses`
            );
        }
    }

    console.log('valhaven_client_boss_completion_regression: ok');
}

main();
