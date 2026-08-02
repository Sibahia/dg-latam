import * as fs from 'fs';

function stripUtf8Bom(content: string): string {
    return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

export function readJsonFile<T>(filePath: string): T {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(stripUtf8Bom(raw)) as T;
}
