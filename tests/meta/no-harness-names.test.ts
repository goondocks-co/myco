/**
 * Gate G7 (#1561): one code path for every harness. Where harnesses differ, the difference is data in a manifest
 * (`symbionts/manifests/*.yaml`), read by shared code; no code outside the registries that exist to be per-harness
 * names a harness.
 *
 * Read from the code that runs (comments and types stripped by the runtime's own transpiler), a harness is named when its manifest
 * name is compared against (`===`, `!==`, `==`, `!=`), is a `switch` case, or keys a per-harness map (an object keyed by
 * two harness names or more); or when a string
 * names its environment variables (a prefix its `pluginRootEnvVar` declares, such as `CLAUDE_`) or its configuration
 * directory (its `configDir`, such as `.claude`). A bare string that happens to equal a name, such as a `cursor` paging
 * parameter, is none of these and is not flagged.
 *
 * In scope: the 2.0 member closure (what the hooks, the member seam, the worker and the member verbs reach), and the
 * shared and Deployment packages whole. Allowed to name harnesses: the registries that exist to be per-harness.
 *
 * KNOWN is a ratchet: today's offenders, by file and count. It may only shrink, and #1561 PR 7 empties it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { closureOf, codeOf, entryFiles, filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const MEMBER_ENTRIES = ['hooks/**', 'member/**', 'runner/**', 'cli/member-dispatch.ts', 'cli/member-verbs.ts'];
const WHOLE_PACKAGES = [path.join(REPO_ROOT, 'packages', 'myco-shared', 'src'), path.join(REPO_ROOT, 'packages', 'myco-server', 'src')];

/** The registries that exist to be per-harness: transcript adapters and parsers, plugin host templates, worker drivers, and the manifest data and its loader. */
const REGISTRIES: readonly RegExp[] = [
  /^packages\/myco\/src\/symbionts\/(claude-code|codex|cursor|copilot|windsurf|antigravity)\.ts$/,
  /^packages\/myco\/src\/symbionts\/parsers\//,
  /^packages\/myco\/src\/symbionts\/templates\//,
  /^packages\/myco\/src\/symbionts\/(registry|detect|manifest-schema)\.ts$/,
  /^packages\/myco\/src\/runner\/drivers\//,
  /^packages\/myco\/src\/runner\/harnesses\.ts$/,
  /^packages\/myco-server\/src\/ingest\/parsers\//,
  /\.generated\.ts$/,
];

/** Today's offenders: file → how many places name a harness. Only shrinks; #1561 PR 7 folds each into manifest data. */
const KNOWN: Readonly<Record<string, number>> = {
  // The worker's provider credential for a harness run: the manifest's `runner:` block.
  'packages/myco-server/src/core/harness.ts': 1,
  'packages/myco-shared/src/harness-providers.ts': 6,
  // Cursor's session id read from its transcript path: `hookFields.sessionIdFromTranscriptPath`.
  'packages/myco/src/hooks/normalize.ts': 1,
  // Copilot's subagent answer shape: `registration.hookResponse.shapes`.
  'packages/myco/src/hooks/response.ts': 1,
  // Antigravity's prompts read from its transcript at start: `capture.promptsFromTranscript`, run in the helper.
  'packages/myco/src/hooks/session-start.ts': 1,
  // Claude Code's post-compaction start: `hookEvents.SessionStart.compactionWhen`.
  'packages/myco/src/member/compaction.ts': 1,
};

const NAMES = new Set(BUNDLED_MANIFESTS.map((m) => m.name));
const ENV_PREFIXES = Object.values(HOOK_CONFIG).map((c) => (c as { pluginRootEnvVar?: string }).pluginRootEnvVar)
  .filter((v): v is string => typeof v === 'string' && v.endsWith('_PLUGIN_ROOT'))
  .map((v) => v.slice(0, -'PLUGIN_ROOT'.length));
const CONFIG_DIRS = Object.values(HOOK_CONFIG).map((c) => (c as { configDir?: string }).configDir)
  .filter((v): v is string => typeof v === 'string' && v.startsWith('.'));

function inScope(): string[] {
  const closure = closureOf(entryFiles(SRC, MEMBER_ENTRIES));
  const files = new Set([...closure.modules.values()].filter((f) => /\.tsx?$/.test(f)));
  for (const dir of WHOLE_PACKAGES) for (const f of filesUnder(dir)) files.add(f);
  return [...files].filter((f) => !REGISTRIES.some((r) => r.test(moduleKey(f)))).sort();
}

/** A regular-expression source matching any of these strings exactly. */
const anyOf = (values: Iterable<string>): string => [...values].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** Every place a file names a harness, as `kind text`, read from its transpiled code: strings there are double-quoted. */
function namings(file: string): string[] {
  const code = codeOf(fs.readFileSync(file, 'utf-8'), file);
  const names = anyOf(NAMES);
  const found: string[] = [];
  for (const m of code.matchAll(new RegExp(`(?:===|!==|==|!=)\\s*"(${names})"|"(${names})"\\s*(?:===|!==|==|!=)`, 'g'))) found.push(`compares "${m[1] ?? m[2]}"`);
  for (const m of code.matchAll(new RegExp(`\\bcase\\s+"(${names})"\\s*:`, 'g'))) found.push(`case "${m[1]}"`);
  // A key is a harness only in a per-harness map, one keyed by two harnesses or more: a lone `cursor` key is a page cursor.
  const keys = [...code.matchAll(new RegExp(`[{,]\\s*(?:"(${names})"|(${names}))\\s*:`, 'g'))].map((m) => m[1] ?? m[2]);
  if (new Set(keys).size >= 2) for (const key of keys) found.push(`key "${key}"`);
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const text = m[1];
    if (/^[A-Z0-9_]+$/.test(text) && ENV_PREFIXES.some((prefix) => text.startsWith(prefix))) found.push(`environment "${text}"`);
    if (CONFIG_DIRS.some((d) => new RegExp(`(^|[/~])${anyOf([d])}(/|$)`).test(text))) found.push(`directory "${text}"`);
  }
  return found;
}

describe('no code names a harness outside the registries (G7)', () => {
  const files = inScope();
  const offenders: Record<string, string[]> = {};
  for (const file of files) {
    const hits = namings(file);
    if (hits.length > 0) offenders[moduleKey(file)] = hits;
  }

  it('reads the harnesses, their environment prefixes and their configuration directories from manifest data', () => {
    expect(NAMES.size).toBeGreaterThanOrEqual(9);
    expect(ENV_PREFIXES).toContain('CLAUDE_');
    expect(CONFIG_DIRS).toContain('.claude');
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds no file naming a harness beyond the known ones, and no known file naming more than it did', () => {
    const grown = Object.entries(offenders)
      .filter(([file, hits]) => hits.length > (KNOWN[file] ?? 0))
      .map(([file, hits]) => `${file} (${hits.length}, known ${KNOWN[file] ?? 0}):\n  ${hits.join('\n  ')}`);
    expect(grown).toEqual([]);
  });

  it('shrinks: a known file that names fewer harnesses now is lowered, and one that names none is removed', () => {
    const stale = Object.entries(KNOWN).filter(([file, count]) => (offenders[file]?.length ?? 0) < count).map(([file]) => file);
    expect(stale).toEqual([]);
  });
});
