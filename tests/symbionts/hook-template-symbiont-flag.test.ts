import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard rail: every hook command in every JSON hooks template MUST carry
 * `--symbiont <name>` where name matches the template's parent directory.
 *
 * Agent detection at runtime uses this flag as the primary signal. If a
 * new hook event is added to a template and the author forgets to
 * include the flag, detection falls back to heuristics and sessions get
 * misattributed — which is exactly the bug this PR fixes. Fail loud in
 * tests instead of shipping a silent regression.
 *
 * opencode is explicitly skipped: it's a plugin-file (TypeScript) that
 * posts directly to the daemon with a hardcoded `agent: "opencode"`
 * field in every event body, so it doesn't go through the argv path.
 */

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/symbionts/templates',
);

const JSON_HOOK_SYMBIONTS = [
  'claude-code',
  'cursor',
  'codex',
  'gemini',
  'vscode-copilot',
  'windsurf',
] as const;

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
  for (const name of JSON_HOOK_SYMBIONTS) {
    describe(name, () => {
      const file = path.join(TEMPLATES_DIR, name, 'hooks.json');
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const commands = [...walkCommands(parsed)];

      // Only commands that invoke myco-hook.cjs are subject to the flag
      // check — a template could legitimately host a non-Myco command.
      const mycoCommands = commands.filter((c) => c.includes('myco-hook.cjs'));

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
