/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';

// Crossing the house door mid-jump used to save the airborne position as the
// region return point (the CraftTown branch of updateSavedLevelsOnTransfer read
// sourcePosition without checking airborne, unlike the movement save path).
// Coming back from the house then replayed the fall or landed the player on the
// wrong floor. The airborne source must be ignored and the last grounded record
// kept.
const REGION = 'JadeCity';
const GROUND_Y = 880;

function makeCharacter(x: number, y: number): any {
    return {
        name: 'HouseFaller',
        level: 50,
        class: 'mage',
        MasterClass: 0,
        CurrentLevel: { name: REGION, x, y },
        PreviousLevel: { name: 'SwampRoadNorth', x: 2000, y: 595 }
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(REGION)) {
        LevelConfig.load(dataDir);
    }

    const groundedChar = makeCharacter(12_777, GROUND_Y);
    LevelConfig.updateSavedLevelsOnTransfer(
        groundedChar,
        REGION,
        'CraftTown',
        360,
        1460,
        { x: 12_777, y: GROUND_Y, hasCoord: true, airborne: false }
    );
    assert.equal(
        groundedChar.PreviousLevel.name,
        REGION,
        'grounded house entry must record the region as PreviousLevel'
    );
    assert.equal(
        groundedChar.PreviousLevel.y,
        GROUND_Y,
        'grounded house entry must keep the grounded Y'
    );

    // Airborne: the live Y is the airborne position and must NOT overwrite the
    // last grounded record.
    const airborneChar = makeCharacter(12_777, GROUND_Y);
    LevelConfig.updateSavedLevelsOnTransfer(
        airborneChar,
        REGION,
        'CraftTown',
        360,
        1460,
        { x: 12_777, y: -848, hasCoord: true, airborne: true }
    );
    assert.equal(
        airborneChar.PreviousLevel.name,
        REGION,
        'airborne house entry must still record the region'
    );
    assert.equal(
        airborneChar.PreviousLevel.y,
        GROUND_Y,
        'airborne house entry must keep the last grounded Y, not the airborne one'
    );

    console.log('crafttown_airborne_save_regression: ok');
}

main();
