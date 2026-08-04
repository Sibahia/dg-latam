import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionHandler } from '../handlers/MissionHandler';
import { MissionLoader } from '../data/MissionLoader';

// Ancient Vault (JC_Mission10) completes but its mission (VaultHunter, 239) was
// never started: no contact NPC and no auto-start for bosses-mode dungeons, so
// the world map never showed it complete. The auto-start now covers bosses-mode
// missions without a turn-in NPC.
function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission10')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getTotalMissions()) {
        MissionLoader.load(dataDir);
    }

    const missionDef = MissionLoader.findPrimaryMissionByDungeon('JC_Mission10');
    assert.ok(missionDef, 'JC_Mission10 must have a primary mission');
    assert.equal(missionDef.MissionID, 239, 'JC_Mission10 primary mission must be VaultHunter (239)');
    assert.equal(
        String(missionDef.ReturnName ?? '').trim(),
        '',
        'VaultHunter must have no return NPC (drives the no-turn-in auto-start)'
    );
    assert.equal(
        String(missionDef.ContactName ?? '').trim(),
        '',
        'VaultHunter must have no contact NPC (no other way to accept it)'
    );

    const autoStart = (MissionHandler as unknown as { shouldAutoStartDungeonMission: (l: string) => boolean }).shouldAutoStartDungeonMission;
    assert.equal(
        autoStart('JC_Mission10'),
        true,
        'JC_Mission10 must auto-start its mission on entry'
    );
    assert.equal(
        autoStart('JC_Mission1'),
        false,
        'JC_Mission1 (bosses with a contact NPC) must NOT auto-start'
    );

    console.log('ancient_vault_autostart_regression: ok');
}

main();
