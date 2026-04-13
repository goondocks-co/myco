import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveHomeConfigPath(configDir: string, fileName: string): string {
  return path.join(os.homedir(), configDir, fileName);
}

export function readJsonConfig<T>(configPath: string): T | null {
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as T;
}

export function writeJsonConfig(configPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

export function maskSecret(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return secret;
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function createHexToken(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('hex');
}
