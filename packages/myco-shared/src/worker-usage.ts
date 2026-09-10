import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const dollars = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

/** Cumulative totals for one worker attempt. Null means the harness did not report the value. */
export const WorkerUsageSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  cachedTokens: count.optional(),
  cacheCreationTokens: count.optional(),
  costUsd: dollars,
  estimatedCostUsd: dollars.optional(),
}).strict().refine((usage) => usage.inputTokens === null || usage.outputTokens === null
  || Number.isSafeInteger(usage.inputTokens + usage.outputTokens), 'total tokens exceed the safe integer range');

export type WorkerUsage = z.infer<typeof WorkerUsageSchema>;

/** Claims without an attempt identity can complete, but cannot attach accounting. */
export const WorkerAccountingSchema = z.object({
  attemptId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
  usage: WorkerUsageSchema.nullish(),
}).refine((value) => value.usage == null || value.attemptId !== undefined, 'usage names its claimed attemptId');
