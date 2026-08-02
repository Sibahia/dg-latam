const assert = require('assert').strict;
const { applyDevServerEnv } = require('../tools/runDevServer');

const env = {
    MULTIPLAYER_MODE: 'true',
    GAME_MONGODB_URI: 'mongodb://game.example.invalid:27017',
    MONGODB_URI: 'mongodb://legacy.example.invalid:27017',
    SPONSOR_MONGODB_URI: 'mongodb://sponsor.example.invalid:27017',
    ENABLE_MONGO_GAME_DATA: 'true',
    SPONSOR_ACCOUNT_CREATION_REQUIRED: 'true'
};

applyDevServerEnv(env);

assert.equal(env.MULTIPLAYER_MODE, 'false');
assert.equal(env.ENABLE_MONGO_GAME_DATA, 'false');
assert.equal(env.GAME_MONGODB_URI, '');
assert.equal(env.MONGODB_URI, '');
assert.equal(env.SPONSOR_MONGODB_URI, '');
assert.equal(env.SPONSOR_ACCOUNT_CREATION_REQUIRED, 'false');

console.log('dev_server_env_regression: ok');
