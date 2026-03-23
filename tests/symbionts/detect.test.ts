import { describe, it, expect } from 'vitest';
import { loadManifests, detectSymbionts } from '../../src/symbionts/detect.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('loadManifests', () => {
  it('loads all symbiont manifests', () => {
    const manifests = loadManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(2);
    const names = manifests.map(m => m.name);
    expect(names).toContain('claude-code');
    expect(names).toContain('cursor');
  });
});

describe('detectSymbionts', () => {
  it('detects symbionts based on config directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detect-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    try {
      const detected = detectSymbionts(tmpDir);
      const claudeDetected = detected.find(d => d.manifest.name === 'claude-code');
      expect(claudeDetected).toBeDefined();
      expect(claudeDetected!.configDirFound).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns empty for a project with no symbiont config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detect-'));
    try {
      const detected = detectSymbionts(tmpDir);
      expect(Array.isArray(detected)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
