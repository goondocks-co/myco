import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadManifests } from '@myco/symbionts/detect.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
import { MEMBER_PLUGIN_MARKER, MYCO_PLUGIN_FILE_MARKER } from '@myco/symbionts/legacy-verdict.js';

export interface RepositoryEntry {
  root: string;
  file: string;
  entry: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const MCP_KEYS = ['mcpServers', 'servers', 'mcp', 'mcp_servers'] as const;

/** Read repository harness entries by name, without returning credentials or changing their files. */
export function repositoryMycoEntries(roots: Iterable<string>): RepositoryEntry[] {
  const targets = new Set(loadManifests().flatMap(({ registration: reg }) => reg
    ? [reg.hooksTarget, reg.memberHooksTarget, reg.mcpTarget].filter((target): target is string => Boolean(target)) : []));
  const found: RepositoryEntry[] = [];
  for (const root of new Set([...roots].map(root => path.resolve(root)))) {
    for (const target of targets) {
      const file = path.join(root, target);
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        found.push({ root, file, entry: 'unreadable (entries unknown)' });
        continue;
      }
      if (/\.[cm]?[jt]s$/.test(target)) {
        if (raw.includes(MEMBER_PLUGIN_MARKER) || raw.includes(MYCO_PLUGIN_FILE_MARKER)) found.push({ root, file, entry: 'Myco plugin' });
        continue;
      }
      let data: unknown;
      try { data = target.endsWith('.toml') ? parseToml(raw) : JSON.parse(raw); }
      catch {
        found.push({ root, file, entry: 'unreadable (entries unknown)' });
        continue;
      }
      if (!object(data)) {
        found.push({ root, file, entry: 'unreadable (entries unknown)' });
        continue;
      }
      for (const key of MCP_KEYS) {
        const servers = data[key];
        if (object(servers) && Object.hasOwn(servers, 'myco')) found.push({ root, file, entry: `${key}.myco` });
      }
      if (object(data.hooks)) {
        for (const [event, groups] of Object.entries(data.hooks)) {
          if (hookCommands({ [event]: groups }).some(rawHasMycoOwnershipSignal)) found.push({ root, file, entry: `hooks.${event} (Myco commands)` });
        }
      }
    }
  }
  return found;
}
