// Seeds (upsert) the admin panel users into the `admin_users` collection.
//
// Usage: node tools/seedAdminUsers.js
// Env:  GAME_MONGODB_URI (default mongodb://127.0.0.1:27017)
//       GAME_MONGODB_DB_NAME (default dungeonblitz)
//
// Passwords are stored as bcrypt hashes, never plaintext.
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = String(process.env.GAME_MONGODB_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017').trim();
const dbName = String(process.env.GAME_MONGODB_DB_NAME || 'dungeonblitz').trim();

const USERS = [
    { username: 'jaomyios', password: 'patricio' },
    { username: 'dragon', password: 'dragon139' }
];

async function main() {
    const client = new MongoClient(uri, { ignoreUndefined: true });
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection('admin_users');
        await collection.createIndex({ username: 1 }, { unique: true });

        for (const user of USERS) {
            const passwordHash = await bcrypt.hash(user.password, 10);
            await collection.updateOne(
                { username: user.username },
                {
                    $set: { passwordHash, updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
            );
            console.log(`upserted admin user: ${user.username}`);
        }
        console.log(`admin_users ready in db="${dbName}" (${await collection.countDocuments()} users)`);
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error('[seedAdminUsers]', error);
    process.exit(1);
});
