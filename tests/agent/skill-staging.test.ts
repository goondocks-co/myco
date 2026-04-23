/**
 * Tests for the skill staging filesystem helpers used by vault_write_skill
 * and vault_finalize_skill. The staging layer writes provisional SKILL.md
 * content to .myco/staging/skills/<candidate_id>/ and is cleaned up by
 * vault_finalize_skill on success, by the task executor on phase failure,
 * and by the daemon periodic sweep for abandoned entries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  stagingRoot,
  stagingPath,
  stagingManifestPath,
  writeStagedSkill,
  readStagedSkill,
  writeStagedManifest,
  readStagedManifest,
  cleanupStagedSkill,
  listStaleStagingDirs,
  type StagedManifest,
} from '@myco/agent/tools/skill-staging.js';

describe('skill staging helpers', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-staging-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch {
      /* best-effort */
    }
  });

  describe('stagingRoot / stagingPath', () => {
    it('stagingRoot returns .myco/staging/skills under vaultDir', () => {
      expect(stagingRoot(vaultDir)).toBe(path.resolve(vaultDir, 'staging', 'skills'));
    });

    it('stagingPath keys by candidate id', () => {
      const candidateId = 'cand-abc-123';
      expect(stagingPath(vaultDir, candidateId)).toBe(
        path.resolve(vaultDir, 'staging', 'skills', candidateId, 'SKILL.md'),
      );
    });
  });

  describe('writeStagedSkill / readStagedSkill', () => {
    it('round-trips SKILL.md content for a candidate', () => {
      const content = '---\nname: myco:test-skill\n---\n\n# Test\n';
      const written = writeStagedSkill(vaultDir, 'cand-1', content);

      expect(fs.existsSync(written)).toBe(true);
      expect(readStagedSkill(vaultDir, 'cand-1')).toBe(content);
    });

    it('readStagedSkill returns null when no staged content exists', () => {
      expect(readStagedSkill(vaultDir, 'cand-missing')).toBeNull();
    });

    it('writeStagedSkill overwrites prior content for the same candidate', () => {
      writeStagedSkill(vaultDir, 'cand-2', 'original');
      writeStagedSkill(vaultDir, 'cand-2', 'rewritten');
      expect(readStagedSkill(vaultDir, 'cand-2')).toBe('rewritten');
    });

    it('writeStagedSkill creates intermediate directories', () => {
      const staging = stagingRoot(vaultDir);
      expect(fs.existsSync(staging)).toBe(false); // not created yet
      writeStagedSkill(vaultDir, 'cand-3', 'content');
      expect(fs.existsSync(path.resolve(staging, 'cand-3', 'SKILL.md'))).toBe(true);
    });
  });

  describe('manifest round-trip', () => {
    const manifest: StagedManifest = {
      candidate_id: 'cand-m',
      name: 'test-skill',
      display_name: 'Test Skill',
      description: 'A skill for round-trip tests',
      source_ids: '[]',
      rationale: 'fixture',
    };

    it('stagingManifestPath points to manifest.json alongside SKILL.md', () => {
      expect(stagingManifestPath(vaultDir, 'cand-m')).toBe(
        path.resolve(vaultDir, 'staging', 'skills', 'cand-m', 'manifest.json'),
      );
    });

    it('writes and reads a manifest', () => {
      writeStagedManifest(vaultDir, 'cand-m', manifest);
      expect(readStagedManifest(vaultDir, 'cand-m')).toEqual(manifest);
    });

    it('returns null when no manifest is staged', () => {
      expect(readStagedManifest(vaultDir, 'cand-none')).toBeNull();
    });

    it('manifest and SKILL.md coexist in the same directory', () => {
      writeStagedSkill(vaultDir, 'cand-both', '---\nname: myco:test\n---');
      writeStagedManifest(vaultDir, 'cand-both', manifest);
      expect(readStagedSkill(vaultDir, 'cand-both')).toContain('myco:test');
      expect(readStagedManifest(vaultDir, 'cand-both')).toEqual(manifest);
    });
  });

  describe('cleanupStagedSkill', () => {
    it('removes the staging directory for a candidate', () => {
      writeStagedSkill(vaultDir, 'cand-rm', 'doomed');
      const dir = path.resolve(stagingRoot(vaultDir), 'cand-rm');
      expect(fs.existsSync(dir)).toBe(true);

      cleanupStagedSkill(vaultDir, 'cand-rm');
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('is idempotent when nothing is staged', () => {
      expect(() => cleanupStagedSkill(vaultDir, 'cand-never-existed')).not.toThrow();
    });

    it('leaves sibling staging dirs alone', () => {
      writeStagedSkill(vaultDir, 'cand-a', 'a');
      writeStagedSkill(vaultDir, 'cand-b', 'b');

      cleanupStagedSkill(vaultDir, 'cand-a');

      expect(readStagedSkill(vaultDir, 'cand-a')).toBeNull();
      expect(readStagedSkill(vaultDir, 'cand-b')).toBe('b');
    });
  });

  describe('listStaleStagingDirs', () => {
    it('returns an empty array when staging root does not exist', () => {
      expect(listStaleStagingDirs(vaultDir, 1000)).toEqual([]);
    });

    it('excludes fresh entries under the age threshold', () => {
      writeStagedSkill(vaultDir, 'cand-fresh', 'just written');
      // 1 hour threshold — fresh entry should not be listed
      expect(listStaleStagingDirs(vaultDir, 60 * 60 * 1000)).toEqual([]);
    });

    it('includes entries older than the age threshold', () => {
      writeStagedSkill(vaultDir, 'cand-old', 'ancient');
      // Backdate the directory mtime to 2 hours ago
      const dir = path.resolve(stagingRoot(vaultDir), 'cand-old');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(dir, twoHoursAgo, twoHoursAgo);

      // 1 hour threshold — old entry should be listed
      expect(listStaleStagingDirs(vaultDir, 60 * 60 * 1000)).toEqual(['cand-old']);
    });

    it('returns only directory names, not full paths', () => {
      writeStagedSkill(vaultDir, 'cand-named', 'c');
      const dir = path.resolve(stagingRoot(vaultDir), 'cand-named');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(dir, old, old);

      const stale = listStaleStagingDirs(vaultDir, 60 * 60 * 1000);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toBe('cand-named'); // directory name only
      expect(stale[0]).not.toContain(path.sep);
    });
  });
});
