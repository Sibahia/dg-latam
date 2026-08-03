/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { GearCatalogEntry } from '../database/Database';
import { GameDataPersistenceAdapter } from '../database/MongoGameDataAdapter';
import { JsonAdapter } from '../database/JsonAdapter';

class MemoryGameDataAdapter implements GameDataPersistenceAdapter {
    public account = { email: 'player@example.com', user_id: 77 };
    public saves = new Map<number, any[]>();
    public gearCatalog = new Map<number, GearCatalogEntry>();

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async getAccount(): Promise<any> { return this.account; }
    async getAccountById(): Promise<any> { return this.account; }
    async getAccountId(): Promise<number | null> { return this.account.user_id; }
    async findAccountByDiscordId(): Promise<any> { return this.account; }
    async linkDiscordToAccount(): Promise<any> { return this.account; }
    async createDiscordAccount(): Promise<any> { return this.account; }
    async createAccount(): Promise<any> { return this.account; }
    async updateAccountPassword(): Promise<any> { return this.account; }
    async loadCharacters(userId: number): Promise<any[]> { return this.saves.get(userId) ?? []; }
    async loadAllCharacterRecords(): Promise<any[]> {
        return Array.from(this.saves.entries()).map(([user_id, characters]) => ({ user_id, characters }));
    }
    async loadCharacterRecordsByGuild(guildName: string): Promise<any[]> {
        const wanted = String(guildName).trim().toLowerCase();
        const records = await this.loadAllCharacterRecords();
        return records.filter((save) => 
            save.characters.some((character: any) => 
                String((character.guild as Record<string, unknown> | undefined)?.name ?? '')
                    .trim()
                    .replace(/\s+/g, ' ')
                    .toLowerCase() === wanted
            )
        );
    }
    async saveCharacters(userId: number, characters: any[]): Promise<void> {
        this.saves.set(userId, characters);
    }
    async isCharacterNameTaken(_name: string): Promise<boolean> {
        return false;
    }
    async getAccountIdByCharName(_name: string): Promise<number | null> {
        return null;
    }

    async getGearCatalog(): Promise<GearCatalogEntry[]> {
        return Array.from(this.gearCatalog.values()).sort((a, b) => a.id - b.id);
    }

    async upsertGearCatalog(entries: GearCatalogEntry[]): Promise<void> {
        for (const entry of entries) {
            const id = Math.round(Number(entry.id));
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            this.gearCatalog.set(id, {
                id,
                name: String(entry.name ?? ''),
                displayName: String(entry.displayName ?? ''),
                type: String(entry.type ?? ''),
                rarity: String(entry.rarity ?? ''),
                usedBy: String(entry.usedBy ?? ''),
                gearName: entry.gearName !== undefined ? String(entry.gearName) : undefined
            });
        }
    }
}

async function main(): Promise<void> {
    const mongo = new MemoryGameDataAdapter();
    JsonAdapter.configureMongoGameDataForTests(mongo);
    const db = new JsonAdapter();

    // Seed with some test entries
    const seedEntries: GearCatalogEntry[] = [
        { id: 1, name: 'AxeStarter1', displayName: 'Starter Axe', type: 'Sword', rarity: 'M', usedBy: 'paladin', gearName: 'AxeStarter1' },
        { id: 2, name: 'StaffMage1', displayName: 'Mage Staff', type: 'Staff', rarity: 'M', usedBy: 'mage', gearName: 'StaffMage1' },
        { id: 3, name: 'DaggerRogue1', displayName: 'Rogue Dagger', type: 'Dagger', rarity: 'R', usedBy: 'rogue', gearName: 'DaggerRogue1' }
    ];

    try {
        // Test upsertGearCatalog
        await db.upsertGearCatalog(seedEntries);
        const catalog = await db.getGearCatalog();

        // Verify entries are returned
        assert.strictEqual(catalog.length, 3, 'should return 3 seeded entries');
        assert.strictEqual(catalog[0].id, 1);
        assert.strictEqual(catalog[0].name, 'AxeStarter1');
        assert.strictEqual(catalog[0].usedBy, 'paladin');
        assert.strictEqual(catalog[1].usedBy, 'mage');
        assert.strictEqual(catalog[2].usedBy, 'rogue');

        // Test upsert again with modified entries (should replace)
        const updatedEntries: GearCatalogEntry[] = [
            { id: 1, name: 'AxeStarter1', displayName: 'Improved Starter Axe', type: 'Sword', rarity: 'R', usedBy: 'paladin', gearName: 'AxeStarter1R' },
            { id: 4, name: 'NewGear', displayName: 'New Gear', type: 'Shield', rarity: 'L', usedBy: 'paladin', gearName: 'NewGear' }
        ];

        await db.upsertGearCatalog(updatedEntries);
        const updatedCatalog = await db.getGearCatalog();

        // Should have 4 entries now (1 updated, 2, 3, 4 new)
        assert.strictEqual(updatedCatalog.length, 4, 'should have 4 entries after upsert');
        const entry1 = updatedCatalog.find(e => e.id === 1);
        assert.ok(entry1, 'entry id 1 should exist');
        assert.strictEqual(entry1!.displayName, 'Improved Starter Axe');
        assert.strictEqual(entry1!.rarity, 'R');
        assert.ok(updatedCatalog.find(e => e.id === 4), 'entry id 4 should exist');

        console.log('gear_catalog_mongo_regression: ok');
    } finally {
        JsonAdapter.configureMongoGameDataForTests(null);
    }
}

void main();