import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadManifests } from '@myco/symbionts/detect.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
import { MEMBER_PLUGIN_MARKER, MYCO_PLUGIN_FILE_MARKER } from '@myco/symbionts/legacy-verdict.js';
import { expandHome, resolveHomeDir } from '@myco/paths/home.js';
import { canonicalPath, resolveRepositoryRoot } from '@myco/utils/git-files.js';
import { runGitAnswer } from '@myco/utils/git.js';

export type RepositoryEntry = { root: string; file: string } & (
  | { kind: 'found'; entry: string }
  | { kind: 'unreadable' }
);

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const MCP_KEYS = ['mcpServers', 'servers', 'mcp', 'mcp_servers'] as const;

/** Parse JSON with comments and trailing commas, preserving quoted content. */
function parseJsonc(raw: string): unknown {
  const uncommented = raw.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, quoted: string | undefined) => quoted ?? ' ');
  return JSON.parse(uncommented.replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (match, quoted: string | undefined) => quoted ?? ''));
}

/** Git confirms unusual layouts without keeping a member verdict. */
function repositoryAt(root: string): string | null {
  return resolveRepositoryRoot(root, [], process.env, { unusual: at => {
    try { return runGitAnswer(['rev-parse', '--show-toplevel'], at); }
    catch { return null; }
  } });
}

/** Read repository harness entries by name, without returning credentials or changing their files. */
export function repositoryMycoEntries(roots: Iterable<string>): RepositoryEntry[] {
  const manifests = loadManifests();
  const targets = new Set(manifests.flatMap(({ registration: reg }) => reg
    ? [reg.hooksTarget, reg.memberHooksTarget, reg.mcpTarget].filter((target): target is string => Boolean(target)) : []));
  const globalTargets = new Set(manifests.flatMap(({ registration: reg }) => reg
    ? [reg.globalHooksTarget, ...(reg.globalMcpTarget ?? []).map(target => target.path), reg.globalSkillsTarget]
      .filter((target): target is string => Boolean(target)).map(target => canonicalPath(expandHome(target))) : []));
  const home = canonicalPath(resolveHomeDir());
  const found: RepositoryEntry[] = [];
  for (const root of new Set([...roots].map(root => path.resolve(root)))) {
    const homeRelative = path.relative(canonicalPath(root), home);
    if (homeRelative === '' || (homeRelative !== '..' && !homeRelative.startsWith('..' + path.sep) && !path.isAbsolute(homeRelative))) continue;
    if (repositoryAt(root) === null) continue;
    for (const target of targets) {
      const file = path.join(root, target);
      if (globalTargets.has(canonicalPath(file))) continue;
      const unreadable = (): void => { found.push({ root, file, kind: 'unreadable' }); };
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable();
        continue;
      }
      if (/\.[cm]?[jt]s$/.test(target)) {
        if (raw.includes(MEMBER_PLUGIN_MARKER) || raw.includes(MYCO_PLUGIN_FILE_MARKER)) found.push({ root, file, kind: 'found', entry: 'Myco plugin' });
        continue;
      }
      let data: unknown;
      try { data = target.endsWith('.toml') ? parseToml(raw) : parseJsonc(raw); }
      catch { unreadable(); continue; }
      if (!object(data)) { unreadable(); continue; }
      const entries: string[] = [];
      for (const key of MCP_KEYS) {
        const servers = data[key];
        if (object(servers) && Object.hasOwn(servers, 'myco')) entries.push(key + '.myco');
      }
      if (object(data.hooks)) {
        const events = Object.entries(data.hooks).filter(([event, groups]) => hookCommands({ [event]: groups }).some(rawHasMycoOwnershipSignal)).map(([event]) => event);
        if (events.length > 0) entries.push('hooks: ' + events.join(', ') + ' (Myco commands)');
      }
      if (entries.length > 0) found.push({ root, file, kind: 'found', entry: entries.join('; ') });
    }
  }
  return found;
}
