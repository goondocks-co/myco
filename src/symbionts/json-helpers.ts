import fs from 'node:fs';
import path from 'node:path';

export function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Write a JSON file, or delete it if the object is empty. */
export function writeOrDeleteJsonFile(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    writeJsonFile(filePath, data);
  }
}
