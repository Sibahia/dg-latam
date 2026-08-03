/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';

// Leaving a Felbridge mission used to drop the player at the world spawn (the
// "start of Felbridge") instead of the last position. Cause: DoorTypes.xml only
// authored a return DoorType for BT_Mission3, so resolving the exit door of
// BT_Mission1/2/4 fell through to the world-spawn fallback. This test pins the
// return doors so the regression cannot come back.
function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('BridgeTown')) {
        LevelConfig.load(dataDir);
    }

    const cases: Array<[string, number, string]> = [
        ['BT_Mission1', 2, 'BridgeTown'],
        ['BT_Mission2', 2, 'BridgeTown'],
        ['BT_Mission4', 2, 'BridgeTown'],
        ['BT_Mission1Hard', 2, 'BridgeTownHard'],
        ['BT_Mission2Hard', 2, 'BridgeTownHard'],
        ['BT_Mission4Hard', 2, 'BridgeTownHard']
    ];

    for (const [mission, doorId, targetLevel] of cases) {
        const target = (LevelConfig as any).DOOR_TARGETS.get(`${mission}_${doorId}`);
        assert.ok(target, `${mission} door ${doorId} must have an authored return DoorType`);
        assert.equal(
            (LevelConfig as any).normalizeLevelName(target?.targetLevel),
            targetLevel,
            `${mission} return door must target ${targetLevel}`
        );
    }

    console.log('mission_return_door_regression: ok');
}

main();
