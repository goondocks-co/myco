import { z } from 'zod';

export const SessionFrontmatterSchema = z.object({
  type: z.literal('session'),
  id: z.string(),
  agent: z.string(),
  user: z.string(),
  started: z.string(),
  ended: z.string().optional(),
  parent: z.string().optional(),
  parent_reason: z.string().optional(),
  plan: z.string().optional(),          // backward compat read path
  plans: z.array(z.string()).optional(), // new: multiple plans
  branch: z.string().optional(),
  tags: z.array(z.string()).default([]),
  tools_used: z.number().int().optional(),
  files_changed: z.number().int().optional(),
});

export const PlanFrontmatterSchema = z.object({
  type: z.literal('plan'),
  id: z.string(),
  status: z.enum(['active', 'in_progress', 'completed', 'abandoned']).default('active'),
  created: z.string(),
  author: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export const MemoryFrontmatterSchema = z.object({
  type: z.literal('memory'),
  id: z.string(),
  observation_type: z.string(),
  session: z.string().optional(),
  plan: z.string().optional(),
  created: z.string(),
  tags: z.array(z.string()).default([]),
});

export const ARTIFACT_TYPES = ['spec', 'plan', 'rfc', 'doc', 'other'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ArtifactFrontmatterSchema = z.object({
  type: z.literal('artifact'),
  id: z.string(),
  artifact_type: z.enum(ARTIFACT_TYPES).default('other'),
  source_path: z.string(),
  title: z.string(),
  last_captured_by: z.string(),
  created: z.string(),
  updated: z.string(),
  tags: z.array(z.string()).default([]),
});

export const TeamMemberFrontmatterSchema = z.object({
  type: z.literal('team-member'),
  user: z.string(),
  joined: z.string(),
  role: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type SessionFrontmatter = z.infer<typeof SessionFrontmatterSchema>;
export type PlanFrontmatter = z.infer<typeof PlanFrontmatterSchema>;
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;
export type ObservationType = MemoryFrontmatter['observation_type'];
export type ArtifactFrontmatter = z.infer<typeof ArtifactFrontmatterSchema>;
export type TeamMemberFrontmatter = z.infer<typeof TeamMemberFrontmatterSchema>;

export type NoteFrontmatter =
  | SessionFrontmatter
  | PlanFrontmatter
  | MemoryFrontmatter
  | ArtifactFrontmatter
  | TeamMemberFrontmatter;

export interface VaultNote<T extends NoteFrontmatter = NoteFrontmatter> {
  path: string;
  frontmatter: T;
  content: string;
}

const schemasByType: Record<string, z.ZodSchema> = {
  session: SessionFrontmatterSchema,
  plan: PlanFrontmatterSchema,
  memory: MemoryFrontmatterSchema,
  artifact: ArtifactFrontmatterSchema,
  'team-member': TeamMemberFrontmatterSchema,
};

export function parseNoteFrontmatter(data: Record<string, unknown>): NoteFrontmatter {
  const type = data.type as string;
  const schema = schemasByType[type];
  if (!schema) {
    throw new Error(`Unknown note type: ${type}`);
  }
  return schema.parse(data) as NoteFrontmatter;
}
