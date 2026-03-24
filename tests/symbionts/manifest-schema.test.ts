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

  it('claude-code manifest has pluginInstallCommand', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.pluginInstallCommand).toContain('{packageRoot}');
  });

  it('cursor manifest has mcpConfigPath', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'cursor.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.mcpConfigPath).toBe('.cursor/mcp.json');
  });
});
