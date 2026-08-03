import * as fs from 'fs';
import * as path from 'path';

// Generates src/server/data/gear_catalog.json from the game's canonical sources:
//   - gear_data.json (ids, base name, type, rarity per id)
//   - GearTypes.xml  (DisplayName + UsedBy per GearID)
//
// The catalog is committed so the server (and the Docker image, which does not
// ship content/xml) has a self-contained source of gear names/classes. At
// runtime the catalog is mirrored into a Mongo `gear_catalog` collection via an
// auto-seed, and the admin "Equipo" grant dropdown reads from there.

function getXmlAttribute(attrs: string, name: string): string | null {
    const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
    return match?.[1] ?? null;
}

function getXmlTagValue(body: string, tagName: string): string {
    const match = body.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i'));
    return match?.[1] ?? '';
}

function main(): void {
    const dataDir = process.env.DATA_DIR
        ? path.resolve(process.env.DATA_DIR)
        : path.resolve(__dirname, '..');
    const gearDataPath = path.join(dataDir, 'data', 'gear_data.json');
    const outputPath = path.join(dataDir, 'data', 'gear_catalog.json');

    const candidates = [
        path.resolve(dataDir, '..', 'client', 'content', 'xml', 'GearTypes.xml'),
        path.resolve(dataDir, '..', '..', 'client', 'content', 'xml', 'GearTypes.xml'),
        path.resolve(process.cwd(), 'src', 'client', 'content', 'xml', 'GearTypes.xml'),
        path.resolve(process.cwd(), 'client', 'content', 'xml', 'GearTypes.xml')
    ];
    const xmlPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!xmlPath) {
        console.error('[GenGear] GearTypes.xml not found; usedBy will be empty for all entries.');
    }

    const raw = JSON.parse(fs.readFileSync(gearDataPath, 'utf8'));
    const details = raw?.all_gear_details;
    if (!details || typeof details !== 'object') {
        throw new Error('[GenGear] gear_data.json missing all_gear_details.');
    }

    const xmlMeta = new Map<number, { displayName: string; usedBy: string; gearName: string }>();
    if (xmlPath) {
        const xml = fs.readFileSync(xmlPath, 'utf8');
        const blockPattern = /<Gear\s+([^>]*?)>([\s\S]*?)<\/Gear>/g;
        let match: RegExpExecArray | null;
        while ((match = blockPattern.exec(xml)) !== null) {
            const attrs = match[1] ?? '';
            const body = match[2] ?? '';
            const gearId = Number(getXmlAttribute(attrs, 'GearID') ?? 0);
            if (!Number.isFinite(gearId) || gearId <= 0) {
                continue;
            }
            const gearName = getXmlAttribute(attrs, 'GearName') ?? '';
            const existing = xmlMeta.get(gearId);
            // Prefer the non-rare variant (plain name) when both exist.
            if (!existing || /\d[RL]$/.test(existing.gearName)) {
                xmlMeta.set(gearId, {
                    displayName: getXmlTagValue(body, 'DisplayName') || gearName || `#${gearId}`,
                    usedBy: getXmlTagValue(body, 'UsedBy').trim(),
                    gearName
                });
            }
        }
        console.log(`[GenGear] Parsed ${xmlMeta.size} gear entries from ${path.basename(xmlPath)}.`);
    }

    const seen = new Map<number, { id: number; name: string; displayName: string; type: string; rarity: string; usedBy: string }>();
    for (const rawId of Object.keys(details)) {
        const id = Number(rawId);
        if (!Number.isSafeInteger(id) || id <= 0) {
            continue;
        }
        const variants = details[rawId];
        const base = Array.isArray(variants)
            ? variants.find((variant: { realm?: string | null }) => !variant?.realm) ?? variants[0]
            : null;
        if (!base) {
            continue;
        }
        const name = String(base.name ?? '').trim();
        if (!name) {
            continue;
        }
        if (!seen.has(id)) {
            const meta = xmlMeta.get(id);
            const usedByRaw = String(meta?.usedBy ?? '').trim();
            seen.set(id, {
                id,
                name,
                displayName: meta?.displayName || name,
                type: String(base.type ?? ''),
                rarity: String(base.rarity ?? ''),
                usedBy: usedByRaw.toLowerCase()
            });
        }
    }

    const sorted = [...seen.values()].sort((a, b) => a.id - b.id);
    fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    console.log(`[GenGear] Wrote ${sorted.length} gear entries to ${outputPath}.`);
}

main();