/**
 * Meta gate: the generated hook config is fresh.
 *
 * `packages/myco/src/hooks/hook-config.generated.ts` is what every hook reads
 * instead of the YAML manifests, and it also carries the per-event hook
 * timeouts copied from `symbionts/templates/<sym>/hooks.json` — the one
 * source the member's hook budget and the installer's emitted timeouts share.
 * Nothing else gates that file: CI runs no codegen, and a manifest or template
 * edit without `npm run codegen` ships a hook that reads yesterday's config.
 *
 * Regenerates both generator outputs in memory through the generator's own
 * exported function and compares byte-for-byte with the committed files.
 * No subprocess, no writes — same static-scan shape as the other meta gates.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHookConfigSources } from '../../packages/myco/scripts/gen-hook-config';
import { HOOK_CONFIG } from '../../packages/myco/src/hooks/hook-config.generated';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_CONFIG_PATH = path.join(REPO_ROOT, 'packages/myco/src/hooks/hook-config.generated.ts');
const BUNDLED_MANIFESTS_PATH = path.join(REPO_ROOT, 'packages/myco/src/symbionts/manifests.generated.ts');

/** 1-based line of the first difference, for a failure message that names the drift. */
function firstDifferingLine(a: string, b: string): number {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const n = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < n; i++) {
    if (aLines[i] !== bLines[i]) return i + 1;
  }
  return 0;
}

describe('generated hook config freshness', () => {
  const fresh = renderHookConfigSources();

  it('hooks/hook-config.generated.ts is byte-identical to a fresh generation (run `npm run codegen`)', () => {
    const committed = fs.readFileSync(HOOK_CONFIG_PATH, 'utf-8');
    const line = firstDifferingLine(committed, fresh.hookConfig);
    if (line !== 0) {
      throw new Error(
        `hook-config.generated.ts is stale: first difference at line ${line}. `
        + 'A manifest or symbionts/templates/*/hooks.json changed without `npm run codegen`.',
      );
    }
    expect(committed).toBe(fresh.hookConfig);
  });

  it('symbionts/manifests.generated.ts is byte-identical to a fresh generation (run `npm run codegen`)', () => {
    const committed = fs.readFileSync(BUNDLED_MANIFESTS_PATH, 'utf-8');
    const line = firstDifferingLine(committed, fresh.bundledManifests);
    if (line !== 0) {
      throw new Error(
        `manifests.generated.ts is stale: first difference at line ${line}. `
        + 'A manifest changed without `npm run codegen`.',
      );
    }
    expect(committed).toBe(fresh.bundledManifests);
  });

  it('carries the per-event timeouts the harness templates declare, keyed by harness event name', () => {
    // Spot-pin the Claude Code budget the member derives from (spec §2):
    // PreToolUse 3 s, UserPromptSubmit 5 s, SessionStart 10 s, Stop 30 s.
    expect(HOOK_CONFIG['claude-code'].hookEvents.PreToolUse).toEqual({ hook: 'pre-tool-use', timeout: 3 });
    expect(HOOK_CONFIG['claude-code'].hookEvents.UserPromptSubmit).toEqual({ hook: 'user-prompt-submit', timeout: 5 });
    expect(HOOK_CONFIG['claude-code'].hookEvents.SessionStart).toEqual({ hook: 'session-start', timeout: 10 });
    expect(HOOK_CONFIG['claude-code'].hookEvents.Stop).toEqual({ hook: 'stop', timeout: 30 });
    // Antigravity nests its events under a `myco` key; the harness event name is still the key.
    expect(HOOK_CONFIG.antigravity.hookEvents.PreInvocation).toEqual({ hook: 'session-start', timeout: 10 });
    // Windsurf declares no timeouts; the events are still present so a budget reader sees "undeclared".
    expect(HOOK_CONFIG.windsurf.hookEvents.post_cascade_response).toEqual({ hook: 'stop' });
    // Plugin-file symbionts have no hooks.json template.
    expect(HOOK_CONFIG.opencode.hookEvents).toEqual({});
  });
});
