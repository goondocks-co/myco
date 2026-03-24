import { z } from 'zod';

export const SymbiontManifestSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  binary: z.string(),
  configDir: z.string(),
  pluginRootEnvVar: z.string(),
  pluginInstallCommand: z.string().nullable(),
  settingsPath: z.string().optional(),
  mcpConfigPath: z.string().optional(),
  hookFields: z.object({
    transcriptPath: z.string(),
    lastResponse: z.string(),
    sessionId: z.string(),
  }),
});

export type SymbiontManifest = z.infer<typeof SymbiontManifestSchema>;
