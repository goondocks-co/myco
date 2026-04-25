import fs from 'node:fs';

export function tryParseJson<T>(raw: unknown, validator: (value: unknown) => value is T): T | null;
export function tryParseJson(raw: unknown): unknown;
export function tryParseJson<T>(raw: unknown, validator?: (value: unknown) => value is T): T | unknown | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!validator) return parsed;
  return validator(parsed) ? parsed : null;
}

export function readJsonFile<T>(filePath: string, validator: (value: unknown) => value is T): T | null;
export function readJsonFile(filePath: string): unknown;
export function readJsonFile<T>(filePath: string, validator?: (value: unknown) => value is T): T | unknown | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  return validator ? tryParseJson(raw, validator) : tryParseJson(raw);
}
