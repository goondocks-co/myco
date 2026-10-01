/**
 * Every hook a harness is wired to run has a module to run (#1561 PR 1).
 *
 * A hook command names its hook (`myco hook <name>`), and a plugin template names it in the call that runs the binary.
 * A name missing from `HOOK_DISPATCH` exits 1 with "Unknown hook" on every event of that kind, silently to the person
 * using the harness. The names come from the templates the installer writes and from the generated hook config, and
 * every one must be in the table, with the module it loads on disk.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_DISPATCH } from '@myco/hooks/entry.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { filesUnder, REPO_ROOT } from '../helpers/import-closure.ts';

const TEMPLATES = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'symbionts', 'templates');
const HOOKS_DIR = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'hooks');

/** Every hook name a template wires: `myco hook <name>` in a hooks file, or the name a plugin passes to the binary. */
function templateHookNames(): Map<string, string> {
  const names = new Map<string, string>();
  const files = fs.readdirSync(TEMPLATES, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    // A hook command: `{{mycoLauncher}} hook <name> …`, as a hooks file writes it.
    for (const m of text.matchAll(/\}\}\s+hook\s+([a-z][a-z-]*)/g)) names.set(m[1], path.relative(REPO_ROOT, file));
    for (const m of text.matchAll(/runMycoHook\([^)]*?"([a-z][a-z-]*)"/g)) names.set(m[1], path.relative(REPO_ROOT, file));
  }
  return names;
}

describe('the hook dispatch table', () => {
  const table = new Set(Object.keys(HOOK_DISPATCH));

  it('has a module for every hook the generated hook config wires', () => {
    const wired = Object.entries(HOOK_CONFIG).flatMap(([symbiont, config]) =>
      Object.values(config.hookEvents).map((event) => `${symbiont}: ${event.hook}`));
    expect(wired.length).toBeGreaterThan(20);
    expect(wired.filter((entry) => !table.has(entry.split(': ')[1]))).toEqual([]);
  });

  it('has a module for every hook a template runs, hooks files and plugins alike', () => {
    const named = templateHookNames();
    // Every plugin template and the hooks files are read: the scan is not empty.
    expect(named.size).toBeGreaterThanOrEqual(10);
    expect([...named].filter(([name]) => !table.has(name)).map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });

  it('loads a module that is there for every name it holds', () => {
    expect([...table].filter((name) => !fs.existsSync(path.join(HOOKS_DIR, `${name}.ts`)))).toEqual([]);
    expect(filesUnder(HOOKS_DIR).length).toBeGreaterThan(table.size);
  });
});
