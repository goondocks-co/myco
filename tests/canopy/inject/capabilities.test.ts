import { describe, it, expect } from 'bun:test';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema';
import {
  manifestHasCapability,
  symbiontHasCapability,
} from '@myco/symbionts/capabilities';

const baseManifest = {
  name: 'fixture',
  displayName: 'Fixture',
  binary: 'fixture',
  configDir: '.fixture',
  pluginRootEnvVar: 'FIXTURE_ROOT',
  hookFields: {
    sessionId: 'session_id',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
  },
};

describe('manifestHasCapability', () => {
  it('returns false when manifest is undefined', () => {
    expect(manifestHasCapability(undefined, 'preToolUseInjection')).toBe(false);
  });

  it('returns false when capabilities field is absent', () => {
    const parsed = SymbiontManifestSchema.parse(baseManifest);
    expect(manifestHasCapability(parsed, 'preToolUseInjection')).toBe(false);
  });

  it('returns false when explicitly false', () => {
    const parsed = SymbiontManifestSchema.parse({
      ...baseManifest,
      capabilities: { preToolUseInjection: false },
    });
    expect(manifestHasCapability(parsed, 'preToolUseInjection')).toBe(false);
  });

  it('returns true when explicitly true', () => {
    const parsed = SymbiontManifestSchema.parse({
      ...baseManifest,
      capabilities: { preToolUseInjection: true },
    });
    expect(manifestHasCapability(parsed, 'preToolUseInjection')).toBe(true);
  });
});

describe('symbiontHasCapability', () => {
  it('symbionts with a documented PreToolUse injection surface have it enabled', () => {
    // Each of these manifests declares `preToolUseInjection: true` AND
    // `canopyReadTools` — the daemon needs both to activate Canopy
    // injection per-tool. The list grows as new symbionts gain
    // PreToolUse contracts (Copilot joined when its 13-event hook
    // surface was wired; see copilot.yaml capabilities block).
    for (const name of ['claude-code', 'codex', 'copilot']) {
      expect(symbiontHasCapability(name, 'preToolUseInjection')).toBe(true);
    }
  });

  it('symbionts without a PreToolUse hook surface default to false', () => {
    // Copilot moved into the preToolUseInjection cohort once we wired
    // its full hook surface and declared its path-bearing tools — see
    // copilot.yaml `capabilities`. The agents below remain false until
    // their own hook contracts gain an equivalent pre-call injection.
    for (const name of ['cursor', 'antigravity', 'windsurf']) {
      expect(symbiontHasCapability(name, 'preToolUseInjection')).toBe(false);
    }
  });

  it('returns false for unknown symbiont names', () => {
    expect(symbiontHasCapability('not-a-real-symbiont', 'preToolUseInjection')).toBe(false);
  });

  it('returns false when name is undefined', () => {
    expect(symbiontHasCapability(undefined, 'preToolUseInjection')).toBe(false);
  });
});
