import { z } from 'zod';

/**
 * Declarative capture rules owned per-symbiont in its YAML manifest.
 *
 * Rules let each symbiont describe how Myco should filter or rewrite
 * captured events *without* adding symbiont-specific branches inside
 * the generic hook handlers. The hook loads the rules, a generic
 * evaluator decides the action, and the hook acts on the result.
 *
 * Condition types (in `when`):
 *   - `transcript_path_missing`: structural. Fires when the hook's
 *     transcript_path field is absent/empty. A legitimate user-facing
 *     session records a transcript; an ephemeral sub-invocation (e.g.,
 *     an agent's internal title-generation call) does not. Preferred
 *     over text matching because it doesn't drift as UIs evolve.
 *   - `prompt_starts_with` / `prompt_contains`: text fallback. Use
 *     when no structural signal is available. Document the upgrade path
 *     in the YAML so future maintainers can replace it when a better
 *     signal appears.
 *
 * Scope semantics:
 *   - `this_agent` (default): rule fires only when the detected agent
 *     matches the manifest that owns the rule. Use for behavior that
 *     is specific to the symbiont and can rely on detection working.
 *   - `any_agent`: rule fires regardless of detected agent. Use for
 *     patterns where detection itself might fail — e.g., an internal
 *     sub-invocation that omits the fields agent detection keys on.
 *
 * Events:
 *   - `session_start`: fires on SessionStart, before any prompts or
 *     tools are captured. The right place to catch ephemeral sub-
 *     invocations so they're never registered as sessions at all.
 *   - `user_prompt`: fires on UserPromptSubmit. Safety net for anything
 *     that slips past session_start, and the only layer where
 *     `rewrite_prompt` makes sense (prompt text doesn't exist until
 *     the prompt is submitted).
 *
 * Actions:
 *   - `drop`: discard the event entirely. For session_start, the hook
 *     skips registering the session row. For user_prompt, the hook
 *     skips posting the event and cascade-deletes any session row that
 *     may have been registered before the drop rule could fire.
 *   - `rewrite_prompt`: replace the captured prompt with the substring
 *     after `extract_after`. Only valid for `user_prompt` events.
 */
const CaptureRuleSchema = z.object({
  event: z.enum(['session_start', 'user_prompt']),
  scope: z.enum(['this_agent', 'any_agent']).default('this_agent'),
  when: z.object({
    prompt_starts_with: z.string().optional(),
    prompt_contains: z.string().optional(),
    /** Structural: fires when transcript_path is absent or empty. */
    transcript_path_missing: z.boolean().optional(),
  }),
  action: z.enum(['drop', 'rewrite_prompt']),
  /** Short audit string logged when the rule matches (e.g., "codex-internal-title-gen"). */
  reason: z.string().optional(),
  /** For rewrite_prompt: keep only the substring after this marker (first occurrence). */
  extract_after: z.string().optional(),
  /** For rewrite_prompt: trim whitespace from the extracted substring. Default true. */
  trim: z.boolean().default(true),
});

export type CaptureRule = z.infer<typeof CaptureRuleSchema>;

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
  rules: z.array(CaptureRuleSchema).default([]),
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
