import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifests } from '../../src/symbionts/detect.js';

/**
 * Guard rail: every hook command in every JSON hooks template MUST
 * carry `--symbiont <name>` where name matches the manifest's own
 * `name` field.
 *
 * Agent detection at runtime uses this flag as the primary signal. If
 * a new hook event is added to a template and the author forgets to
 * include the flag, detection falls back to heuristics and sessions
 * get misattributed — which is exactly the bug this test is defending
 * against.
 *
 * The list of JSON-hook symbionts is discovered at test time by
 * loading every manifest and filtering to those with a declared
 * `hooksTarget` and `hooksFormat: json` (the default). This is
 * deliberately manifest-driven: adding a new symbiont to the project
 * automatically extends the guard, with no hardcoded list to forget
 * to update. A hardcoded list was the exact failure mode that caused
 * an earlier manual verification pass to silently skip vscode-copilot
 * and report everything clean when it wasn't.
 *
 * opencode is auto-skipped: its manifest has
 * `hooksFormat: plugin-file`, so the filter drops it. Opencode's
 * TypeScript plugin posts directly to the daemon with a hardcoded
 * `agent: "opencode"` field in every event body, so the argv flag
 * path doesn't apply.
 */

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/symbionts/templates',
);

/** Manifests that render a JSON hooks file the installer merges into the target. */
const JSON_HOOK_MANIFESTS = loadManifests().filter((m) => {
  const reg = m.registration;
  if (!reg?.hooksTarget) return false;
  const format = reg.hooksFormat ?? 'json';
  return format === 'json';
});

/** Walk a parsed hooks.json object and yield every `command` string field. */
function* walkCommands(node: unknown): Generator<string> {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walkCommands(child);
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'command' && typeof value === 'string') {
        yield value;
      } else {
        yield* walkCommands(value);
      }
    }
  }
}

describe('hook template --symbiont flag', () => {
  it('discovers at least one JSON-hook manifest (loadManifests smoke test)', () => {
    // If this fails, every other assertion below would silently pass
    // because the inner loop would have nothing to iterate — defense
    // against the same hardcoded-list bug, one level up.
    expect(JSON_HOOK_MANIFESTS.length).toBeGreaterThan(0);
  });

  for (const manifest of JSON_HOOK_MANIFESTS) {
    const name = manifest.name;
    describe(name, () => {
      const file = path.join(TEMPLATES_DIR, name, 'hooks.json');
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const commands = [...walkCommands(parsed)];

      // Only commands that invoke myco-run.cjs are subject to the flag
      // check — a template could legitimately host a non-Myco command.
      const mycoCommands = commands.filter((c) => c.includes('myco-run.cjs'));

      it('has at least one Myco hook command', () => {
        expect(mycoCommands.length).toBeGreaterThan(0);
      });

      it('every Myco command includes --symbiont <correct-name>', () => {
        const expected = `--symbiont ${name}`;
        const missing = mycoCommands.filter((c) => !c.includes(expected));
        expect(missing).toEqual([]);
      });

      it('no Myco command carries a different symbiont name', () => {
        // Defense against a copy/paste typo where someone clones a
        // template and forgets to update the flag value.
        const wrongAgent = mycoCommands.filter((c) => {
          const match = c.match(/--symbiont\s+([a-z][a-z-]*)/);
          return match !== null && match[1] !== name;
        });
        expect(wrongAgent).toEqual([]);
      });
    });
  }
});
