/**
 * Every place Myco 1.4.8 wrote a global hook, plugin or MCP entry for an
 * agent, and what a cutover finds and removes there.
 *
 * `LEGACY_REGISTRATIONS` is the list the 1.4.8 manifests declare
 * (`globalHooksTarget`, `globalMcpTarget` with its servers key and format,
 * `globalPluginManifestTarget`); `tests/symbionts/legacy-registrations.test.ts`
 * derives it again from copies of those manifests, whose git blob ids match
 * the `myco/v1.4.8` tag, and fails on any difference.
 *
 * An entry is one of:
 *   - `member`: a 2.0 member registration (it names the member credential); kept.
 *   - `legacy`: a 1.4 registration of a home being cut over: a hook or MCP
 *     entry with no credential that runs a binary under one of those homes, or
 *     a bare `myco` resolved on PATH, and names no other `MYCO_HOME`; a 1.4
 *     plugin file (its plugin marker, or a path under one of those homes).
 *     Removed.
 *   - `foreign`: a Myco registration of any other home. Never touched; a
 *     cutover refuses while one stands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { MEMBER_PLUGIN_MARKER, MYCO_MCP_SERVER_NAME, MYCO_PLUGIN_FILE_MARKER, rawHasMycoOwnershipSignal } from './installer.js';
import { commandVerdict, mcpVerdict, type Verdict } from './legacy-verdict.js';

export { mcpVerdict, type Verdict };

export type LegacyLocationKind = 'hooks' | 'mcp' | 'plugin-file' | 'plugin-manifest';

export interface LegacyLocation {
  agent: string;
  kind: LegacyLocationKind;
  /** `~`-relative, as the 1.4.8 manifest spells it. */
  path: string;
  /** For `mcp`: the key holding the servers map, and the file's format. */
  serversKey?: string;
  format?: 'json' | 'toml';
}

export const LEGACY_REGISTRATIONS: readonly LegacyLocation[] = [
  { agent: 'antigravity', kind: 'plugin-file', path: '~/.gemini/config/plugins/myco/hooks.json' },
  { agent: 'antigravity', kind: 'mcp', path: '~/.gemini/config/plugins/myco/mcp_config.json', serversKey: 'mcpServers', format: 'json' },
  { agent: 'antigravity', kind: 'plugin-manifest', path: '~/.gemini/config/plugins/myco/plugin.json' },
  { agent: 'claude-code', kind: 'hooks', path: '~/.claude/settings.json' },
  { agent: 'claude-code', kind: 'mcp', path: '~/.claude/settings.json', serversKey: 'mcpServers', format: 'json' },
  { agent: 'cline', kind: 'plugin-file', path: '~/.cline/plugins/myco.ts' },
  { agent: 'cline', kind: 'mcp', path: '~/.cline/data/settings/cline_mcp_settings.json', serversKey: 'mcpServers', format: 'json' },
  { agent: 'cline', kind: 'mcp', path: '~/.cline/mcp.json', serversKey: 'mcpServers', format: 'json' },
  { agent: 'codex', kind: 'hooks', path: '~/.codex/hooks.json' },
  { agent: 'codex', kind: 'mcp', path: '~/.codex/config.toml', serversKey: 'mcp_servers', format: 'toml' },
  { agent: 'copilot', kind: 'hooks', path: '~/.copilot/hooks/myco-hooks.json' },
  { agent: 'copilot', kind: 'mcp', path: '~/.copilot/mcp-config.json', serversKey: 'mcpServers', format: 'json' },
  { agent: 'copilot', kind: 'mcp', path: '~/Library/Application Support/Code/User/mcp.json', serversKey: 'servers', format: 'json' },
  { agent: 'cursor', kind: 'hooks', path: '~/.cursor/hooks.json' },
  { agent: 'cursor', kind: 'mcp', path: '~/.cursor/mcp.json', serversKey: 'mcpServers', format: 'json' },
  { agent: 'opencode', kind: 'plugin-file', path: '~/.config/opencode/plugins/myco.ts' },
  { agent: 'opencode', kind: 'mcp', path: '~/.config/opencode/opencode.json', serversKey: 'mcp', format: 'json' },
  { agent: 'pi', kind: 'plugin-file', path: '~/.pi/agent/extensions/myco/index.ts' },
  { agent: 'windsurf', kind: 'hooks', path: '~/.codeium/windsurf/hooks.json' },
  { agent: 'windsurf', kind: 'mcp', path: '~/.codeium/windsurf/mcp_config.json', serversKey: 'mcpServers', format: 'json' },
];

export const expandLegacyPath = (location: LegacyLocation, homeDir: string): string =>
  path.join(homeDir, location.path.replace(/^~\/?/, ''));

/** One Myco registration found at a 1.4 location. */
export interface LegacyFinding {
  location: LegacyLocation;
  file: string;
  verdict: Verdict;
  /** The hook command, MCP entry or file this is about, as a person reads it. */
  subject: string;
}

export interface LegacyScan {
  findings: LegacyFinding[];
  /** Files holding a Myco registration that could not be read or parsed. */
  unreadable: Array<{ file: string; reason: string }>;
}

/** The verdict on one hook command, or null when it is not Myco's. */
export function hookVerdict(command: string, legacyHomes: readonly string[]): Verdict | null {
  return rawHasMycoOwnershipSignal(command) ? commandVerdict(command, legacyHomes) : null;
}

/** The verdict on a whole file a 1.4 install wrote as a plugin, or null when it is not Myco's. */
export function pluginVerdict(content: string, legacyHomes: readonly string[]): Verdict | null {
  if (content.includes(MEMBER_PLUGIN_MARKER)) return 'member';
  let commands: string[] = [];
  try { commands = collectCommands(JSON.parse(content)); } catch { /* a module, not JSON */ }
  if (commands.length > 0) {
    const verdicts = commands.map((c) => hookVerdict(c, legacyHomes)).filter((v): v is Verdict => v !== null);
    if (verdicts.includes('foreign')) return 'foreign';
    if (verdicts.includes('legacy')) return 'legacy';
    return verdicts.includes('member') ? 'member' : null;
  }
  if (content.includes(MYCO_PLUGIN_FILE_MARKER) || legacyHomes.some((home) => content.includes(`${home}${path.sep}`))) return 'legacy';
  return rawHasMycoOwnershipSignal(content) ? 'foreign' : null;
}

function collectCommands(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectCommands);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const own = typeof record.command === 'string' ? [record.command] : [];
  return [...own, ...Object.entries(record).filter(([key]) => key !== 'command').flatMap(([, value]) => collectCommands(value))];
}

function readServers(raw: string, location: LegacyLocation): Record<string, unknown> | undefined {
  const parsed = (location.format === 'toml' ? parseToml(raw) : JSON.parse(raw)) as Record<string, unknown>;
  const servers = parsed[location.serversKey ?? 'mcpServers'];
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers as Record<string, unknown> : undefined;
}

/** What every 1.4 location on this machine holds, read-only. */
export function scanLegacyRegistrations(homeDir: string, legacyHomes: readonly string[], locations: readonly LegacyLocation[] = LEGACY_REGISTRATIONS): LegacyScan {
  const homes = legacyHomes.map((home) => path.resolve(home));
  const scan: LegacyScan = { findings: [], unreadable: [] };
  const pluginVerdicts = new Map<string, Verdict>();
  for (const location of locations) {
    if (location.kind === 'plugin-manifest') continue;
    const file = expandLegacyPath(location, homeDir);
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const add = (verdict: Verdict, subject: string) => scan.findings.push({ location, file, verdict, subject });
    try {
      if (location.kind === 'plugin-file') {
        const verdict = pluginVerdict(raw, homes);
        if (verdict === null) continue;
        pluginVerdicts.set(`${location.agent}\0${path.dirname(file)}`, verdict);
        add(verdict, file);
      } else if (location.kind === 'hooks') {
        for (const command of collectCommands((JSON.parse(raw) as { hooks?: unknown }).hooks)) {
          const verdict = hookVerdict(command, homes);
          if (verdict !== null) add(verdict, command);
        }
      } else {
        const entry = readServers(raw, location)?.[MYCO_MCP_SERVER_NAME];
        if (entry !== undefined) add(mcpVerdict(entry, homes), JSON.stringify(entry));
      }
    } catch (error) {
      if (rawHasMycoOwnershipSignal(raw) || raw.includes(`"${MYCO_MCP_SERVER_NAME}"`) || raw.includes(`${MYCO_MCP_SERVER_NAME}]`)) {
        scan.unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  for (const location of locations) {
    if (location.kind !== 'plugin-manifest') continue;
    const file = expandLegacyPath(location, homeDir);
    if (!fs.existsSync(file)) continue;
    const sibling = pluginVerdicts.get(`${location.agent}\0${path.dirname(file)}`);
    if (sibling === 'legacy') scan.findings.push({ location, file, verdict: 'legacy', subject: file });
  }
  return scan;
}

/** Write `content` over `file` atomically, keeping the file's mode. */
export function rewriteKeepingMode(file: string, content: string): void {
  const mode = fs.statSync(file).mode & 0o7777;
  atomicWriteFileSync(file, content, { mode });
}

/** Drop every hook entry whose command is a 1.4 one, and whatever the drop leaves empty. */
function withoutLegacyHooks(node: unknown, legacyHomes: readonly string[]): unknown {
  if (Array.isArray(node)) {
    return node
      .filter((item) => !(item && typeof item === 'object' && typeof (item as Record<string, unknown>).command === 'string'
        && hookVerdict((item as Record<string, unknown>).command as string, legacyHomes) === 'legacy'))
      .map((item) => withoutLegacyHooks(item, legacyHomes))
      .filter((item) => !(item && typeof item === 'object' && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).hooks)
        && ((item as Record<string, unknown>).hooks as unknown[]).length === 0));
  }
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const kept = withoutLegacyHooks(value, legacyHomes);
    if (Array.isArray(value) && Array.isArray(kept) && value.length > 0 && kept.length === 0) continue;
    out[key] = kept;
  }
  return out;
}

/**
 * Remove every 1.4 registration a scan found in one file: its hook entries,
 * its `myco` MCP entry, or (a plugin file or its manifest) the file itself.
 * Answers one line for each removal. The caller backs the file up first.
 */
export function removeLegacyRegistrations(file: string, findings: readonly LegacyFinding[], legacyHomes: readonly string[]): string[] {
  const homes = legacyHomes.map((home) => path.resolve(home));
  const mine = findings.filter((f) => f.file === file && f.verdict === 'legacy');
  if (mine.length === 0) return [];
  if (mine.some((f) => f.location.kind === 'plugin-file' || f.location.kind === 'plugin-manifest')) {
    fs.unlinkSync(file);
    return [`removed ${file}`];
  }
  const raw = fs.readFileSync(file, 'utf8');
  const toml = mine.some((f) => f.location.format === 'toml');
  const parsed = (toml ? parseToml(raw) : JSON.parse(raw)) as Record<string, unknown>;
  const removed: string[] = [];
  let next: Record<string, unknown> = parsed;
  if (mine.some((f) => f.location.kind === 'hooks') && parsed.hooks !== undefined) {
    next = { ...next, hooks: withoutLegacyHooks(parsed.hooks, homes) };
    removed.push(`removed ${mine.filter((f) => f.location.kind === 'hooks').length} 1.4 hooks from ${file}`);
  }
  for (const finding of mine.filter((f) => f.location.kind === 'mcp')) {
    const key = finding.location.serversKey ?? 'mcpServers';
    const servers = { ...(next[key] as Record<string, unknown>) };
    delete servers[MYCO_MCP_SERVER_NAME];
    next = { ...next, [key]: servers };
    removed.push(`removed the 1.4 \`${MYCO_MCP_SERVER_NAME}\` MCP entry from ${file}`);
  }
  rewriteKeepingMode(file, toml ? `${stringifyToml(next)}\n` : `${JSON.stringify(next, null, 2)}\n`);
  return removed;
}
