import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadManifests } from '@myco/symbionts/detect.js';
import { evaluateSessionStartRules, evaluateUserPromptRules } from '@myco/hooks/capture-rules.js';
import { readTranscriptMeta } from '@myco/hooks/transcript-meta.js';

/**
 * Integration test exercising the REAL claude-code.yaml manifest through
 * the Zod schema and both rule evaluators — Codex `source: exec` parity
 * (codex.yaml Layer 5/6) for Claude Code's Agent-SDK-launched transcripts.
 *
 * Claude Code >=2.1.x writes Agent-SDK-launched sessions (e.g. the
 * security-review plugin's Python-SDK review agents) into the user's
 * transcript tree as top-level files. They never fire hooks, so only the
 * reverse (disk-enumeration) sweep in checkReconcile sees them, via
 * intentionallyDropped() -> evaluateSessionCaptureRules(). Their structural
 * marker is `entrypoint: "sdk-py"` / `"sdk-ts"` — interactive sessions
 * carry `entrypoint: "cli"`.
 */
describe('claude-code.yaml SDK-entrypoint capture rules', () => {
  it('parses cleanly and declares both session_start and user_prompt drops for each entrypoint value', () => {
    const manifests = loadManifests();
    const claudeCode = manifests.find((m) => m.name === 'claude-code')!;
    const rules = (claudeCode.capture?.rules ?? []).filter((r) => r.reason === 'noninteractive-sdk');
    expect(rules).toHaveLength(4);
    expect(rules.filter((r) => r.event === 'session_start')).toHaveLength(2);
    expect(rules.filter((r) => r.event === 'user_prompt')).toHaveLength(2);
    const values = rules.map((r) => r.when.transcript_meta_field_equals?.value).sort();
    expect(values).toEqual(['sdk-py', 'sdk-py', 'sdk-ts', 'sdk-ts']);
  });

  describe('session_start', () => {
    it('drops when entrypoint is sdk-py', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { entrypoint: 'sdk-py' },
      });
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-sdk' });
    });

    it('drops when entrypoint is sdk-ts', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { entrypoint: 'sdk-ts' },
      });
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-sdk' });
    });

    it('passes through when entrypoint is cli', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { entrypoint: 'cli' },
      });
      expect(result).toEqual({ action: 'pass' });
    });

    it('passes through (fail-open) when entrypoint is absent — data preservation', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { cwd: '/repo' },
      });
      expect(result).toEqual({ action: 'pass' });
    });

    it('passes through when there is no transcriptMeta at all', () => {
      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
      });
      expect(result).toEqual({ action: 'pass' });
    });
  });

  describe('user_prompt safety net', () => {
    it('drops when entrypoint is sdk-py', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'claude-code', {
        prompt: 'anything',
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { entrypoint: 'sdk-py' },
      });
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-sdk' });
    });

    it('drops when entrypoint is sdk-ts', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'claude-code', {
        prompt: 'anything',
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { entrypoint: 'sdk-ts' },
      });
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-sdk' });
    });

    it('passes a real Claude Code prompt through unchanged when entrypoint is cli', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'claude-code', {
        prompt: 'real user question',
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
        transcriptMeta: { entrypoint: 'cli' },
      });
      expect(result).toEqual({ action: 'pass', prompt: 'real user question' });
    });

    it('passes through (fail-open) when entrypoint is absent — data preservation', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'claude-code', {
        prompt: 'real user question',
        transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
      });
      expect(result).toEqual({ action: 'pass', prompt: 'real user question' });
    });

    it('does not fire for other agents (this_agent scope)', () => {
      const result = evaluateUserPromptRules(loadManifests(), 'codex', {
        prompt: 'anything',
        transcriptPath: '/Users/x/.codex/sessions/2026/04/11/rollout-abc.jsonl',
        transcriptMeta: { entrypoint: 'sdk-py' },
      });
      expect(result).toEqual({ action: 'pass', prompt: 'anything' });
    });
  });

  describe('end-to-end with a real oversized-line-1 transcript', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-sdk-oversized-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('drops via the rules even when entrypoint sits past an oversized (>128KB) line 1', () => {
      // Real sdk-py transcripts embed the full review prompt on line 1
      // (87KB+ observed), pushing `entrypoint` past a single fixed 128KB
      // read — transcript-meta.ts's chunked header scan must still surface
      // it, and the manifest rule must still drop on it.
      const file = path.join(dir, 'session.jsonl');
      const lines = [
        { type: 'queue-operation', id: 'op1', prompt: 'x'.repeat(150_000) },
        { type: 'last-prompt', value: null },
        { type: 'attachment', cwd: '/repo/proj', entrypoint: 'sdk-py' },
      ];
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

      const transcriptMeta = readTranscriptMeta(file) ?? undefined;
      expect(transcriptMeta?.entrypoint).toBe('sdk-py');

      const result = evaluateSessionStartRules(loadManifests(), 'claude-code', {
        transcriptPath: file,
        transcriptMeta,
      });
      expect(result).toEqual({ action: 'drop', reason: 'noninteractive-sdk' });
    });
  });
});
