import { z } from 'zod';

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
});

const RegistrationSchema = z.object({
  hooksTarget: z.string().optional(),
  mcpTarget: z.string().optional(),
  mcpFormat: z.enum(['json', 'toml']).default('json'),
  skillsTarget: z.string().optional(),
  settingsTarget: z.string().optional(),
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
