// This module must be the first import of every regression test. Config and
// Mongo game-data adapters capture Mongo settings when their modules load, so
// the env overrides below have to run before any other server module is
// evaluated.
// Regression tests must never reach a real Mongo cluster, no matter what
// src/server/.env or the shell environment contains.
process.env.ENABLE_MONGO_GAME_DATA = 'false';
process.env.MONGODB_URI = '';
process.env.GAME_MONGODB_URI = '';
process.env.SPONSOR_MONGODB_URI = '';
