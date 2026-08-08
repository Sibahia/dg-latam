import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { JsonAdapter } from '../database/JsonAdapter';
import { MongoGameDataAdapter } from '../database/MongoGameDataAdapter';

async function testMongoLegacySaveMergesSnapshotsAtomically(): Promise<void> {
    const updates: any[][] = [];
    const adapter = new MongoGameDataAdapter('', '') as any;
    adapter.getCollections = async () => ({
        saves: {
            updateOne: async (...args: any[]) => {
                updates.push(args);
                return { modifiedCount: 1 };
            }
        }
    });

    await adapter.saveCharacters(12, [
        { name: 'Alpha', class: 'mage', gender: 'male', level: 1, gold: 100 }
    ]);

    assert.equal(updates.length, 1);
    const pipeline = updates[0][1];
    assert.ok(Array.isArray(pipeline), 'legacy Mongo saves must use an atomic aggregation update');
    assert.ok(pipeline[0]?.$set?.characters?.$reduce, 'legacy Mongo saves must merge snapshots by character');
    assert.deepEqual(
        pipeline[0]?.$set?.revision,
        { $add: [{ $ifNull: ['$revision', 0] }, 1] },
        'each atomic Mongo save must advance its monotonic revision'
    );
}

async function main(): Promise<void> {
    JsonAdapter.configureMongoGameDataForTests(null);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'db-save-concurrency-'));
    const savesDir = path.join(root, 'data', 'saves');
    const accountsPath = path.join(root, 'data', 'Accounts.json');
    await fs.mkdir(savesDir, { recursive: true });
    await fs.writeFile(accountsPath, JSON.stringify([{ email: 'test@example.com', user_id: 1 }]));

    const adapter = new JsonAdapter() as any;
    adapter.savesDir = savesDir;
    adapter.legacySavesDir = path.join(root, 'legacy-saves');
    adapter.accountsPath = accountsPath;
    adapter.legacyAccountsPath = path.join(root, 'legacy-accounts.json');

    await adapter.saveCharacters(1, [
        { name: 'Alpha', class: 'mage', gender: 'male', level: 1, gold: 0 },
        { name: 'Beta', class: 'rogue', gender: 'female', level: 1, gold: 0 }
    ]);

    await Promise.all([
        adapter.saveCharacterSnapshot(1, { name: 'Alpha', class: 'mage', gender: 'male', level: 1, gold: 100 }),
        adapter.saveCharacterSnapshot(1, { name: 'Beta', class: 'rogue', gender: 'female', level: 1, gold: 200 })
    ]);

    const saved = await adapter.loadCharacters(1);
    assert.equal(saved.find((entry: any) => entry.name === 'Alpha')?.gold, 100);
    assert.equal(saved.find((entry: any) => entry.name === 'Beta')?.gold, 200);
    assert.equal(saved.length, 2, 'concurrent snapshots must not drop another character');

    const [first, second] = await Promise.all([
        adapter.createCharacter(1, { name: 'Gamma', class: 'mage', gender: 'male', level: 1 }, 8),
        adapter.createCharacter(1, { name: 'gAmMa', class: 'mage', gender: 'male', level: 1 }, 8)
    ]);
    assert.equal([first, second].filter((result) => result.ok).length, 1, 'case-insensitive name reservation must be atomic');
    assert.equal([first, second].filter((result) => result.reason === 'name-taken').length, 1);

    await testMongoLegacySaveMergesSnapshotsAtomically();

    await fs.rm(root, { recursive: true, force: true });
    console.log('character_snapshot_concurrency_regression: ok');
}

void main();
