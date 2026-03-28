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

  it('claude-code manifest has registration with hooks and targets', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration?.hooksTarget).toBe('.claude/settings.json');
    expect(manifest.registration?.mcpTarget).toBe('.mcp.json');
    expect(manifest.registration?.skillsTarget).toBe('.claude/skills');
  });

  it('cursor manifest has registration with mcpTarget and skillsTarget', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'cursor.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration?.hooksTarget).toBeUndefined();
    expect(manifest.registration?.mcpTarget).toBe('.cursor/mcp.json');
    expect(manifest.registration?.skillsTarget).toBe('.cursor/skills');
  });

  it('accepts manifest with registration section', () => {
    const manifest = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'tp', lastResponse: 'lr', sessionId: 'sid' },
      registration: {
        hooksTarget: '.test/settings.json',
        mcpTarget: '.test/mcp.json',
        skillsTarget: '.test/skills',
      },
    });
    expect(manifest.registration?.hooksTarget).toBe('.test/settings.json');
    expect(manifest.registration?.mcpTarget).toBe('.test/mcp.json');
    expect(manifest.registration?.skillsTarget).toBe('.test/skills');
  });

  it('allows manifest without registration block', () => {
    const manifest = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'tp', lastResponse: 'lr', sessionId: 'sid' },
    });
    expect(manifest.registration).toBeUndefined();
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

  it('vscode-copilot manifest has registration with github hooks target', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'vscode-copilot.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration!.hooksTarget).toBe('.github/hooks/myco-hooks.json');
    expect(manifest.registration!.mcpTarget).toBe('.vscode/mcp.json');
    expect(manifest.registration!.skillsTarget).toBe('.agents/skills');
    expect(manifest.registration!.settingsTarget).toBe('.vscode/settings.json');
  });

  it('claude-code manifest has settingsTarget', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration!.settingsTarget).toBe('.claude/settings.json');
  });

  it('cursor manifest has settingsTarget', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'cursor.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration!.settingsTarget).toBe('.cursor/settings.json');
  });

  it('codex manifest has settingsTarget', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'codex.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration!.settingsTarget).toBe('.codex/config.toml');
  });

  it('codex manifest has registration with toml mcpFormat', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'codex.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration!.mcpTarget).toBe('.codex/config.toml');
    expect(manifest.registration!.mcpFormat).toBe('toml');
    expect(manifest.registration!.skillsTarget).toBe('.agents/skills');
    expect(manifest.registration!.hooksTarget).toBe('.codex/hooks.json');
  });

  it('gemini manifest has registration with shared settings target', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'gemini.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration!.hooksTarget).toBe('.gemini/settings.json');
    expect(manifest.registration!.mcpTarget).toBe('.gemini/settings.json');
    expect(manifest.registration!.skillsTarget).toBe('.agents/skills');
    expect(manifest.registration!.settingsTarget).toBe('.gemini/settings.json');
  });

  it('defaults mcpFormat to json when not specified', () => {
    const manifest = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'tp', lastResponse: 'lr', sessionId: 'sid' },
      registration: {
        mcpTarget: '.test/mcp.json',
      },
    });
    expect(manifest.registration!.mcpFormat).toBe('json');
  });
});
