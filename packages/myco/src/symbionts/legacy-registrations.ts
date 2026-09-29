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
import { MYCO_MCP_SERVER_NAME, rawHasMycoOwnershipSignal } from './installer.js';
import { commandVerdict, mcpVerdict, pluginFileVerdict, type Verdict } from './legacy-verdict.js';

export { mcpVerdict, type Verdict };

export type LegacyLocationKind = 'hooks' | 'mcp' | 'plugin-file' | 'plugin-manifest' | 'skills';

export interface LegacyLocation {
  agent: string;
  kind: LegacyLocationKind;
  /** `global`: `~`-relative, as the 1.4.8 manifest spells it; `project`: relative to each connected folder. */
  scope: 'global' | 'project';
  path: string;
  /** For `mcp`: the key holding the servers map, and the file's format. */
  serversKey?: string;
  format?: 'json' | 'toml';
}

const g = (agent: string, kind: LegacyLocationKind, p: string, mcp: Pick<LegacyLocation, 'serversKey' | 'format'> = {}): LegacyLocation => ({ agent, kind, scope: 'global', path: p, ...mcp });
const pr = (agent: string, kind: LegacyLocationKind, p: string, mcp: Pick<LegacyLocation, 'serversKey' | 'format'> = {}): LegacyLocation => ({ agent, kind, scope: 'project', path: p, ...mcp });
const JSON_SERVERS = { serversKey: 'mcpServers', format: 'json' } as const;

export const LEGACY_REGISTRATIONS: readonly LegacyLocation[] = [
  g('antigravity', 'plugin-file', '~/.gemini/config/plugins/myco/hooks.json'),
  g('antigravity', 'mcp', '~/.gemini/config/plugins/myco/mcp_config.json', JSON_SERVERS),
  g('antigravity', 'plugin-manifest', '~/.gemini/config/plugins/myco/plugin.json'),
  g('antigravity', 'skills', '~/.agents/skills'),
  g('antigravity', 'skills', '~/.gemini/antigravity/skills'),
  pr('antigravity', 'plugin-file', '.agents/plugins/myco/hooks.json'),
  pr('antigravity', 'mcp', '.agents/plugins/myco/mcp_config.json', JSON_SERVERS),
  pr('antigravity', 'plugin-manifest', '.agents/plugins/myco/plugin.json'),
  g('claude-code', 'hooks', '~/.claude/settings.json'),
  g('claude-code', 'mcp', '~/.claude/settings.json', JSON_SERVERS),
  g('claude-code', 'skills', '~/.claude/skills'),
  pr('claude-code', 'hooks', '.claude/settings.json'),
  pr('claude-code', 'mcp', '.mcp.json', JSON_SERVERS),
  g('cline', 'plugin-file', '~/.cline/plugins/myco.ts'),
  g('cline', 'mcp', '~/.cline/data/settings/cline_mcp_settings.json', JSON_SERVERS),
  g('cline', 'mcp', '~/.cline/mcp.json', JSON_SERVERS),
  g('cline', 'skills', '~/.cline/skills'),
  pr('cline', 'plugin-file', '.cline/plugins/myco.ts'),
  pr('cline', 'mcp', '.cline/mcp.json', JSON_SERVERS),
  g('codex', 'hooks', '~/.codex/hooks.json'),
  g('codex', 'mcp', '~/.codex/config.toml', { serversKey: 'mcp_servers', format: 'toml' }),
  g('codex', 'skills', '~/.agents/skills'),
  g('codex', 'skills', '~/.codex/skills'),
  pr('codex', 'hooks', '.codex/hooks.json'),
  pr('codex', 'mcp', '.codex/config.toml', { serversKey: 'mcp_servers', format: 'toml' }),
  g('copilot', 'hooks', '~/.copilot/hooks/myco-hooks.json'),
  g('copilot', 'mcp', '~/.copilot/mcp-config.json', JSON_SERVERS),
  g('copilot', 'mcp', '~/Library/Application Support/Code/User/mcp.json', { serversKey: 'servers', format: 'json' }),
  g('copilot', 'skills', '~/.agents/skills'),
  g('copilot', 'skills', '~/.copilot/skills'),
  pr('copilot', 'hooks', '.github/hooks/myco-hooks.json'),
  pr('copilot', 'mcp', '.vscode/mcp.json', JSON_SERVERS),
  g('cursor', 'hooks', '~/.cursor/hooks.json'),
  g('cursor', 'mcp', '~/.cursor/mcp.json', JSON_SERVERS),
  g('cursor', 'skills', '~/.agents/skills'),
  g('cursor', 'skills', '~/.cursor/skills'),
  pr('cursor', 'hooks', '.cursor/hooks.json'),
  pr('cursor', 'mcp', '.cursor/mcp.json', JSON_SERVERS),
  g('opencode', 'plugin-file', '~/.config/opencode/plugins/myco.ts'),
  g('opencode', 'mcp', '~/.config/opencode/opencode.json', { serversKey: 'mcp', format: 'json' }),
  g('opencode', 'skills', '~/.agents/skills'),
  g('opencode', 'skills', '~/.config/opencode/skills'),
  pr('opencode', 'plugin-file', '.opencode/plugins/myco.ts'),
  pr('opencode', 'mcp', 'opencode.json', { serversKey: 'mcp', format: 'json' }),
  g('pi', 'plugin-file', '~/.pi/agent/extensions/myco/index.ts'),
  g('pi', 'skills', '~/.agents/skills'),
  g('pi', 'skills', '~/.pi/agent/skills'),
  pr('pi', 'plugin-file', '.pi/extensions/myco/index.ts'),
  g('windsurf', 'hooks', '~/.codeium/windsurf/hooks.json'),
  g('windsurf', 'mcp', '~/.codeium/windsurf/mcp_config.json', JSON_SERVERS),
  g('windsurf', 'skills', '~/.agents/skills'),
  g('windsurf', 'skills', '~/.codeium/windsurf/skills'),
  pr('windsurf', 'hooks', '.windsurf/hooks.json'),
];

/**
 * Claude Code's per-folder MCP entries, `projects[<folder>].mcpServers` in
 * `~/.claude.json`: not a manifest target, so not in the list above, but a
 * place a `myco` entry can sit for a connected folder.
 */
export const CLAUDE_PROJECT_MCP: LegacyLocation = g('claude-code', 'mcp', '~/.claude.json', { serversKey: 'projects/<folder>/mcpServers', format: 'json' });

/** Every servers key a JSON MCP file is read under: an agent's own, whatever the manifest named. */
const JSON_SERVERS_KEYS = ['mcpServers', 'servers', 'mcp'];

/** One concrete place to read: a location at a file, and for MCP the key path to the servers map. */
export interface LegacyTarget {
  location: LegacyLocation;
  file: string;
  serversPaths: string[][];
}

/** Every file and key path the locations name on this machine, for the connected `folders`. */
export function legacyTargets(homeDir: string, folders: readonly string[]): LegacyTarget[] {
  const home = (p: string) => path.join(homeDir, p.replace(/^~\/?/, ''));
  const serversPathsFor = (l: LegacyLocation): string[][] => (l.kind !== 'mcp' ? [] : l.format === 'toml' ? [[l.serversKey ?? 'mcp_servers']] : JSON_SERVERS_KEYS.map((k) => [k]));
  const out: LegacyTarget[] = [];
  for (const location of LEGACY_REGISTRATIONS) {
    if (location.scope === 'global') out.push({ location, file: home(location.path), serversPaths: serversPathsFor(location) });
    else for (const folder of folders) out.push({ location, file: path.join(folder, location.path), serversPaths: serversPathsFor(location) });
  }
  if (folders.length > 0) out.push({ location: CLAUDE_PROJECT_MCP, file: home(CLAUDE_PROJECT_MCP.path), serversPaths: folders.map((f) => ['projects', f, 'mcpServers']) });
  return out;
}

/** One Myco registration found at a 1.4 location. */
export interface LegacyFinding {
  location: LegacyLocation;
  file: string;
  /** For an MCP entry, the key path of the servers map holding it. */
  serversPath?: string[];
  verdict: Verdict;
  /** The hook command, MCP entry, file or skill link this is about, as a person reads it. */
  subject: string;
  /** For a skill link: where it points. */
  linkTarget?: string;
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

/** The verdict on a whole file a Myco install wrote as a plugin, or null when it is not Myco's. */
export function pluginVerdict(content: string, legacyHomes: readonly string[], ownHome?: string): Verdict | null {
  let commands: string[] = [];
  try { commands = collectCommands(JSON.parse(content)); } catch { /* a module, not JSON */ }
  if (commands.length > 0) {
    const verdicts = commands.map((c) => hookVerdict(c, legacyHomes)).filter((v): v is Verdict => v !== null);
    if (verdicts.includes('foreign')) return 'foreign';
    if (verdicts.includes('legacy')) return 'legacy';
    return verdicts.includes('member') ? 'member' : null;
  }
  return pluginFileVerdict(content, legacyHomes, ownHome) ?? (rawHasMycoOwnershipSignal(content) ? 'foreign' : null);
}

function collectCommands(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectCommands);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const own = typeof record.command === 'string' ? [record.command] : [];
  return [...own, ...Object.entries(record).filter(([key]) => key !== 'command').flatMap(([, value]) => collectCommands(value))];
}

const at = (node: unknown, keys: readonly string[]): unknown =>
  keys.reduce<unknown>((n, k) => (n && typeof n === 'object' && !Array.isArray(n) ? (n as Record<string, unknown>)[k] : undefined), node);

/** Whether a link points into a 1.4 home's `skills/` (and not `ownHome`'s). */
function skillLinkVerdict(link: string, legacyHomes: readonly string[], ownHome: string | undefined): { verdict: Verdict; target: string } | null {
  let target: string;
  try { target = path.resolve(path.dirname(link), fs.readlinkSync(link)); } catch { return null; }
  const into = (home: string) => target.startsWith(`${path.join(path.resolve(home), 'skills')}${path.sep}`);
  if (ownHome !== undefined && into(ownHome)) return { verdict: 'member', target };
  return legacyHomes.some(into) ? { verdict: 'legacy', target } : null;
}

export interface ScanOptions {
  homeDir: string;
  legacyHomes: readonly string[];
  /** The 2.0 home the run moves into: its own plugins, links and entries are the member's. */
  ownHome?: string;
  /** The folders connected to the Deployment, whose project-level locations are read too. */
  folders?: readonly string[];
}

/** What every 1.4 location on this machine holds, read-only. */
export function scanLegacyRegistrations(opts: ScanOptions): LegacyScan {
  const homes = opts.legacyHomes.map((home) => path.resolve(home));
  const scan: LegacyScan = { findings: [], unreadable: [] };
  const pluginVerdicts = new Map<string, Verdict>();
  const targets = legacyTargets(opts.homeDir, opts.folders ?? []);
  const seenSkillDirs = new Set<string>();
  for (const target of targets) {
    const { location, file } = target;
    if (location.kind === 'plugin-manifest') continue;
    if (location.kind === 'skills') {
      if (seenSkillDirs.has(file)) continue;
      seenSkillDirs.add(file);
      let names: string[];
      try { names = fs.readdirSync(file); } catch { continue; }
      for (const name of names.sort()) {
        const link = path.join(file, name);
        const found = skillLinkVerdict(link, homes, opts.ownHome);
        if (found !== null) scan.findings.push({ location, file: link, verdict: found.verdict, subject: link, linkTarget: found.target });
      }
      continue;
    }
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const add = (verdict: Verdict, subject: string, serversPath?: string[]) => scan.findings.push({ location, file, verdict, subject, ...(serversPath ? { serversPath } : {}) });
    try {
      if (location.kind === 'plugin-file') {
        const verdict = pluginVerdict(raw, homes, opts.ownHome);
        if (verdict === null) continue;
        pluginVerdicts.set(path.dirname(file), verdict);
        add(verdict, file);
      } else if (location.kind === 'hooks') {
        for (const command of collectCommands((JSON.parse(raw) as { hooks?: unknown }).hooks)) {
          const verdict = hookVerdict(command, homes);
          if (verdict !== null) add(verdict, command);
        }
      } else {
        const parsed = location.format === 'toml' ? parseToml(raw) : JSON.parse(raw);
        for (const serversPath of target.serversPaths) {
          const entry = at(parsed, [...serversPath, MYCO_MCP_SERVER_NAME]);
          if (entry !== undefined) add(mcpVerdict(entry, homes), JSON.stringify(entry), serversPath);
        }
      }
    } catch (error) {
      if (rawHasMycoOwnershipSignal(raw) || raw.includes(`"${MYCO_MCP_SERVER_NAME}"`) || raw.includes(`${MYCO_MCP_SERVER_NAME}]`)) {
        scan.unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  for (const { location, file } of targets) {
    if (location.kind !== 'plugin-manifest' || !fs.existsSync(file)) continue;
    if (pluginVerdicts.get(path.dirname(file)) === 'legacy') scan.findings.push({ location, file, verdict: 'legacy', subject: file });
  }
  // A file two locations name (a skills folder several agents share, a settings file holding hooks and MCP) is reported once per entry.
  const unique = new Map(scan.findings.map((f) => [`${f.file}\0${f.location.kind}\0${(f.serversPath ?? []).join('/')}\0${f.subject}`, f]));
  scan.findings = [...unique.values()];
  return scan;
}

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
