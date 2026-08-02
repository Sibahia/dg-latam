/// <reference types="node" />

import '../core/loadEnv';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Document, MongoClient } from 'mongodb';
import { Config } from '../core/config';
import { UserAccount, UserSaveData } from '../database/Database';

const dryRun = process.argv.includes('--dry-run');
const overwrite = process.argv.includes('--overwrite');
const includeOrphanSaves = process.argv.includes('--include-orphan-saves');

async function readFirstJson<T>(paths: string[]): Promise<T> {
    for (const filePath of paths) {
        try {
            return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
    throw new Error(`None of the expected JSON files exist: ${paths.join(', ')}`);
}

async function readAccounts(): Promise<UserAccount[]> {
    const raw = await readFirstJson<unknown>([
        path.resolve(Config.DATA_DIR, 'data', 'Accounts.json'),
        path.resolve(Config.DATA_DIR, 'Accounts.json')
    ]);
    if (!Array.isArray(raw)) {
        throw new Error('Accounts.json must contain an array.');
    }
    return raw.filter((entry): entry is UserAccount => {
        const account = entry as Partial<UserAccount>;
        return typeof account?.email === 'string' &&
            Number.isSafeInteger(Number(account?.user_id)) &&
            Number(account.user_id) > 0;
    });
}

async function readSaves(): Promise<UserSaveData[]> {
    const candidateDirs = [
        path.resolve(Config.DATA_DIR, 'data', 'saves'),
        path.resolve(Config.DATA_DIR, 'saves')
    ];
    for (const savesDir of candidateDirs) {
        try {
            const files = (await fs.readdir(savesDir)).filter((file) => file.endsWith('.json'));
            const saves: UserSaveData[] = [];
            for (const file of files) {
                const raw = JSON.parse(await fs.readFile(path.join(savesDir, file), 'utf8')) as Partial<UserSaveData>;
                if (
                    Number.isSafeInteger(Number(raw.user_id)) &&
                    Number(raw.user_id) > 0 &&
                    Array.isArray(raw.characters)
                ) {
                    saves.push({
                        user_id: Math.round(Number(raw.user_id)),
                        characters: raw.characters
                    });
                }
            }
            return saves;
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
    return [];
}

async function main(): Promise<void> {
    const [accounts, sourceSaves] = await Promise.all([readAccounts(), readSaves()]);
    const accountIds = new Set(accounts.map((account) => Math.round(Number(account.user_id))));
    const sourceSavesByUserId = new Map(sourceSaves.map((save) => [save.user_id, save]));
    const accountSaves = accounts.map((account) => {
        const userId = Math.round(Number(account.user_id));
        return sourceSavesByUserId.get(userId) ?? { user_id: userId, characters: [] };
    });
    const orphanSaves = sourceSaves.filter((save) => !accountIds.has(save.user_id));
    const saves = includeOrphanSaves ? [...accountSaves, ...orphanSaves] : accountSaves;
    const totalCharacters = saves.reduce((sum, save) => sum + save.characters.length, 0);
    const maxUserId = Math.max(
        0,
        ...accounts.map((account) => Math.round(Number(account.user_id))),
        ...saves.map((save) => Math.round(Number(save.user_id)))
    );

    console.log(
        `[MongoGameDataMigration] accounts=${accounts.length} accountSaves=${accountSaves.length} orphanSaves=${orphanSaves.length} orphanMode=${includeOrphanSaves ? 'include' : 'skip'} characters=${totalCharacters} maxUserId=${maxUserId} mode=${overwrite ? 'overwrite' : 'insert-only'}`
    );
    if (dryRun) {
        console.log('[MongoGameDataMigration] Dry run complete; MongoDB was not changed.');
        return;
    }
    if (!Config.MONGODB_URI) {
        throw new Error('MONGODB_URI is required.');
    }

    const client = new MongoClient(Config.MONGODB_URI, { ignoreUndefined: true });
    await client.connect();
    try {
        const db = client.db(Config.MONGODB_DB_NAME);
        const accountCollection = db.collection<Document & { _id: string }>(Config.MONGODB_ACCOUNTS_COLLECTION);
        const saveCollection = db.collection<Document & { _id: string }>(Config.MONGODB_SAVES_COLLECTION);
        const counterCollection = db.collection<Document & { _id: string; value: number }>(
            Config.MONGODB_COUNTERS_COLLECTION
        );
        const now = new Date();

        if (accounts.length > 0) {
            await accountCollection.bulkWrite(accounts.map((account) => ({
                updateOne: {
                    filter: { user_id: account.user_id },
                    update: overwrite
                        ? {
                            $set: { ...account, updatedAt: now },
                            $setOnInsert: { _id: `user:${account.user_id}`, createdAt: now }
                        }
                        : {
                            $setOnInsert: {
                                _id: `user:${account.user_id}`,
                                ...account,
                                createdAt: now,
                                updatedAt: now
                            }
                        },
                    upsert: true
                }
            })), { ordered: true });
        }

        if (saves.length > 0) {
            await saveCollection.bulkWrite(saves.map((save) => ({
                updateOne: {
                    filter: { user_id: save.user_id },
                    update: overwrite
                        ? {
                            $set: {
                                user_id: save.user_id,
                                characters: save.characters,
                                updatedAt: now
                            },
                            $setOnInsert: { _id: String(save.user_id), createdAt: now }
                        }
                        : {
                            $setOnInsert: {
                                _id: String(save.user_id),
                                user_id: save.user_id,
                                characters: save.characters,
                                createdAt: now,
                                updatedAt: now
                            }
                        },
                    upsert: true
                }
            })), { ordered: true });
        }

        await counterCollection.updateOne(
            { _id: 'game_user_id' },
            { $max: { value: maxUserId }, $setOnInsert: { createdAt: now } },
            { upsert: true }
        );
        await Promise.all([
            accountCollection.createIndex({ email: 1 }, { unique: true, name: 'account_email_unique' }),
            accountCollection.createIndex({ user_id: 1 }, { unique: true, name: 'account_user_id_unique' }),
            accountCollection.createIndex(
                { discordId: 1 },
                { unique: true, sparse: true, name: 'account_discord_id_unique' }
            ),
            saveCollection.createIndex({ user_id: 1 }, { unique: true, name: 'save_user_id_unique' }),
            saveCollection.createIndex({ 'characters.name': 1 }, { name: 'save_character_name' })
        ]);

        console.log('[MongoGameDataMigration] Full accounts and save documents were copied successfully.');
    } finally {
        await client.close();
    }
}

void main().catch((error) => {
    console.error('[MongoGameDataMigration] Failed:', error);
    process.exitCode = 1;
});
