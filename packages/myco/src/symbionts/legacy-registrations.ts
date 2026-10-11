import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { MYCO_MCP_SERVER_NAME } from '@myco/member/registration-ownership.js';
import { hookVerdict, legacyRegistrationAt as at, type LegacyFinding } from '@myco/member/legacy-registration-files.js';
export { type LegacyLocationKind, type LegacyLocation, LEGACY_REGISTRATIONS, CLAUDE_PROJECT_MCP, type LegacyTarget, legacyTargets, type LegacyFinding, type LegacyScan, hookVerdict, pluginVerdict, type ScanOptions, scanLegacyRegistrations, mcpVerdict, type Verdict } from '@myco/member/legacy-registration-files.js';

/** Write `content` over `file` atomically, keeping the file's mode. */
export function rewriteKeepingMode(file: string, content: string): void {
  const mode = fs.statSync(file).mode & 0o7777;
  atomicWriteFileSync(file, content, { mode });
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isLegacyHook = (item: unknown, legacyHomes: readonly string[]): boolean =>
  isRecord(item) && typeof item.command === 'string' && hookVerdict(item.command, legacyHomes) === 'legacy';

/**
 * Drop every hook entry whose command is a 1.4 one, then every group the drop
 * left without hooks, then every event left without groups. Every other entry
 * and key is kept as it was.
 */
function withoutLegacyHooks(node: unknown, legacyHomes: readonly string[]): unknown {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (isLegacyHook(item, legacyHomes)) continue;
      const hadHooks = isRecord(item) && Array.isArray(item.hooks) && item.hooks.length > 0;
      const kept = withoutLegacyHooks(item, legacyHomes);
      if (hadHooks && !(isRecord(kept) && Array.isArray(kept.hooks) && kept.hooks.length > 0)) continue;
      out.push(kept);
    }
    return out;
  }
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const kept = withoutLegacyHooks(value, legacyHomes);
    if (Array.isArray(value) && Array.isArray(kept) && value.length > 0 && kept.length === 0) continue;
    out[key] = kept;
  }
  return out;
}

/**
 * Remove the 1.4 registrations planned for one file: its hook entries, its
 * `myco` MCP entries, the file itself (a plugin file or its manifest), or a
 * skill link, repointed at `ownHome`'s own skill when that exists. Answers one
 * line for each change. The caller backs the file up first.
 */
export function removeLegacyRegistrations(file: string, planned: readonly LegacyFinding[], legacyHomes: readonly string[], ownHome?: string): string[] {
  const homes = legacyHomes.map((home) => path.resolve(home));
  const mine = planned.filter((f) => f.file === file && f.verdict === 'legacy');
  if (mine.length === 0) return [];
  if (mine.some((f) => f.location.kind === 'skills')) {
    const replacement = ownHome === undefined ? null : path.join(ownHome, 'skills', path.basename(file));
    fs.unlinkSync(file);
    if (replacement !== null && fs.existsSync(replacement)) {
      fs.symlinkSync(replacement, file);
      return [`pointed ${file} at ${replacement}`];
    }
    return [`removed the skill link ${file}`];
  }
  if (mine.some((f) => f.location.kind === 'plugin-file' || f.location.kind === 'plugin-manifest')) {
    fs.unlinkSync(file);
    return [`removed ${file}`];
  }
  const raw = fs.readFileSync(file, 'utf8');
  const toml = mine.some((f) => f.location.format === 'toml');
  const parsed = (toml ? parseToml(raw) : JSON.parse(raw)) as Record<string, unknown>;
  const removed: string[] = [];
  if (mine.some((f) => f.location.kind === 'hooks') && parsed.hooks !== undefined) {
    parsed.hooks = withoutLegacyHooks(parsed.hooks, homes);
    const n = mine.filter((f) => f.location.kind === 'hooks').length;
    removed.push(`removed ${n} 1.4 hook${n === 1 ? '' : 's'} from ${file}`);
  }
  for (const finding of mine.filter((f) => f.location.kind === 'mcp' && f.serversPath !== undefined)) {
    const servers = at(parsed, finding.serversPath!);
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    delete (servers as Record<string, unknown>)[MYCO_MCP_SERVER_NAME];
    removed.push(`removed the 1.4 \`${MYCO_MCP_SERVER_NAME}\` MCP entry${finding.serversPath!.length > 1 ? ` for ${finding.serversPath![1]}` : ''} from ${file}`);
  }
  rewriteKeepingMode(file, toml ? `${stringifyToml(parsed)}\n` : `${JSON.stringify(parsed, null, 2)}\n`);
  return removed;
}
