import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "./swzPatchUtils";

function repoRoot(): string {
    return path.resolve(__dirname, "..", "..", "..");
}

const ROOT = repoRoot();
const SWZ_PATH = path.join(ROOT, "src", "client", "content", "localhost", "p", "cbq", "Game.swz");
const POWER_MODS_XML = path.join(ROOT, "src", "client", "content", "xml", "PowerModTypes.xml");
const ABILITY_TYPES_XML = path.join(ROOT, "src", "client", "content", "xml", "AbilityTypes.xml");

// Discipline order (Mage x3, Rogue x3, Paladin x3) matching the game's MasterClassID order.
const CLASSES = ["Mage", "Rogue", "Paladin"];
const DISCIPLINES = [
    "FrostWarden", "Flameseer", "Necromancer",
    "Executioner", "ShadowWalker", "Soulthief",
    "Sentinel", "Justicar", "Templar"
];

// Socket ring visual layout from the archived talent calculator (positions + connections).
const SOCKET_POSITIONS: Array<[number, number]> = [
    [44, 342], [77, 304], [43, 259], [89, 235], [72, 182], [130, 157], [145, 94],
    [201, 102], [234, 50], [372, 52], [394, 97], [446, 84], [447, 136], [500, 138],
    [505, 205], [558, 245], [527, 291], [559, 341], [481, 493], [425, 490], [406, 542],
    [361, 518], [327, 556], [271, 529], [211, 549], [189, 498], [127, 495]
];
const SOCKET_CONNECTIONS: number[][] = [
    [2], [3], [0, 4], [1, 5], [2, 5], [3, 4, 6, 7], [5, 8], [5, 8], [6, 7, 9, 10],
    [8, 11], [8, 12], [9, 13], [10, 14], [11, 14], [12, 13, 15, 16], [14, 17], [14, 17],
    [15, 16, 18, 19], [17, 20], [17, 21], [18, 22], [19, 23], [20, 23], [21, 22, 24, 25],
    [23, 26], [23, 26], [24, 25]
];
// Capacities per socket (0-indexed), authoritative: game const_529 == server TalentConfig.CONST_529.
const SOCKET_CAPACITIES = [5, 2, 3, 5, 5, 3, 2, 3, 2, 5, 2, 3, 5, 5, 3, 2, 3, 2, 5, 2, 3, 5, 5, 3, 2, 3, 2];

const SKILL_PREREQ_POINTS = [0, 20, 40];
const SKILL_PREREQ_SOCKET = [-1, 8, 18];
const SKILL_SLOT_POSITIONS: Array<[number, number]> = [
    [86, 405], [305, 61], [523, 405]
];

const GENERIC_FAMILIES = [
    { root: /^Attack/, name: "Attack", parameter: "Attack" },
    { root: /^DefensePaladin/, name: "Defense", parameter: "Defense" },
    { root: /^Expertise/, name: "Expertise", parameter: "Expertise" },
    { root: /^Health/, name: "Health", parameter: "Health" },
    { root: /^Recover/, name: "Recovery", parameter: "Recovery" }
];

interface PowerMod { modName: string; modID: number; displayName: string; description: string; modType: string; icon: string; }
type ModGroup = { root: string; mods: PowerMod[] };

function parsePowerModTypes(xml: string): Map<string, ModGroup> {
    const groups = new Map<string, ModGroup>();
    const re = /<PowerModType>([\s\S]*?)<\/PowerModType>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        const body = m[1];
        const modName = (body.match(/<ModName>([^<]+)<\/ModName>/) || [])[1];
        if (!modName) continue;
        const rankMatch = modName.match(/(\d+)$/);
        if (!rankMatch) continue;
        const root = modName.slice(0, -rankMatch[1].length);
        if (!groups.has(root)) groups.set(root, { root, mods: [] });
        groups.get(root)!.mods.push({
            modName,
            modID: Number((body.match(/<ModID>(\d+)<\/ModID>/) || [])[1] ?? 0),
            displayName: (body.match(/<DisplayName>([^<]*)<\/DisplayName>/) || [])[1] ?? "",
            description: (body.match(/<Description>([^<]*)<\/Description>/) || [])[1] ?? "",
            modType: (body.match(/<ModType>([^<]*)<\/ModType>/) || [])[1] ?? "",
            icon: (body.match(/<IconName>([^<]*)<\/IconName>/) || [])[1] ?? ""
        });
    }
    return groups;
}

function parseNodeTypes(xml: string): Map<string, Map<number, string>> {
    // classKey (lowercased) -> nodeID -> root key
    const result = new Map<string, Map<number, string>>();
    const nodeRe = /<NodeType[^>]*NodeID="(\d+)"[^>]*>([\s\S]*?)<\/NodeType>/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
        const nodeID = Number(m[1]);
        const body = m[2];
        const childRe = /<(\w+)>([A-Za-z0-9]+)<\/\1>/g;
        let c: RegExpExecArray | null;
        while ((c = childRe.exec(body)) !== null) {
            const clsKey = c[1].toLowerCase();
            if (!result.has(clsKey)) result.set(clsKey, new Map());
            result.get(clsKey)!.set(nodeID, c[2]);
        }
    }
    return result;
}

function parseSkills(xml: string): Map<string, Array<{ name: string; id: number }>> {
    const byClass = new Map<string, Array<{ name: string; id: number }>>();
    const abilityRe = /<Ability[^>]*>([\s\S]*?)<\/Ability>/g;
    let m: RegExpExecArray | null;
    while ((m = abilityRe.exec(xml)) !== null) {
        const full = m[0];
        const body = m[1];
        const nameMatch = full.match(/<Ability[^>]*AbilityName="([^"]+)"/);
        if (!nameMatch) continue;
        const cls = (body.match(/<Class>([^<]+)<\/Class>/) || [])[1];
        const loc = Number((body.match(/<HotbarLocation>(\d+)<\/HotbarLocation>/) || [])[1] ?? -1);
        const rank = Number((body.match(/<Rank>(\d+)<\/Rank>/) || [])[1] ?? 1);
        if (!cls || ![4, 5, 6].includes(loc) || rank !== 1) continue;
        const clsKey = cls.toLowerCase();
        if (!byClass.has(clsKey)) byClass.set(clsKey, []);
        byClass.get(clsKey)!.push({
            name: nameMatch[1],
            id: Number((body.match(/<AbilityID>(\d+)<\/AbilityID>/) || [])[1] ?? 0)
        });
    }
    return byClass;
}

function normalizeValue(raw: string): string {
    let v = raw.trim();
    v = v.replace(/^\+/, "");
    v = v.replace(/^\./, "0.");
    v = v.replace(/\.0(?=[^0-9]|$)/, "");
    return v;
}

function parseDescription(desc: string): { flavor: string; groups: Array<{ parameter: string; values: string[] }> } {
    const at = desc.indexOf("@");
    if (at === -1) {
        return { flavor: desc.trim(), groups: [] };
    }
    const flavor = desc.slice(0, at).trim();
    const rest = desc.slice(at + 1);
    const groups = rest.split("@").map((part) => {
        const sep = part.search(/:\s*,|:,/);
        const parameter = (sep === -1 ? part : part.slice(0, sep)).trim();
        const valuesRaw = sep === -1 ? "" : part.slice(part.indexOf(",", sep) + 1);
        const values = valuesRaw.split(",").map(normalizeValue).filter((v) => v.length > 0);
        return { parameter, values };
    }).filter((g) => g.values.length > 0);
    return { flavor, groups };
}

function talentParameter(r1: PowerMod, groups: Array<{ parameter: string; values: string[] }>): { parameter: string | string[]; values: string[] | string[][] } {
    if (groups.length === 0) {
        return { parameter: r1.displayName, values: [] };
    }
    if (groups.length === 1) {
        return { parameter: groups[0].parameter, values: groups[0].values };
    }
    return {
        parameter: groups.map((g) => g.parameter),
        values: groups.map((g) => g.values)
    };
}

function noAdd(flavor: string): boolean {
    return /^(gain|heal)|deal extra/i.test(flavor);
}

function main(): void {
    const swz = parseSwz(SWZ_PATH);
    const nodeTypesXml = swz.chunks[16].xml;
    const nodeTypes = parseNodeTypes(nodeTypesXml);
    const groups = parsePowerModTypes(fs.readFileSync(POWER_MODS_XML, "utf8"));
    const skills = parseSkills(fs.readFileSync(ABILITY_TYPES_XML, "utf8"));

    const outDir = path.join(ROOT, "src", "client", "content", "localhost", "calculadora", "data");
    fs.mkdirSync(outDir, { recursive: true });

    const tree: Record<string, unknown> = {
        classes: CLASSES,
        disciplines: DISCIPLINES,
        maxPoints: 90,
        talentSlots: SOCKET_POSITIONS.map((pos, i) => ({
            id: i,
            pos,
            capacity: SOCKET_CAPACITIES[i],
            connections: SOCKET_CONNECTIONS[i]
        })),
        skillSlots: SKILL_SLOT_POSITIONS.map((pos, i) => ({
            pos,
            pointsRequired: SKILL_PREREQ_POINTS[i],
            connection: SKILL_PREREQ_SOCKET[i]
        }))
    };
    fs.writeFileSync(path.join(outDir, "tree.json"), JSON.stringify(tree, null, 2), "utf8");
    console.log("wrote tree.json");

    let skipped = 0;
    for (const discipline of DISCIPLINES) {
        const clsKey = discipline.toLowerCase();
        const treeByNode = nodeTypes.get(clsKey);
        if (!treeByNode) {
            console.log("MISSING node tree for", discipline);
            skipped++;
            continue;
        }

        const genericForRoot = (root: string): { name: string; parameter: string } | null => {
            for (const fam of GENERIC_FAMILIES) {
                if (fam.root.test(root)) return { name: fam.name, parameter: fam.parameter };
            }
            return null;
        };

        // Resolve each node's root and mod group up front.
        type ResolvedNode = { nodeID: number; root: string; r1: PowerMod; flavor: string; parameter: string | string[]; values: string[] | string[][]; icon: string; generic: { name: string; parameter: string } | null };
        const resolved: ResolvedNode[] = [];
        for (let nodeID = 1; nodeID <= 42; nodeID++) {
            const root = treeByNode.get(nodeID);
            if (!root) {
                skipped++;
                continue;
            }
            const group = groups.get(root);
            if (!group || group.mods.length < 5) {
                console.log("MISSING mod group for", discipline, "node", nodeID, "root", root);
                skipped++;
                continue;
            }
            const r1 = group.mods[0];
            const { flavor, groups: paramGroups } = parseDescription(r1.description);
            const { parameter, values } = talentParameter(r1, paramGroups);
            resolved.push({
                nodeID,
                root,
                r1,
                flavor,
                parameter,
                values,
                icon: r1.icon,
                generic: genericForRoot(root)
            });
        }

        // First pass: build the stats category list (generics first in fixed order, then specials by first appearance).
        const statIndex = new Map<string, number>();
        const statCats: Array<{ key: string; name: string; parameter: string | string[]; description: string; icon: string; noAdd: boolean }> = [];
        const usedGeneric = new Set<string>();
        for (const rn of resolved) {
            if (rn.generic) usedGeneric.add(rn.generic.name);
        }
        for (const fam of GENERIC_FAMILIES) {
            if (usedGeneric.has(fam.name)) {
                statIndex.set(fam.name, statCats.length);
                statCats.push({
                    key: fam.name, name: fam.name, parameter: fam.parameter,
                    description: "Increases " + fam.name, icon: "", noAdd: false
                });
            }
        }
        for (const rn of resolved) {
            if (rn.generic) continue;
            if (!statIndex.has(rn.root)) {
                statIndex.set(rn.root, statCats.length);
                statCats.push({
                    key: rn.root,
                    name: rn.r1.displayName,
                    parameter: rn.parameter,
                    description: rn.flavor,
                    icon: rn.icon,
                    noAdd: noAdd(rn.flavor)
                });
            }
        }

        const talents: unknown[] = [];
        for (const rn of resolved) {
            const tier = Math.floor((rn.nodeID - 1) / 3) + 1;
            const slot = ((rn.nodeID - 1) % 3) + 1;
            const key = rn.generic ? rn.generic.name : rn.root;
            const statId = statIndex.get(key) ?? 0;
            const nadd = noAdd(rn.flavor);
            talents.push({
                name: rn.r1.displayName,
                tier: [tier, slot],
                description: rn.flavor,
                parameter: rn.parameter,
                values: rn.values,
                stat: statId,
                icon: rn.icon,
                no_add: rn.generic ? false : nadd
            });
        }

        const finalStatsOut = statCats.map((c) => ({
            icon: c.icon,
            parameter: c.parameter,
            description: c.description,
            name: c.name,
            no_add: c.noAdd
        }));

        const skillList = (skills.get(discipline.toLowerCase()) || []).slice(0, 3);
        const data: Record<string, unknown> = {
            talents,
            skills: skillList.map((s) => ({ name: s.name, description: "" })),
            stats: finalStatsOut
        };
        fs.writeFileSync(path.join(outDir, discipline.toLowerCase() + ".json"), JSON.stringify(data, null, 2), "utf8");
        console.log("wrote", discipline.toLowerCase() + ".json", "| talents", (talents as unknown[]).length, "| stats", finalStatsOut.length, "| skills", skillList.map((s) => s.name).join(", "));
    }
    console.log("done, skipped", skipped);
}

main();
