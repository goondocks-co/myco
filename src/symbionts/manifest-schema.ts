import { z } from 'zod';

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
});

const RegistrationSchema = z.object({
  hooksTarget: z.string().optional(),
  mcpTarget: z.string().optional(),
  skillsTarget: z.string().optional(),
  envTarget: z.enum(['settings', 'mcp-server']).optional(),
});

export const SymbiontManifestSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  binary: z.string(),
  configDir: z.string(),
  pluginRootEnvVar: z.string(),
  settingsPath: z.string().optional(),
  hookFields: z.object({
    transcriptPath: z.string(),
    lastResponse: z.string(),
    sessionId: z.string(),
  }),
  capture: CaptureManifestSchema.optional(),
  registration: RegistrationSchema.optional(),
});

export type SymbiontManifest = z.infer<typeof SymbiontManifestSchema>;
export type SymbiontRegistration = z.infer<typeof RegistrationSchema>;
