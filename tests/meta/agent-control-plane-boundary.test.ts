/**
 * Meta gate: the run control plane goes through the port.
 *
 * Once the executor talks to a `RunStore`, nothing stops a later edit from
 * importing `insertRun` again and quietly reintroducing the coupling — and
 * because the local adapter still writes the same rows, no behavioural test
 * would fail. This gate fails by name instead, listing the offending file and
 * the symbol it reached for.
 *
 * Scope is deliberately the CONTROL PLANE only. The data plane (the vault
 * tools) still reads `@myco/db` directly and legitimately so: it already has a
 * contract, and re-pointing it waits on #908 answering how the harness is
 * hosted. Widening this gate to the data plane is that issue's job, not a
 * TODO — the allowlist below is the record of what is not yet converted.
 *
 * Direct imports only, not the transitive closure, for the same reason: today
 * `agent/` legitimately reaches these modules through the data plane, so a
 * transitive walk would report the unconverted half as violations and the gate
 * would have to be disabled to stay green. It becomes transitive — matching
 * `tests/meta/member-seam-boundary.test.ts` — when the data plane converts.
 *
 * Static source scan (node:fs), no daemon boot.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'agent');

/** Query modules that ARE the run control plane. */
const CONTROL_PLANE_MODULES = [
  '@myco/db/queries/runs.js',
  '@myco/db/queries/agent-run-events.js',
  '@myco/db/queries/cortex-instructions.js',
] as const;

/** Symbols that must come from the port even where the module is otherwise allowed. */
const CONTROL_PLANE_SYMBOLS = [
  'insertRun',
  'updateRunStatus',
  'applyRunUpdate',
  'getRunningRunForTask',
  'supersedeEquivalentResumableRuns',
  'insertRunEvent',
  'upsertCortexInstructions',
] as const;

/**
 * The one file allowed to reach the control plane directly — it IS the local
 * implementation of the port.
 */
const ADAPTER = path.join('runtime', 'run-store-local.ts');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

describe('agent control-plane boundary', () => {
  const files = sourceFiles(AGENT_ROOT);

  it('finds the agent sources it is meant to police', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(ADAPTER))).toBe(true);
  });

  it('only the local adapter imports the control-plane query modules', () => {
    const violations: string[] = [];

    for (const file of files) {
      if (file.endsWith(ADAPTER)) continue;
      const source = fs.readFileSync(file, 'utf-8');
      const relative = path.relative(REPO_ROOT, file);

      for (const moduleId of CONTROL_PLANE_MODULES) {
        // A type-only import is not a runtime edge and does not couple.
        const pattern = new RegExp(`import\\s+(?!type\\b)[^;]*?from\\s+'${moduleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 's');
        const match = source.match(pattern);
        if (!match) continue;
        const reached = CONTROL_PLANE_SYMBOLS.filter((symbol) =>
          new RegExp(`\\b${symbol}\\b`).test(match[0]),
        );
        if (reached.length > 0) {
          violations.push(`${relative} imports ${reached.join(', ')} from ${moduleId}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('CONTROL: the gate fails when a control-plane symbol is imported', () => {
    // Proves the matcher actually fires — a gate that cannot fail is not a gate.
    const offending = `import { insertRun, getRun } from '@myco/db/queries/runs.js';`;
    const pattern = new RegExp(`import\\s+(?!type\\b)[^;]*?from\\s+'@myco/db/queries/runs\\.js'`, 's');
    const match = offending.match(pattern);

    expect(match).not.toBeNull();
    expect(CONTROL_PLANE_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(match![0])))
      .toContain('insertRun');
  });
});
