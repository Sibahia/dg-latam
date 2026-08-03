// Maps the Turkish gear display names shipped in GearTypes.xml back to the
// English names of the original game. The Turkish names are literal token-for-
// token translations of the English ones ("Sovalyeci Balta Goblin Seviye 3" ==
// "Paladin Axe Goblin Level 3"), so a small dictionary is enough to restore the
// English catalog used by the admin "Equipo" grant dropdown.

export const TR_TO_EN: Readonly<Record<string, string>> = {
    // Classes
    'Sovalyeci': 'Paladin',
    'Haydut': 'Rogue',
    'Buyucu': 'Mage',
    // Equipment types
    'Balta': 'Axe',
    'Gurz': 'Mace',
    'Kilic': 'Sword',
    'Pala': 'Saber',
    'Asa': 'Staff',
    'Kalkan': 'Shield',
    'Zirh': 'Armor',
    'Migfer': 'Helmet',
    'Kusak': 'Belt',
    'Kapuson': 'Hood',
    'Mucevher': 'Jewelry',
    'Cizme': 'Boots',
    'Eldiven': 'Gloves',
    'Ayaklik': 'Feet',
    'Ayakkabi': 'Shoes',
    'Bileklik': 'Bracers',
    'El': 'Hand',
    'Odak': 'Focus',
    'Elbise': 'Dress',
    'Ates': 'Fire',
    'Buz': 'Ice',
    'Yasam': 'Life',
    'Baslik': 'Hat',
    // Enemy / theme words
    'Goblin': 'Goblin',
    'Iskelet': 'Skeleton',
    'Hayalet': 'Ghost',
    'Ejderha': 'Dragon',
    'Ejder': 'Dragon',
    'Kertenkele': 'Lizard',
    'Imparatorluk': 'Imperial',
    'Dev': 'Giant',
    'Iblis': 'Demon',
    'Tepegoz': 'Cyclops',
    'Mumya': 'Mummy',
    'Bokbocegi': 'Scarab',
    'Ruh': 'Soul',
    'Cakal': 'Jackal',
    'Rahip': 'Priest',
    'Orumcek': 'Spider',
    'Kopek': 'Hound',
    'Aslan': 'Lion',
    'Dehset': 'Horror',
    'Agacadam': 'Treant',
    'Hilkat': 'Creature',
    'Yapi': 'Construct',
    'Golge': 'Shadow',
    'Kaya': 'Rock',
    'Doga': 'Nature',
    'Kopru': 'Bridge',
    'Yirtici': 'Predator',
    'Lider': 'Leader',
    'Minotor': 'Minotaur',
    'Ratling': 'Ratling',
    'Imp': 'Imp',
    'Griffon': 'Griffon',
    'Dryad': 'Dryad',
    'Insan': 'Human',
    'Yutucu': 'Devourer',
    'Cadilar': 'Witches',
    'Bayrami': 'Festival',
    'Tapinakci': 'Templar',
    'Hirsizi': 'Thief',
    'Olucagiran': 'Necromancer',
    // Modifiers / qualifiers
    'Ozel': 'Special',
    'Baslangic': 'Starter',
    'Magaza': 'Store',
    'Giris': 'Intro',
    'Seviye': 'Level',
    'Nadir': 'Rare',
    'Efsanevi': 'Legendary'
};

// Multi-word tokens that read as a single English equipment name.
const PHRASE_TR_TO_EN: Readonly<Record<string, string>> = {
    'Ince Kilic': 'Rapier',
    'Yedek El': 'Offhand',
    'Cadilar Bayrami': "Witches' Festival",
    'Ruh Hirsizi': 'Soul Thief'
};

const NUMBER_RE = /^[0-9]+$/;

export function translateGearDisplayName(value: string): string {
    const tokens = String(value ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const parts: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const pair = index + 1 < tokens.length ? `${tokens[index]} ${tokens[index + 1]}` : '';
        if (pair && Object.prototype.hasOwnProperty.call(PHRASE_TR_TO_EN, pair)) {
            parts.push(PHRASE_TR_TO_EN[pair]);
            index += 1;
            continue;
        }
        const token = tokens[index];
        if (NUMBER_RE.test(token)) {
            parts.push(token);
            continue;
        }
        parts.push(TR_TO_EN[token] ?? token);
    }
    return parts.join(' ');
}

// Returns the set of dictionary tokens that a batch of display names still
// uses, so generation can warn about untranslated gear names. Phrase keys are
// matched first so "Ince Kilic"/"Yedek El" are not flagged as untranslated.
export function collectUntranslatedTokens(displayNames: Iterable<string>): Set<string> {
    const untranslated = new Set<string>();
    for (const displayName of displayNames) {
        const tokens = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
        for (let index = 0; index < tokens.length; index += 1) {
            const pair = index + 1 < tokens.length ? `${tokens[index]} ${tokens[index + 1]}` : '';
            if (pair && Object.prototype.hasOwnProperty.call(PHRASE_TR_TO_EN, pair)) {
                index += 1;
                continue;
            }
            const token = tokens[index];
            if (NUMBER_RE.test(token) || Object.prototype.hasOwnProperty.call(TR_TO_EN, token)) {
                continue;
            }
            untranslated.add(token);
        }
    }
    return untranslated;
}
