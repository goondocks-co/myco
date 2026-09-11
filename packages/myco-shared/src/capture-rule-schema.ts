import { z } from 'zod';

export const CaptureRuleSchema = z.object({
  event: z.enum(['session_start', 'user_prompt']),
  scope: z.enum(['this_agent', 'any_agent']).default('this_agent'),
  when: z.object({
    prompt_starts_with: z.string().optional(),
    prompt_contains: z.string().optional(),
    /** Matches an absent or empty transcript path. */
    transcript_path_missing: z.boolean().optional(),
    /** Matches a truthy dot-path value in the original transcript header. */
    transcript_meta_field_exists: z.string().optional(),

    transcript_meta_field_equals: z.object({
      path: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }).optional(),
    /** Matches a scalar on the raw transcript record. */
    record_field_equals: z.object({
      path: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }).optional(),

    prompt_envelope_tag_in: z.array(z.string()).optional(),

    prompt_is_enclosing_envelope: z.boolean().optional(),
  }),
  action: z.enum(['drop', 'rewrite_prompt', 'classify']),

  reason: z.string().optional(),

  extract_after: z.string().optional(),
  /** Rewriting requires both enclosing boundaries and a nonempty body. */
  strip_envelope: z.object({
    open: z.string().min(1),
    close: z.string().min(1),
  }).optional(),

  trim: z.boolean().default(true),

  set_origin: z.enum(['human', 'system', 'agent_dispatch', 'hook_injected']).optional(),
});

export type CaptureRule = z.infer<typeof CaptureRuleSchema>;
