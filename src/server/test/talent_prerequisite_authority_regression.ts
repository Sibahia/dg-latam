/// <reference types="node" />

import { strict as assert } from 'assert';
import { TalentConfig } from '../core/TalentConfig';

type TestNode = { filled: boolean; points: number; nodeID: number };

function emptyTree(): TestNode[] {
    return TalentConfig.buildEmptyTalentNodes();
}

function fill(nodes: TestNode[], slot: number, nodeID: number, points: number): void {
    nodes[slot] = { filled: true, nodeID, points };
}

function main(): void {
    const rootOnly = emptyTree();
    fill(rootOnly, 0, 1, 5);
    assert.equal(TalentConfig.isAuthoredAllocationValid(rootOnly), true, 'an authored root allocation was rejected');

    const disconnected = emptyTree();
    fill(disconnected, 5, 1, 3);
    assert.equal(
        TalentConfig.isAuthoredAllocationValid(disconnected),
        false,
        'a disconnected socket bypassed the authored prerequisite graph'
    );

    const tierBypass = emptyTree();
    fill(tierBypass, 0, 40, 5);
    assert.equal(
        TalentConfig.isAuthoredAllocationValid(tierBypass),
        false,
        'a tier-14 node was accepted without its sixty-five-point prerequisite'
    );

    const firstGatePath = emptyTree();
    fill(firstGatePath, 0, 1, 5);
    fill(firstGatePath, 2, 2, 3);
    fill(firstGatePath, 4, 3, 5);
    fill(firstGatePath, 5, 4, 3);
    fill(firstGatePath, 6, 5, 2);
    fill(firstGatePath, 8, 6, 2);
    fill(firstGatePath, 9, 7, 1);
    assert.equal(
        TalentConfig.isAuthoredAllocationValid(firstGatePath),
        true,
        'a connected allocation satisfying the first twenty-point gate was rejected'
    );

    const missingGateSocket = firstGatePath.map((node) => ({ ...node }));
    missingGateSocket[8] = { filled: false, nodeID: 9, points: 0 };
    assert.equal(
        TalentConfig.isAuthoredAllocationValid(missingGateSocket),
        false,
        'a branch beyond the first gate was accepted without the authored gate socket'
    );

    console.log('talent_prerequisite_authority_regression: ok');
}

main();
