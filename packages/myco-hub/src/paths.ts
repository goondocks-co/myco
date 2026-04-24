import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const HUB_DIR = path.join(os.homedir(), '.myco', 'hub');
export const CONFIG_PATH = path.join(HUB_DIR, 'config.json');
export const PROJECTS_PATH = path.join(HUB_DIR, 'projects.json');
export const PID_PATH = path.join(HUB_DIR, 'hub.pid');
export const LOG_PATH = path.join(HUB_DIR, 'hub.log');
export const DEFAULT_PORT = 21000;
export const DEFAULT_HOST = '127.0.0.1';

const HubConfigSchema = z.object({
  version: z.literal(1).default(1),
  host: z.string().default(DEFAULT_HOST),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  reconcile_running_daemons: z.boolean().default(true),
});

export type HubConfig = z.infer<typeof HubConfigSchema>;

export function ensureHubDir(): void {
  fs.mkdirSync(HUB_DIR, { recursive: true });
}

export function loadConfig(): HubConfig {
  ensureHubDir();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as unknown;
    return HubConfigSchema.parse(raw);
  } catch {
    return HubConfigSchema.parse({});
  }
}

export function saveConfig(config: HubConfig): void {
  ensureHubDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function appendLog(message: string, meta?: Record<string, unknown>): void {
  ensureHubDir();
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}
