/** Retained 1.4 registration locations by symbiont. */
export type LegacyLocationKind = 'hooks' | 'mcp' | 'plugin-file' | 'plugin-manifest' | 'skills';

export interface LegacyLocation {
  agent: string;
  kind: LegacyLocationKind;
  scope: 'global' | 'project';
  path: string;
  serversKey?: string;
  format?: 'json' | 'toml';
}

const g = (agent: string, kind: LegacyLocationKind, p: string, mcp: Pick<LegacyLocation, 'serversKey' | 'format'> = {}): LegacyLocation => ({ agent, kind, scope: 'global', path: p, ...mcp });
const pr = (agent: string, kind: LegacyLocationKind, p: string, mcp: Pick<LegacyLocation, 'serversKey' | 'format'> = {}): LegacyLocation => ({ agent, kind, scope: 'project', path: p, ...mcp });
const JSON_SERVERS = { serversKey: 'mcpServers', format: 'json' } as const;

export const LEGACY_REGISTRATIONS: readonly LegacyLocation[] = [
  g('antigravity', 'plugin-file', '~/.gemini/config/plugins/myco/hooks.json'),
  g('antigravity', 'mcp', '~/.gemini/config/plugins/myco/mcp_config.json', JSON_SERVERS),
  g('antigravity', 'plugin-manifest', '~/.gemini/config/plugins/myco/plugin.json'),
  g('antigravity', 'skills', '~/.agents/skills'),
  g('antigravity', 'skills', '~/.gemini/antigravity/skills'),
  pr('antigravity', 'plugin-file', '.agents/plugins/myco/hooks.json'),
  pr('antigravity', 'mcp', '.agents/plugins/myco/mcp_config.json', JSON_SERVERS),
  pr('antigravity', 'plugin-manifest', '.agents/plugins/myco/plugin.json'),
  g('claude-code', 'hooks', '~/.claude/settings.json'),
  g('claude-code', 'mcp', '~/.claude/settings.json', JSON_SERVERS),
  g('claude-code', 'skills', '~/.claude/skills'),
  pr('claude-code', 'hooks', '.claude/settings.json'),
  pr('claude-code', 'mcp', '.mcp.json', JSON_SERVERS),
  g('cline', 'plugin-file', '~/.cline/plugins/myco.ts'),
  g('cline', 'mcp', '~/.cline/data/settings/cline_mcp_settings.json', JSON_SERVERS),
  g('cline', 'mcp', '~/.cline/mcp.json', JSON_SERVERS),
  g('cline', 'skills', '~/.cline/skills'),
  pr('cline', 'plugin-file', '.cline/plugins/myco.ts'),
  pr('cline', 'mcp', '.cline/mcp.json', JSON_SERVERS),
  g('codex', 'hooks', '~/.codex/hooks.json'),
  g('codex', 'mcp', '~/.codex/config.toml', { serversKey: 'mcp_servers', format: 'toml' }),
  g('codex', 'skills', '~/.agents/skills'),
  g('codex', 'skills', '~/.codex/skills'),
  pr('codex', 'hooks', '.codex/hooks.json'),
  pr('codex', 'mcp', '.codex/config.toml', { serversKey: 'mcp_servers', format: 'toml' }),
  g('copilot', 'hooks', '~/.copilot/hooks/myco-hooks.json'),
  g('copilot', 'mcp', '~/.copilot/mcp-config.json', JSON_SERVERS),
  g('copilot', 'mcp', '~/Library/Application Support/Code/User/mcp.json', { serversKey: 'servers', format: 'json' }),
  g('copilot', 'skills', '~/.agents/skills'),
  g('copilot', 'skills', '~/.copilot/skills'),
  pr('copilot', 'hooks', '.github/hooks/myco-hooks.json'),
  pr('copilot', 'mcp', '.vscode/mcp.json', JSON_SERVERS),
  g('cursor', 'hooks', '~/.cursor/hooks.json'),
  g('cursor', 'mcp', '~/.cursor/mcp.json', JSON_SERVERS),
  g('cursor', 'skills', '~/.agents/skills'),
  g('cursor', 'skills', '~/.cursor/skills'),
  pr('cursor', 'hooks', '.cursor/hooks.json'),
  pr('cursor', 'mcp', '.cursor/mcp.json', JSON_SERVERS),
  g('opencode', 'plugin-file', '~/.config/opencode/plugins/myco.ts'),
  g('opencode', 'mcp', '~/.config/opencode/opencode.json', { serversKey: 'mcp', format: 'json' }),
  g('opencode', 'skills', '~/.agents/skills'),
  g('opencode', 'skills', '~/.config/opencode/skills'),
  pr('opencode', 'plugin-file', '.opencode/plugins/myco.ts'),
  pr('opencode', 'mcp', 'opencode.json', { serversKey: 'mcp', format: 'json' }),
  g('pi', 'plugin-file', '~/.pi/agent/extensions/myco/index.ts'),
  g('pi', 'skills', '~/.agents/skills'),
  g('pi', 'skills', '~/.pi/agent/skills'),
  pr('pi', 'plugin-file', '.pi/extensions/myco/index.ts'),
  g('windsurf', 'hooks', '~/.codeium/windsurf/hooks.json'),
  g('windsurf', 'mcp', '~/.codeium/windsurf/mcp_config.json', JSON_SERVERS),
  g('windsurf', 'skills', '~/.agents/skills'),
  g('windsurf', 'skills', '~/.codeium/windsurf/skills'),
  pr('windsurf', 'hooks', '.windsurf/hooks.json'),
];

export const CLAUDE_PROJECT_MCP: LegacyLocation = g('claude-code', 'mcp', '~/.claude.json', { serversKey: 'projects/<folder>/mcpServers', format: 'json' });
