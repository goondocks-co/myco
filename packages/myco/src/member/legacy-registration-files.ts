/** Read-only discovery of retained Myco registrations. */
import fs from 'node:fs';
import path from 'node:path';
import { MYCO_MCP_SERVER_NAME, rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
import { commandVerdict, mcpVerdict, pluginFileVerdict, staleCommandBinary, staleMcpBinary, stalePluginBinary, type Verdict } from '@myco/member/legacy-verdict.js';

export { mcpVerdict, type Verdict };

import { LEGACY_REGISTRATIONS, CLAUDE_PROJECT_MCP, type LegacyLocation } from '@myco/member/legacy-registration-data.js';
export { LEGACY_REGISTRATIONS, CLAUDE_PROJECT_MCP, type LegacyLocation, type LegacyLocationKind } from '@myco/member/legacy-registration-data.js';

const JSON_SERVERS_KEYS = ['mcpServers', 'servers', 'mcp'];

export interface LegacyTarget {
  location: LegacyLocation;
  file: string;
  serversPaths: string[][];
}

export function legacyTargets(homeDir: string, folders: readonly string[]): LegacyTarget[] {
  const home = (p: string) => path.join(homeDir, p.replace(/^~\/?/, ''));
  const serversPathsFor = (l: LegacyLocation): string[][] => (l.kind !== 'mcp' ? [] : l.format === 'toml' ? [[l.serversKey ?? 'mcp_servers']] : JSON_SERVERS_KEYS.map((k) => [k]));
  const out: LegacyTarget[] = [];
  for (const location of LEGACY_REGISTRATIONS) {
    if (location.scope === 'global') out.push({ location, file: home(location.path), serversPaths: serversPathsFor(location) });
    else for (const folder of folders) out.push({ location, file: path.join(folder, location.path), serversPaths: serversPathsFor(location) });
  }
  out.push({ location: CLAUDE_PROJECT_MCP, file: home(CLAUDE_PROJECT_MCP.path), serversPaths: [...JSON_SERVERS_KEYS.map((key) => [key]), ...folders.map((f) => ['projects', f, 'mcpServers'])] });
  return out;
}

export interface LegacyFinding {
  location: LegacyLocation;
  file: string;
  serversPath?: string[];
  verdict: Verdict;
  subject: string;
  linkTarget?: string;
  keyPath?: string;
  missingBinary?: string;
}

export interface LegacyScan {
  findings: LegacyFinding[];
  unreadable: Array<{ file: string; reason: string }>;
}

export function staleRegistrationWords(finding: LegacyFinding, agent = finding.location.agent): string {
  return `${agent}: stale Myco entry in ${finding.file} at ${finding.keyPath}; binary ${finding.missingBinary} is missing. Myco leaves it alone; you may delete that entry.`;
}

export function hookVerdict(command: string, legacyHomes: readonly string[]): Verdict | null {
  return rawHasMycoOwnershipSignal(command) ? commandVerdict(command, legacyHomes) : null;
}

export function pluginVerdict(content: string, legacyHomes: readonly string[], ownHome?: string): Verdict | null {
  let commands: string[] = [];
  try { commands = collectCommands(JSON.parse(content)); } catch { /* a module, not JSON */ }
  if (commands.length > 0) {
    const verdicts = commands.map((c) => hookVerdict(c, legacyHomes)).filter((v): v is Verdict => v !== null);
    if (verdicts.includes('foreign')) return 'foreign';
    if (verdicts.includes('legacy')) return 'legacy';
    if (verdicts.includes('member')) return 'member';
    return verdicts.includes('stale') ? 'stale' : null;
  }
  return pluginFileVerdict(content, legacyHomes, ownHome) ?? (rawHasMycoOwnershipSignal(content) ? 'foreign' : null);
}

function collectCommandEntries(node: unknown, keys: string[] = []): Array<{ command: string; keyPath: string }> {
  if (Array.isArray(node)) return node.flatMap((value, index) => collectCommandEntries(value, [...keys, String(index)]));
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const own = typeof record.command === 'string' ? [{ command: record.command, keyPath: [...keys, 'command'].join('.') }] : [];
  return [...own, ...Object.entries(record).filter(([key]) => key !== 'command').flatMap(([key, value]) => collectCommandEntries(value, [...keys, key]))];
}

const collectCommands = (node: unknown): string[] => collectCommandEntries(node).map(({ command }) => command);

export const legacyRegistrationAt = (node: unknown, keys: readonly string[]): unknown =>
  keys.reduce<unknown>((n, k) => (n && typeof n === 'object' && !Array.isArray(n) ? (n as Record<string, unknown>)[k] : undefined), node);

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
  ownHome?: string;
  folders?: readonly string[];
  allClaudeProjects?: boolean;
}

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
    const add = (verdict: Verdict, subject: string, serversPath?: string[], keyPath?: string, missingBinary?: string) => scan.findings.push({ location, file, verdict, subject, ...(serversPath ? { serversPath } : {}), ...(keyPath ? { keyPath } : {}), ...(missingBinary ? { missingBinary } : {}) });
    try {
      if (location.kind === 'plugin-file') {
        const verdict = pluginVerdict(raw, homes, opts.ownHome);
        if (verdict === null) continue;
        let entries: ReturnType<typeof collectCommandEntries> = [];
        try { entries = collectCommandEntries(JSON.parse(raw)); } catch { /* a module, not JSON */ }
        pluginVerdicts.set(path.dirname(file), entries.some(({ command }) => hookVerdict(command, homes) === 'stale') ? 'stale' : verdict);
        if (entries.length > 0) {
          for (const { command, keyPath } of entries) {
            const commandOwner = hookVerdict(command, homes);
            if (commandOwner !== null) add(commandOwner, command, undefined, keyPath, commandOwner === 'stale' ? staleCommandBinary(command) : undefined);
          }
        } else add(verdict, file, undefined, 'plugin', verdict === 'stale' ? stalePluginBinary(raw) : undefined);
      } else if (location.kind === 'hooks') {
        for (const { command, keyPath } of collectCommandEntries((JSON.parse(raw) as { hooks?: unknown }).hooks, ['hooks'])) {
          const verdict = hookVerdict(command, homes);
          if (verdict !== null) add(verdict, command, undefined, keyPath, verdict === 'stale' ? staleCommandBinary(command) : undefined);
        }
      } else {
        const parsed = location.format === 'toml' ? Bun.TOML.parse(raw) : JSON.parse(raw);
        const projects = location === CLAUDE_PROJECT_MCP && opts.allClaudeProjects && parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)
          ? Object.keys(parsed.projects).map((folder) => ['projects', folder, 'mcpServers']) : [];
        for (const serversPath of [...target.serversPaths, ...projects]) {
          const entry = legacyRegistrationAt(parsed, [...serversPath, MYCO_MCP_SERVER_NAME]);
          if (entry !== undefined) add(mcpVerdict(entry, homes), JSON.stringify(entry), serversPath, [...serversPath, MYCO_MCP_SERVER_NAME].join('.'), staleMcpBinary(entry));
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
  const unique = new Map(scan.findings.map((f) => [`${f.file}\0${f.location.kind}\0${(f.serversPath ?? []).join('/')}\0${f.subject}`, f]));
  scan.findings = [...unique.values()];
  return scan;
}
