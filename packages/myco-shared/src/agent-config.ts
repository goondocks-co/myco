/** Reasoning tiers admitted by Deployment configuration. */
import { z } from 'zod/v4';
export const ReasoningLevelSchema = z.enum(['low', 'default', 'high']);
