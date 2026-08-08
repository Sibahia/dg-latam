const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'temp']);
const jsonFiles = [];

function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(absolutePath);
        else if (entry.isFile() && entry.name.endsWith('.json')) jsonFiles.push(absolutePath);
    }
}

collect(repoRoot);
const failures = [];
for (const file of jsonFiles.sort()) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw.charCodeAt(0) === 0xfeff) {
            throw new Error('unexpected UTF-8 BOM');
        }
        JSON.parse(raw);
    } catch (error) {
        failures.push(`${path.relative(repoRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

if (failures.length > 0) {
    console.error(`[json-data] ${failures.length} invalid JSON file(s):`);
    for (const failure of failures) console.error(`[json-data] ${failure}`);
    process.exitCode = 1;
} else {
    console.log(`[json-data] ${jsonFiles.length} JSON files parsed without BOMs.`);
}
