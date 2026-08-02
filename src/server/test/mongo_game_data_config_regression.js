const assert = require('assert').strict;
const path = require('path');
const { execFileSync } = require('child_process');

const serverDir = path.resolve(__dirname, '..');

function readConfig(overrides) {
    const env = { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...overrides };
    delete env.ENABLE_MONGO_GAME_DATA;

    if (Object.prototype.hasOwnProperty.call(overrides, 'ENABLE_MONGO_GAME_DATA')) {
        env.ENABLE_MONGO_GAME_DATA = overrides.ENABLE_MONGO_GAME_DATA;
    }

    const output = execFileSync(
        process.execPath,
        [
            '-r',
            'ts-node/register',
            '-e',
            "const { Config } = require('./core/config'); process.stdout.write(JSON.stringify({ uri: Config.MONGODB_URI, db: Config.MONGODB_DB_NAME, enabled: Config.ENABLE_MONGO_GAME_DATA }));"
        ],
        { cwd: serverDir, env, encoding: 'utf8' }
    );

    return JSON.parse(output);
}

const sharedGameConfig = readConfig({
    GAME_MONGODB_URI: 'mongodb://game.example.invalid:27017',
    GAME_MONGODB_DB_NAME: 'minidb',
    MONGODB_URI: 'mongodb://legacy.example.invalid:27017',
    MONGODB_DB_NAME: 'legacy-db',
    MONGO_DB_NAME: 'sponsor-db'
});

assert.equal(sharedGameConfig.uri, 'mongodb://game.example.invalid:27017');
assert.equal(sharedGameConfig.db, 'minidb');
assert.equal(sharedGameConfig.enabled, true, 'Mongo game data should activate when a Mongo URI is configured');

const legacySponsorDbIgnored = readConfig({
    GAME_MONGODB_URI: '',
    GAME_MONGODB_DB_NAME: '',
    MONGODB_URI: 'mongodb://game.example.invalid:27017',
    MONGODB_DB_NAME: '',
    MONGO_DB_NAME: 'github-sponsors'
});

assert.equal(legacySponsorDbIgnored.db, 'minidb', 'legacy sponsor DB must not become game-data authority');

const explicitlyDisabled = readConfig({
    GAME_MONGODB_URI: 'mongodb://game.example.invalid:27017',
    GAME_MONGODB_DB_NAME: 'minidb',
    ENABLE_MONGO_GAME_DATA: 'false'
});

assert.equal(explicitlyDisabled.enabled, false, 'explicit wallet-only mode should remain supported');

console.log('mongo game data config regression tests passed');
