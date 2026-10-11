import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readPrivateJson, writePrivateFileAtomic } from '@myco/member/store.js';

const AnswersSchema = z.object({
  role: z.enum(['join', 'runner']).optional(),
  url: z.url().refine((value) => new URL(value).origin === value, 'expected a Deployment origin').optional(),
  root: z.string().optional(),
  project: z.string().optional(),
  newProject: z.union([z.string(), z.literal(true)]).optional(),
  noAgents: z.boolean().optional(),
  makeDefault: z.boolean().optional(),
  runWork: z.boolean().optional(),
  runnerName: z.string().optional(),
  runnerService: z.enum(['install', 'skip']).optional(),
}).strict();
const SetupFileSchema = z.object({
  version: z.literal(1),
  answers: AnswersSchema,
  consented: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();

export type SetupAnswers = z.infer<typeof AnswersSchema>;
export type SetupFile = z.infer<typeof SetupFileSchema>;
export const setupFilePath = (home: string): string => path.join(home, 'setup.json');

export function readSetupFile(home: string): SetupFile {
  const file = setupFilePath(home);
  const read = readPrivateJson<unknown>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return { version: 1, answers: {}, consented: {} };
    throw new Error(`${file}: ${read.reason}`);
  }
  const parsed = SetupFileSchema.safeParse(read.value);
  if (!parsed.success) throw new Error(`${file}: malformed setup answers`);
  return parsed.data;
}

/** Setup persists choices and consent only; credentials and completion belong to their owners. */
export function saveSetupFile(home: string, value: SetupFile): void {
  const parsed = SetupFileSchema.parse(value);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(setupFilePath(home), `${JSON.stringify(parsed, null, 2)}\n`);
}

export type SetupPlan = { [key: string]: string | number | boolean | null | SetupPlan | readonly (string | SetupPlan)[] };

export function canonicalPlan(plan: SetupPlan): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    : value;
  return JSON.stringify(canonical(plan));
}

export const planFingerprint = (plan: SetupPlan): string => crypto.createHash('sha256').update(canonicalPlan(plan)).digest('hex');
