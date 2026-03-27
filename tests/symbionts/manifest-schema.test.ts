import { describe, it, expect } from 'vitest';
import { SymbiontManifestSchema } from '../../src/symbionts/manifest-schema.js';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MANIFESTS_DIR = path.join(import.meta.dirname, '../../src/symbionts/manifests');

describe('symbiont manifests', () => {
  const manifestFiles = fs.readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.yaml'));

  it('has at least one manifest', () => {
    expect(manifestFiles.length).toBeGreaterThan(0);
  });

  for (const file of manifestFiles) {
    it(`${file} parses against schema`, () => {
      const raw = fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf-8');
      const data = YAML.parse(raw);
      const result = SymbiontManifestSchema.parse(data);
      expect(result.name).toBeTruthy();
      expect(result.displayName).toBeTruthy();
      expect(result.binary).toBeTruthy();
    });
  }

  it('claude-code manifest has pluginInstallCommands', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.pluginInstallCommands.length).toBeGreaterThan(0);
    expect(manifest.pluginInstallCommands.some(c => c.includes('myco'))).toBe(true);
  });

  it('cursor manifest has mcpConfigPath', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'cursor.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.mcpConfigPath).toBe('.cursor/mcp.json');
  });

  it('accepts optional capture.planDirs field', () => {
    const manifest = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'tp', lastResponse: 'lr', sessionId: 'sid' },
      capture: { planDirs: ['.test/plans/'] },
    });
    expect(manifest.capture?.planDirs).toEqual(['.test/plans/']);
  });

  it('defaults capture.planDirs to empty array when capture provided without planDirs', () => {
    const manifest = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'tp', lastResponse: 'lr', sessionId: 'sid' },
      capture: {},
    });
    expect(manifest.capture?.planDirs).toEqual([]);
  });

  it('allows manifest without capture block', () => {
    const manifest = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'tp', lastResponse: 'lr', sessionId: 'sid' },
    });
    expect(manifest.capture).toBeUndefined();
  });
});
