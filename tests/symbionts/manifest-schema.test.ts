import { describe, it, expect } from 'bun:test';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';
import { symbiontToolTransport } from '@myco/symbionts/capabilities.js';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MANIFESTS_DIR = path.join(import.meta.dirname, '../../packages/myco/src/symbionts/manifests');

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

  it('cursor manifest has registration with hooksTarget, mcpTarget, and skillsTarget', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'cursor.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration?.hooksTarget).toBe('.cursor/hooks.json');
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

  it('copilot manifest has registration with github hooks target and dual MCP targets', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'copilot.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration!.hooksTarget).toBe('.github/hooks/myco-hooks.json');
    expect(manifest.registration!.mcpTarget).toBe('.vscode/mcp.json');
    expect(manifest.registration!.skillsTarget).toBe('.agents/skills');
    expect(manifest.registration!.settingsTarget).toBe('.vscode/settings.json');
    // Copilot is the canonical multi-target MCP case: two surfaces of
    // the same agent runtime with diverging top-level JSON keys. The
    // schema normalizes the YAML into Array<{path, serversKey?}> so the
    // installer can write each file under its surface's expected key.
    expect(manifest.registration!.globalMcpTarget).toEqual([
      { path: '~/.copilot/mcp-config.json', serversKey: 'mcpServers' },
      { path: '~/Library/Application Support/Code/User/mcp.json', serversKey: 'servers' },
    ]);
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

  it('antigravity manifest has registration with plugin-bundle layout', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'antigravity.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration!.hooksTarget).toBe('.agents/plugins/myco/hooks.json');
    expect(manifest.registration!.mcpTarget).toBe('.agents/plugins/myco/mcp_config.json');
    expect(manifest.registration!.globalHooksTarget).toBe('~/.gemini/config/plugins/myco/hooks.json');
    // Plugin-bundle marker (Google's plugin loader requires it) lives
    // beside hooks.json + mcp_config.json — not inside a sub-dir.
    expect(manifest.registration!.pluginManifestTarget).toBe('.agents/plugins/myco/plugin.json');
    expect(manifest.registration!.globalPluginManifestTarget).toBe('~/.gemini/config/plugins/myco/plugin.json');
    // Skills deliberately do NOT live inside the plugin bundle.
    // Antigravity reads workspace `.agents/skills/` natively (populated
    // by other cross-agent symbiont installs and Myco's intelligence
    // pipeline), and the package myco + myco-rules skills go to
    // Antigravity's user-global skills dir `~/.gemini/antigravity/skills/`.
    // This keeps the plugin bundle lean — only the hook/MCP/manifest
    // surface lives there.
    expect(manifest.registration!.skillsTarget).toBeUndefined();
    expect(manifest.registration!.globalSkillsTarget).toBe('~/.gemini/antigravity/skills');
  });

  it('windsurf manifest has registration without mcpTarget', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'windsurf.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.registration).toBeDefined();
    expect(manifest.registration!.hooksTarget).toBe('.windsurf/hooks.json');
    expect(manifest.registration!.mcpTarget).toBeUndefined();
    expect(manifest.registration!.skillsTarget).toBe('.agents/skills');
    expect(manifest.registration!.settingsTarget).toBe('.windsurf/settings.json');
  });

  it('antigravity manifest has planDirs configured', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'antigravity.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.capture?.planDirs).toEqual(['.agents/plugins/myco/plans/']);
  });

  it('accepts planTags array in capture block', () => {
    const result = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
      },
      capture: { planTags: ['proposed_plan'] },
    });
    expect(result.capture?.planTags).toEqual(['proposed_plan']);
  });

  it('defaults planTags to empty array when not specified', () => {
    const result = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
      },
      capture: { planDirs: ['.test/plans/'] },
    });
    expect(result.capture?.planTags).toEqual([]);
  });

  it('accepts multiple plan tags', () => {
    const result = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
      },
      capture: { planTags: ['proposed_plan', 'implementation_plan'] },
    });
    expect(result.capture?.planTags).toEqual(['proposed_plan', 'implementation_plan']);
  });

  it('planTags coexists with planDirs', () => {
    const result = SymbiontManifestSchema.parse({
      name: 'test-agent',
      displayName: 'Test Agent',
      binary: 'test',
      configDir: '.test',
      pluginRootEnvVar: 'TEST_PLUGIN_ROOT',
      hookFields: {
        sessionId: 'session_id',
        transcriptPath: 'transcript_path',
        lastResponse: 'last_assistant_message',
      },
      capture: {
        planDirs: ['.test/plans/'],
        planTags: ['proposed_plan'],
      },
    });
    expect(result.capture?.planDirs).toEqual(['.test/plans/']);
    expect(result.capture?.planTags).toEqual(['proposed_plan']);
  });

  it('codex manifest captures only proposed_plan Plan Mode artifacts', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'codex.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.capture?.planTags).toEqual(['proposed_plan']);
  });

  it('claude-code manifest has planTags with ultraplan', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const manifest = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(manifest.capture?.planTags).toEqual(['ultraplan']);
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

describe('CapabilitiesSchema.canopyReadTools', () => {
  it('parses a structured read-tool entry', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [{ tool: 'Read', pathField: 'file_path' }],
        pathBearingTools: [{ tool: 'Read', pathField: 'file_path' }],
      },
    });
    expect(m.capabilities?.canopyReadTools).toEqual([
      { tool: 'Read', pathField: 'file_path', pathKind: 'file' },
    ]);
  });

  it('parses a shell-arg read-tool entry with readCommands allowlist', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [{
          tool: 'Bash',
          pathField: 'command',
          extract: 'shell-arg',
          readCommands: ['cat', 'head', 'tail'],
        }],
        pathBearingTools: [{
          tool: 'Bash',
          pathField: 'command',
          extract: 'shell-arg',
          readCommands: ['cat', 'head', 'tail'],
        }],
      },
    });
    expect(m.capabilities?.canopyReadTools?.[0]).toMatchObject({
      tool: 'Bash', pathField: 'command', extract: 'shell-arg',
      readCommands: ['cat', 'head', 'tail'],
    });
  });

  it('defaults canopyReadTools to empty array when capabilities omits it', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {},
    });
    expect(m.capabilities?.canopyReadTools).toEqual([]);
  });

  it('rejects a shell-arg entry without readCommands', () => {
    expect(() => SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [{ tool: 'Bash', pathField: 'command', extract: 'shell-arg' }],
      },
    })).toThrow();
  });

  it('rejects an empty readCommands array', () => {
    expect(() => SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [{ tool: 'Bash', pathField: 'command', extract: 'shell-arg', readCommands: [] }],
      },
    })).toThrow();
  });
});

describe('CapabilitiesSchema.pathBearingTools', () => {
  it('parses a list of structured entries', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        pathBearingTools: [
          { tool: 'Read', pathField: 'file_path' },
          { tool: 'Write', pathField: 'file_path' },
          { tool: 'Edit', pathField: 'file_path' },
          { tool: 'MultiEdit', pathField: 'file_path' },
        ],
      },
    });
    expect(m.capabilities?.pathBearingTools).toEqual([
      { tool: 'Read', pathField: 'file_path', pathKind: 'file' },
      { tool: 'Write', pathField: 'file_path', pathKind: 'file' },
      { tool: 'Edit', pathField: 'file_path', pathKind: 'file' },
      { tool: 'MultiEdit', pathField: 'file_path', pathKind: 'file' },
    ]);
  });

  it('defaults pathBearingTools to empty array when capabilities omits it', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {},
    });
    expect(m.capabilities?.pathBearingTools).toEqual([]);
  });

  it('rejects canopyReadTools non-empty + pathBearingTools empty (refine)', () => {
    expect(() => SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [{ tool: 'Read', pathField: 'file_path' }],
        pathBearingTools: [],
      },
    })).toThrow(/pathBearingTools.*non-empty.*canopyReadTools/);
  });

  it('allows both empty (symbiont without canopy support)', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [],
        pathBearingTools: [],
      },
    });
    expect(m.capabilities?.canopyReadTools).toEqual([]);
    expect(m.capabilities?.pathBearingTools).toEqual([]);
  });

  it('allows pathBearingTools to be a strict superset of canopyReadTools', () => {
    const m = SymbiontManifestSchema.parse({
      name: 'fake', displayName: 'F', binary: 'f', configDir: '.f', pluginRootEnvVar: 'F_ROOT',
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last' },
      capabilities: {
        canopyReadTools: [{ tool: 'Read', pathField: 'file_path' }],
        pathBearingTools: [
          { tool: 'Read', pathField: 'file_path' },
          { tool: 'Write', pathField: 'file_path' },
        ],
      },
    });
    expect(m.capabilities?.canopyReadTools).toHaveLength(1);
    expect(m.capabilities?.pathBearingTools).toHaveLength(2);
  });
});

describe('claude-code manifest declares its file-read tool', () => {
  it('parses with one canopyReadTools entry: Read / file_path', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const m = SymbiontManifestSchema.parse(YAML.parse(raw));
    expect(m.capabilities?.canopyReadTools).toEqual([
      { tool: 'Read', pathField: 'file_path', pathKind: 'file' },
    ]);
  });

  it('declares pathBearingTools covering Read + write-side tools', () => {
    const raw = fs.readFileSync(path.join(MANIFESTS_DIR, 'claude-code.yaml'), 'utf-8');
    const m = SymbiontManifestSchema.parse(YAML.parse(raw));
    const names = (m.capabilities?.pathBearingTools ?? []).map((t) => t.tool);
    expect(names).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'MultiEdit']));
  });
});

describe('codex manifest enables Canopy PreToolUse for Bash reads', () => {
  it('parses with preToolUseInjection=true and one Bash shell-arg entry', () => {
    const yamlPath = path.join(MANIFESTS_DIR, 'codex.yaml');
    const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
    const m = SymbiontManifestSchema.parse(raw);

    expect(m.capabilities?.preToolUseInjection).toBe(true);
    expect(m.capabilities?.canopyReadTools).toHaveLength(1);

    const entry = m.capabilities!.canopyReadTools![0];
    expect(entry).toMatchObject({
      tool: 'Bash',
      pathField: 'command',
      extract: 'shell-arg',
    });
    // Verify the allowlist isn't empty and contains the core read commands.
    expect((entry as { readCommands: string[] }).readCommands)
      .toEqual(expect.arrayContaining(['cat', 'head', 'tail']));
  });

  it('declares pathBearingTools covering Bash shell-arg reads and apply_patch writes', () => {
    const yamlPath = path.join(MANIFESTS_DIR, 'codex.yaml');
    const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
    const m = SymbiontManifestSchema.parse(raw);
    expect(m.capabilities?.pathBearingTools).toHaveLength(2);
    expect(m.capabilities!.pathBearingTools![0]).toMatchObject({
      tool: 'Bash',
      pathField: 'command',
      extract: 'shell-arg',
    });
    expect(m.capabilities!.pathBearingTools![1]).toMatchObject({
      tool: 'apply_patch',
      pathField: 'command',
      extract: 'patch',
    });
  });
});

describe('symbiont tool transport', () => {
  it('cli-transport symbionts cannot carry tenancy over MCP', () => {
    // These agents' MCP child spawns at a non-workspace cwd with no
    // project-dir env and no usable roots — the shell carries tenancy
    // via `myco tool call` instead.
    expect(symbiontToolTransport('codex')).toBe('cli');
    expect(symbiontToolTransport('cursor')).toBe('cli');
    expect(symbiontToolTransport('windsurf')).toBe('cli');
    expect(symbiontToolTransport('antigravity')).toBe('cli');
  });

  it('mcp-transport symbionts resolve the project from the stdio bridge cwd', () => {
    expect(symbiontToolTransport('claude-code')).toBe('mcp');
    expect(symbiontToolTransport('copilot')).toBe('mcp');
    expect(symbiontToolTransport('opencode')).toBe('mcp');
  });

  it('unknown / undefined names default to mcp', () => {
    expect(symbiontToolTransport('does-not-exist')).toBe('mcp');
    expect(symbiontToolTransport(undefined)).toBe('mcp');
  });
});
