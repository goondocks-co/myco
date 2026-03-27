import { z } from 'zod';

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
});

export const SymbiontManifestSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  binary: z.string(),
  configDir: z.string(),
  pluginRootEnvVar: z.string(),
  pluginInstallCommands: z.array(z.string()).default([]),
  settingsPath: z.string().optional(),
  mcpConfigPath: z.string().optional(),
  hookFields: z.object({
    transcriptPath: z.string(),
    lastResponse: z.string(),
    sessionId: z.string(),
  }),
  capture: CaptureManifestSchema.optional(),
});

export type SymbiontManifest = z.infer<typeof SymbiontManifestSchema>;
