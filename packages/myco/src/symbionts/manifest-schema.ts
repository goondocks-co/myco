import { z } from 'zod';

/** Per-symbiont capture rules that filter or rewrite events. Scope and event
 *  keys are documented in docs/symbiont-manifests.md. */
const CaptureRuleSchema = z.object({
  event: z.enum(['session_start', 'user_prompt']),
  scope: z.enum(['this_agent', 'any_agent']).default('this_agent'),
  when: z.object({
    prompt_starts_with: z.string().optional(),
    prompt_contains: z.string().optional(),
    /** Fires when transcript_path is absent or empty. */
    transcript_path_missing: z.boolean().optional(),
    /** Fires when a dot-path field in session_meta exists and is truthy. */
    transcript_meta_field_exists: z.string().optional(),
    /** Fires when a dot-path field in session_meta equals a scalar value. */
    transcript_meta_field_equals: z.object({
      path: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }).optional(),
  }),
  action: z.enum(['drop', 'rewrite_prompt']),
  /** Audit string logged when the rule matches. */
  reason: z.string().optional(),
  /** For rewrite_prompt: keep the substring after this marker. */
  extract_after: z.string().optional(),
  /** For rewrite_prompt: trim whitespace from the extracted substring. */
  trim: z.boolean().default(true),
});

export type CaptureRule = z.infer<typeof CaptureRuleSchema>;

/** Schema describing where user prompts live in an agent's transcript. */
const MatchExpressionSchema = z.object({
  /** Event's `type` field must equal this value. */
  type: z.string(),
  /** Event must have this dot-path field present and truthy. */
  hasField: z.string().optional(),
  /**
   * Dot-path → value pairs that must all match the event. Scalars are
   * compared with ===. Use for disambiguating sub-shapes (e.g. a Codex
   * `response_item` with `payload.role: "user"`).
   */
  fieldEquals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /**
   * Dot-path → value pairs that must all NOT match the event. Used to exclude
   * structurally-similar synthesized entries (e.g. Claude Code's `isMeta: true`
   * transcript entries for local-command caveats and skill injections) from
   * matching a shape meant for real user prompts.
   */
  fieldNotEquals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const PromptShapeSchema = z.object({
  /** Informational label used in audit logs. */
  name: z.string().optional(),
  match: MatchExpressionSchema,
  /**
   * Dot-path identifying the user-authored text. If the resolved value is
   * a string it is used as-is; if it's an array of typed blocks (the
   * Claude Code tool_result shape), the first `{type:"text"}` block's
   * `text` field is used.
   */
  textAt: z.string(),
  /**
   * Dot-path to a stable identifier for the prompt. Used to dedupe events
   * that appear more than once in the transcript (e.g. a `promptId` that
   * shows up on both the user prompt line and on tool_result entries for
   * the same turn).
   */
  dedupeBy: z.string().optional(),
});

const ResetBoundarySchema = z.object({
  match: MatchExpressionSchema,
  /**
   * Dot-path whose value change signals a new boundary. Useful for
   * events that fire throughout a turn but only mark a boundary when
   * a specific field (e.g. `payload.turn_id`) advances.
   */
  changeOn: z.string().optional(),
});

const CapturePromptsSchema = z.object({
  shapes: z.array(PromptShapeSchema).default([]),
  resetBoundaries: z.array(ResetBoundarySchema).default([]),
  /** Literal prefix that marks a user-initiated interrupt of the agent's turn. */
  interruptMarker: z.string().optional(),
});

export type PromptShape = z.infer<typeof PromptShapeSchema>;
export type ResetBoundary = z.infer<typeof ResetBoundarySchema>;
export type CapturePrompts = z.infer<typeof CapturePromptsSchema>;
export type MatchExpression = z.infer<typeof MatchExpressionSchema>;

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
  planTags: z.array(z.string()).default([]),
  rules: z.array(CaptureRuleSchema).default([]),
  prompts: CapturePromptsSchema.optional(),
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
  /** Top-level `version` integer written alongside the `hooks` object. */
  hooksConfigVersion: z.number().optional(),
  /**
   * Hook stdout contract. `plain-text` writes `additionalContext` verbatim;
   * `json` emits a flat object with semantic HookResponse fields renamed
   * via `fieldNames` (unmapped fields are dropped).
   */
  hookResponse: z.object({
    format: z.enum(['plain-text', 'json']),
    fieldNames: z.record(z.string(), z.string()).optional(),
  }).optional(),
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
   * Optional working directory injected verbatim into the Myco MCP server entry.
   * Used by symbionts (for example Codex with `.`) whose MCP child would
   * otherwise launch with a cwd that breaks vault discovery.
   */
  mcpCwd: z.string().optional(),
  /**
   * Installer rewrites `myco-run` references to the absolute path from
   * `.myco/runtime.command` at install time. Use only for hosts whose PATH
   * order can't reach the dev shim (e.g., opencode prepending /opt/homebrew/bin).
   */
  substituteRuntimeCommand: z.boolean().optional(),
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

/**
 * Optional capability flags that gate Myco features per symbiont. All
 * capabilities default to `false` when the field is absent so adding a new
 * capability never silently activates it for existing symbionts.
 */
const CapabilitiesSchema = z.object({
  /**
   * Whether this symbiont can carry context injected from a PreToolUse hook
   * response. Claude Code supports this via hookSpecificOutput.additionalContext;
   * other symbionts flip this on as their hook surfaces mature.
   */
  preToolUseInjection: z.boolean().default(false),
}).default(() => ({ preToolUseInjection: false }));

export type SymbiontCapabilities = z.infer<typeof CapabilitiesSchema>;

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
  capabilities: CapabilitiesSchema.optional(),
});

export type SymbiontManifest = z.infer<typeof SymbiontManifestSchema>;
export type SymbiontRegistration = z.infer<typeof RegistrationSchema>;
