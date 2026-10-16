import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readPrivateJson, writePrivateFileAtomic } from '@myco/member/store.js';

const AnswersSchema = z.object({
  role: z.enum(['create', 'join', 'runner']).optional(),
  target: z.enum(['cloudflare', 'local']).optional(),
  accountId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  customUrl: z.url().refine(value => new URL(value).origin === value && new URL(value).protocol === 'https:').optional(),
  addressChoice: z.enum(['workers.dev', 'custom']).optional(),
  org: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/).optional(),
  appName: z.string().trim().min(1).max(34).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  serve: z.enum(['service', 'terminal']).optional(),
  url: z.url().refine((value) => new URL(value).origin === value, 'expected a Deployment origin').optional(),
  root: z.string().optional(),
  project: z.string().optional(),
  newProject: z.union([z.string(), z.literal(true)]).optional(),
  noAgents: z.boolean().optional(),
  cutover: z.boolean().optional(),
  routes: z.record(z.string(), z.string()).optional(),
  skips: z.array(z.string()).optional(),
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
const OBSERVED_ANSWERS = Symbol('observedSetupAnswers');
export type SetupFile = z.infer<typeof SetupFileSchema> & { [OBSERVED_ANSWERS]?: ReadonlySet<string> };
export const setupFilePath = (home: string): string => path.join(home, 'setup.json');

/** The hosted address is an HTTPS origin with no embedded credentials. */
export function setupCloudflareUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('--url needs an https Deployment origin, with no path, query or fragment'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('--url needs an https Deployment origin, with no path, query or fragment');
  return url.origin;
}

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

/** Observed journey values apply to this run and are omitted by every save. */
export function applyObservedSetupJourney(file: SetupFile, journey: SetupAnswers): void {
  const keys = ['role', 'url', 'target', 'root', ...(journey.runWork === undefined ? [] : ['runWork'])];
  const observed = new Set(keys.filter(key => file[OBSERVED_ANSWERS]?.has(key) || Reflect.get(file.answers, key) === undefined));
  file.answers = { ...file.answers, ...Object.fromEntries(Object.entries(journey).filter(([key]) => observed.has(key))) };
  file[OBSERVED_ANSWERS] = observed;
}

export const hasObservedSetupJourney = (file: SetupFile): boolean => file[OBSERVED_ANSWERS]?.has('role') === true;

/** Setup persists choices and consent only; credentials and completion belong to their owners. */
export function saveSetupFile(home: string, value: SetupFile): void {
  const parsed = SetupFileSchema.parse(value);
  const observed = value[OBSERVED_ANSWERS];
  if (observed) parsed.answers = Object.fromEntries(Object.entries(parsed.answers).filter(([key]) => !observed.has(key)));
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
