const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const serverDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverDir, '..', '..');
const manifestPath = path.join(__dirname, 'client-patch-provenance.json');

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || !manifest.artifacts || typeof manifest.artifacts !== 'object') {
        throw new Error('Invalid client-patch provenance manifest.');
    }

    for (const [relativePath, entry] of Object.entries(manifest.artifacts)) {
        if (!entry || typeof entry.sha256 !== 'string' || !Array.isArray(entry.staticVerifiers)) {
            throw new Error(`Invalid provenance entry for ${relativePath}.`);
        }
        const artifactPath = path.resolve(repoRoot, relativePath);
        const actual = sha256(artifactPath);
        if (actual !== entry.sha256) {
            throw new Error(`${relativePath} digest mismatch: expected ${entry.sha256}, got ${actual}. Re-run its verified patch chain and update the manifest in the same change.`);
        }
        for (const script of entry.staticVerifiers) {
            if (typeof script !== 'string' || !fs.existsSync(path.join(serverDir, 'scripts', script))) {
                throw new Error(`${relativePath} references missing verifier ${String(script)}.`);
            }
        }
        console.log(`[client-patch-provenance] ${relativePath}: ${entry.staticVerifiers.length} static verifiers, sha256 verified.`);
    }
}

try {
    main();
} catch (error) {
    console.error(`[client-patch-provenance] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
