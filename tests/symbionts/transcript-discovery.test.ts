import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  enumerateTranscripts,
  resolveTranscriptPath,
  expandRoot,
} from '@myco/symbionts/transcript-discovery.js';

/**
 * Covers the generic resolver that replaced the per-adapter `findCodexTranscript`
 * and `findAntigravityTranscript` finders. The scenarios are carried over from
 * those tests so the layouts they protected stay protected.
 */
describe('transcript discovery — lookup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-discovery-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Codex layout: sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl */
  function codexDiscovery() {
    return {
      roots: [path.join(tmpDir, 'sessions')],
      patterns: ['*/*/*/rollout-*-{sessionId}.jsonl'],
      sessionIdPattern: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    };
  }

  function plantCodex(sessionId: string, y = '2026', m = '04', d = '12'): string {
    const dir = path.join(tmpDir, 'sessions', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${y}-${m}-${d}T17-30-04-${sessionId}.jsonl`);
    fs.writeFileSync(file, '{}');
    return file;
  }

  it('finds a transcript in a nested YYYY/MM/DD directory behind a rollout prefix', () => {
    const sessionId = '019d839a-0c22-7072-97fa-3d1b16910b0d';
    const planted = plantCodex(sessionId);
    expect(resolveTranscriptPath(codexDiscovery(), sessionId)).toBe(planted);
  });

  it('finds a transcript in a different date shard', () => {
    const sessionId = '019d839a-0c22-7072-97fa-3d1b16910b0d';
    const planted = plantCodex(sessionId, '2026', '03', '28');
    expect(resolveTranscriptPath(codexDiscovery(), sessionId)).toBe(planted);
  });

  it('returns null when the session id is not present', () => {
    expect(resolveTranscriptPath(codexDiscovery(), 'nonexistent-session-id')).toBeNull();
  });

  it('returns null when the root directory does not exist', () => {
    const discovery = { roots: [path.join(tmpDir, 'absent')], patterns: ['{sessionId}.jsonl'] };
    expect(resolveTranscriptPath(discovery, 'some-session')).toBeNull();
  });

  it('returns null on an empty session id rather than matching an arbitrary file', () => {
    plantCodex('019d839a-0c22-7072-97fa-3d1b16910b0d');
    expect(resolveTranscriptPath(codexDiscovery(), '')).toBeNull();
  });

  it('returns null when discovery is undeclared (plugin-reported agents)', () => {
    expect(resolveTranscriptPath(undefined, 'any-session')).toBeNull();
  });

  /** Antigravity layout: <surface>/brain/<id>/.system_generated/logs/transcript_full.jsonl */
  function antigravityDiscovery() {
    return {
      roots: [
        path.join(tmpDir, 'antigravity-cli'),
        path.join(tmpDir, 'antigravity'),
        path.join(tmpDir, 'antigravity-ide'),
      ],
      patterns: ['brain/{sessionId}/.system_generated/logs/transcript_full.jsonl'],
    };
  }

  function plantAntigravity(surface: string, id: string, content = '{}'): string {
    const dir = path.join(tmpDir, surface, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  }

  it.each(['antigravity-cli', 'antigravity', 'antigravity-ide'])(
    'finds a transcript planted under %s',
    (surface) => {
      const id = '85774e9a-997d-4d75-ae7a-b1a688bb3863';
      const planted = plantAntigravity(surface, id);
      expect(resolveTranscriptPath(antigravityDiscovery(), id)).toBe(planted);
    },
  );

  it('prefers the first declared root when the same id exists on several surfaces', () => {
    const id = 'shared-id-edge-case';
    const cliPath = plantAntigravity('antigravity-cli', id, '{"source":"cli"}');
    plantAntigravity('antigravity', id, '{"source":"app"}');
    expect(resolveTranscriptPath(antigravityDiscovery(), id)).toBe(cliPath);
  });

  it('tries patterns in declared order, so a legacy layout keeps resolving', () => {
    const id = 'legacy-session';
    const dir = path.join(tmpDir, 'projects', 'proj-a', 'agent-transcripts');
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    const legacy = path.join(dir, `${id}.txt`);
    fs.writeFileSync(legacy, 'user: hi');
    fs.writeFileSync(path.join(dir, id, `${id}.jsonl`), '{}');

    const discovery = {
      roots: [path.join(tmpDir, 'projects')],
      patterns: ['*/agent-transcripts/{sessionId}.txt', '*/agent-transcripts/{sessionId}/{sessionId}.jsonl'],
    };
    expect(resolveTranscriptPath(discovery, id)).toBe(legacy);
  });

  it('does not mistake a directory named like a transcript for the transcript', () => {
    const id = 'dir-not-file';
    fs.mkdirSync(path.join(tmpDir, 'flat', `${id}.jsonl`), { recursive: true });
    const discovery = { roots: [path.join(tmpDir, 'flat')], patterns: ['{sessionId}.jsonl'] };
    expect(resolveTranscriptPath(discovery, id)).toBeNull();
  });

  describe('enumeration', () => {
    it('recovers the full session id when a wildcard abuts it', () => {
      // Regression: the timestamp and the id are both dash-delimited, so
      // without `sessionIdPattern` the split lands mid-id and yields only the
      // trailing group.
      const sessionId = '019ab0f0-dd3c-78e3-b654-7739a771d9d5';
      const planted = plantCodex(sessionId);
      expect(enumerateTranscripts(codexDiscovery())).toEqual([{ sessionId, filePath: planted }]);
    });

    it('finds transcripts that no session row could have pointed at', () => {
      const ids = ['019ab0f0-dd3c-78e3-b654-7739a771d9d5', '019ab0f0-dd3c-78e3-b654-000000000001'];
      ids.forEach((id) => plantCodex(id));
      const found = enumerateTranscripts(codexDiscovery()).map((t) => t.sessionId).sort();
      expect(found).toEqual([...ids].sort());
    });

    it('returns an empty list when discovery is undeclared', () => {
      expect(enumerateTranscripts(undefined)).toEqual([]);
    });

    it('honours the limit so one deep history cannot dominate a run', () => {
      for (let i = 0; i < 5; i++) {
        plantCodex(`019ab0f0-dd3c-78e3-b654-00000000000${i}`);
      }
      expect(enumerateTranscripts(codexDiscovery(), 3)).toHaveLength(3);
    });

    it('reports each session once even when several patterns could match it', () => {
      const id = 'dup-session';
      const dir = path.join(tmpDir, 'projects', 'proj-a', 'agent-transcripts');
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.txt`), 'user: hi');
      fs.writeFileSync(path.join(dir, id, `${id}.jsonl`), '{}');

      const discovery = {
        roots: [path.join(tmpDir, 'projects')],
        patterns: ['*/agent-transcripts/{sessionId}.txt', '*/agent-transcripts/{sessionId}/{sessionId}.jsonl'],
      };
      expect(enumerateTranscripts(discovery)).toHaveLength(1);
    });
  });
});

describe('expandRoot', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(expandRoot('~/.codex/sessions')).toBe(path.join(os.homedir(), '.codex/sessions'));
  });

  it('expands environment variables so relocatable data dirs resolve', () => {
    expect(expandRoot('$OPENCODE_DATA_DIR/storage', { OPENCODE_DATA_DIR: '/custom/oc' })).toBe('/custom/oc/storage');
  });

  it('leaves an unset variable untouched rather than resolving to an empty path', () => {
    expect(expandRoot('$NOT_SET_ANYWHERE/storage', {})).toBe('$NOT_SET_ANYWHERE/storage');
  });

  it('leaves an absolute path unchanged', () => {
    expect(expandRoot('/var/transcripts')).toBe('/var/transcripts');
  });
});
