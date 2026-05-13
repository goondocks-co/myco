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
  it('claude-code and codex have preToolUseInjection enabled', () => {
    expect(symbiontHasCapability('claude-code', 'preToolUseInjection')).toBe(true);
    expect(symbiontHasCapability('codex', 'preToolUseInjection')).toBe(true);
  });

  it('symbionts without a PreToolUse hook surface default to false', () => {
    for (const name of ['cursor', 'gemini', 'windsurf', 'vscode-copilot']) {
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
