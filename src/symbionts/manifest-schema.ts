import { z } from 'zod';

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
});

const RegistrationSchema = z.object({
  hooksTarget: z.string().optional(),
  /**
   * Format of the hooks target.
   * - 'json' (default): hooks template is merged into a JSON settings file.
   * - 'plugin-file': the hooks template is a verbatim file (e.g., an opencode TS plugin)
   *   copied to hooksTarget without JSON parsing. Used for agents with plugin-based hook
   *   systems rather than JSON hook entries.
   */
  hooksFormat: z.enum(['json', 'plugin-file']).default('json'),
  /**
   * Optional file path for a plugin deps package.json. When set, the installer writes
   * a package.json declaring the plugin SDK dependency so the agent's package manager
   * (e.g., opencode's Bun) can install it at startup. Preserved on uninstall so
   * contributors can keep their own deps.
   */
  pluginPackageTarget: z.string().optional(),
  mcpTarget: z.string().optional(),
  mcpFormat: z.enum(['json', 'toml']).default('json'),
  /**
   * JSON key under which MCP server entries are stored in the MCP config file.
   * Defaults to 'mcpServers' (used by Claude Code, Cursor, etc.). opencode uses 'mcp'.
   */
  mcpServersKey: z.string().default('mcpServers'),
  skillsTarget: z.string().optional(),
  settingsTarget: z.string().optional(),
  /** Format of the settings file. TOML-format agents (e.g., Codex) emit top-level template keys as TOML sections. */
  settingsFormat: z.enum(['json', 'toml']).default('json'),
  /** Instruction file that stubs out to AGENTS.md. Only for agents that don't read AGENTS.md natively. */
  instructionsFile: z.string().optional(),
});

export const SymbiontManifestSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  binary: z.string(),
  configDir: z.string(),
  pluginRootEnvVar: z.string(),
  settingsPath: z.string().optional(),
  hookFields: z.object({
    sessionId: z.string(),
    transcriptPath: z.string(),
    lastResponse: z.string(),
    prompt: z.string().default('prompt'),
    toolName: z.string().default('tool_name'),
    toolInput: z.string().default('tool_input'),
    toolOutput: z.string().default('tool_output'),
    /** Env var fallback for session ID (e.g., GEMINI_SESSION_ID). */
    sessionIdEnv: z.string().optional(),
  }),
  /** Resume command template with {sessionId} placeholder. Omit for IDE-based agents. */
  resumeCommand: z.string().optional(),
  capture: CaptureManifestSchema.optional(),
  registration: RegistrationSchema.optional(),
});

export type SymbiontManifest = z.infer<typeof SymbiontManifestSchema>;
export type SymbiontRegistration = z.infer<typeof RegistrationSchema>;
