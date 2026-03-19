/**
 * DigestEngine — synthesizes vault knowledge into tiered context extracts.
 * Metabolism — adaptive timer that throttles digest cycles based on activity.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

import type { MycoIndex, IndexedNote } from '@myco/index/sqlite.js';
import type { LlmProvider, LlmRequestOptions } from '@myco/intelligence/llm.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadPrompt } from '@myco/prompts/index.js';
import { stripReasoningTokens } from '@myco/intelligence/response.js';
import {
  CHARS_PER_TOKEN,
  DIGEST_TIER_MIN_CONTEXT,
  DIGEST_SUBSTRATE_TYPE_WEIGHTS,
  DIGEST_SYSTEM_PROMPT_TOKENS,
  DIGEST_LLM_REQUEST_TIMEOUT_MS,
} from '@myco/constants.js';

// --- Interfaces ---

export interface DigestCycleResult {
  cycleId: string;
  timestamp: string;
  substrate: {
    sessions: string[];
    spores: string[];
    plans: string[];
    artifacts: string[];
    team: string[];
  };
  tiersGenerated: number[];
  model: string;
  durationMs: number;
  tokensUsed: number;
}

/** Simple log function signature for digest progress reporting. */
export type DigestLogFn = (level: 'debug' | 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;

export interface DigestEngineConfig {
  vaultDir: string;
  index: MycoIndex;
  llmProvider: LlmProvider;
  config: MycoConfig;
  log?: DigestLogFn;
}

// --- Constants ---

/** Token overhead estimate for previous extract section wrapper. */
const PREVIOUS_EXTRACT_OVERHEAD_TOKENS = 50;

/** Safety margin for context window — our chars-per-token heuristic underestimates by ~10-15%. */
const CONTEXT_SAFETY_MARGIN = 0.85;

/** Types that are digest output — excluded from substrate to avoid self-digestion. */
const EXTRACT_TYPE = 'extract';

// --- DigestEngine ---

export class DigestEngine {
  private vaultDir: string;
  private index: MycoIndex;
  private llm: LlmProvider;
  private config: MycoConfig;
  private log: DigestLogFn;
  private lastCycleTimestampCache: string | null | undefined = undefined;

  constructor(engineConfig: DigestEngineConfig) {
    this.vaultDir = engineConfig.vaultDir;
    this.index = engineConfig.index;
    this.llm = engineConfig.llmProvider;
    this.config = engineConfig.config;
    this.log = engineConfig.log ?? (() => {});
  }

  /**
   * Query index for recent vault notes to feed into the digest.
   * Filters out extract notes (our own output) and caps at max_notes_per_cycle.
   */
  discoverSubstrate(lastCycleTimestamp: string | null): IndexedNote[] {
    const maxNotes = this.config.digest.substrate.max_notes_per_cycle;

    const notes = lastCycleTimestamp
      ? this.index.query({ updatedSince: lastCycleTimestamp, limit: maxNotes })
      : this.index.query({ limit: maxNotes });

    const filtered = notes.filter((n) => n.type !== EXTRACT_TYPE);

    // Sort by type weight (descending) then by recency (descending)
    filtered.sort((a, b) => {
      const weightA = DIGEST_SUBSTRATE_TYPE_WEIGHTS[a.type] ?? 0;
      const weightB = DIGEST_SUBSTRATE_TYPE_WEIGHTS[b.type] ?? 0;
      if (weightB !== weightA) return weightB - weightA;
      // More recent first — created is ISO string, lexicographic sort works
      return b.created.localeCompare(a.created);
    });

    return filtered.slice(0, maxNotes);
  }

  /**
   * Filter configured tiers by the context window available.
   * Only tiers whose minimum context requirement is met are eligible.
   */
  getEligibleTiers(): number[] {
    const contextWindow = this.config.digest.intelligence.context_window;
    return this.config.digest.tiers.filter((tier) => {
      const minContext = DIGEST_TIER_MIN_CONTEXT[tier];
      return minContext !== undefined && minContext <= contextWindow;
    });
  }

  /**
   * Format notes compactly for inclusion in the digest prompt.
   * Stops adding notes once the token budget is exceeded.
   */
  formatSubstrate(notes: IndexedNote[], tokenBudget: number): string {
    const charBudget = tokenBudget * CHARS_PER_TOKEN;
    const parts: string[] = [];
    let usedChars = 0;

    for (const note of notes) {
      const entry = `### [${note.type}] ${note.id} — "${note.title}"\n${note.content}`;
      if (usedChars + entry.length > charBudget && parts.length > 0) break;
      parts.push(entry);
      usedChars += entry.length;
    }

    return parts.join('\n\n');
  }

  /**
   * Read a previously generated extract for a given tier.
   * Returns the body (stripped of YAML frontmatter), or null if not found.
   */
  readPreviousExtract(tier: number): string | null {
    const extractPath = path.join(this.vaultDir, 'digest', `extract-${tier}.md`);
    let content: string;
    try {
      content = fs.readFileSync(extractPath, 'utf-8');
    } catch {
      return null;
    }

    // Strip YAML frontmatter
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
    if (fmMatch) {
      return content.slice(fmMatch[0].length).trim();
    }
    return content.trim();
  }

  /**
   * Write a digest extract to the vault with YAML frontmatter.
   * Uses atomic write pattern (temp file + rename).
   */
  writeExtract(
    tier: number,
    body: string,
    cycleId: string,
    model: string,
    substrateCount: number,
  ): void {
    const digestDir = path.join(this.vaultDir, 'digest');
    fs.mkdirSync(digestDir, { recursive: true });

    const frontmatter: Record<string, unknown> = {
      type: EXTRACT_TYPE,
      tier,
      generated: new Date().toISOString(),
      cycle_id: cycleId,
      substrate_count: substrateCount,
      model,
    };

    const fmYaml = YAML.stringify(frontmatter, {
      defaultStringType: 'QUOTE_DOUBLE',
      defaultKeyType: 'PLAIN',
    }).trim();
    const file = `---\n${fmYaml}\n---\n\n${body}\n`;

    const fullPath = path.join(digestDir, `extract-${tier}.md`);
    const tmpPath = `${fullPath}.tmp`;
    fs.writeFileSync(tmpPath, file, 'utf-8');
    fs.renameSync(tmpPath, fullPath);
  }

  /**
   * Append a digest cycle result as a JSON line to trace.jsonl.
   */
  appendTrace(record: DigestCycleResult): void {
    const digestDir = path.join(this.vaultDir, 'digest');
    fs.mkdirSync(digestDir, { recursive: true });
    const tracePath = path.join(digestDir, 'trace.jsonl');
    fs.appendFileSync(tracePath, JSON.stringify(record) + '\n', 'utf-8');
    this.lastCycleTimestampCache = record.timestamp;
  }

  /**
   * Read the last cycle timestamp from trace.jsonl.
   * Cached in memory after first read — subsequent calls are O(1).
   */
  getLastCycleTimestamp(): string | null {
    if (this.lastCycleTimestampCache !== undefined) return this.lastCycleTimestampCache;

    const tracePath = path.join(this.vaultDir, 'digest', 'trace.jsonl');
    let content: string;
    try {
      content = fs.readFileSync(tracePath, 'utf-8').trim();
    } catch {
      this.lastCycleTimestampCache = null;
      return null;
    }

    if (!content) {
      this.lastCycleTimestampCache = null;
      return null;
    }

    const lines = content.split('\n');
    const lastLine = lines[lines.length - 1];
    try {
      const record = JSON.parse(lastLine) as DigestCycleResult;
      this.lastCycleTimestampCache = record.timestamp;
      return record.timestamp;
    } catch {
      this.lastCycleTimestampCache = null;
      return null;
    }
  }

  /**
   * Run a full digest cycle: discover substrate, generate extracts for each tier.
   * Returns the cycle result, or null if no substrate was found.
   */
  async runCycle(): Promise<DigestCycleResult | null> {
    const startTime = Date.now();
    const lastTimestamp = this.getLastCycleTimestamp();
    const substrate = this.discoverSubstrate(lastTimestamp);

    this.log('debug', 'Discovering substrate', { lastTimestamp: lastTimestamp ?? 'cold start', substrateCount: substrate.length });
    if (substrate.length === 0) {
      this.log('debug', 'No substrate found — skipping cycle');
      return null;
    }

    this.log('info', `Starting digest cycle`, { substrateCount: substrate.length });
    const cycleId = crypto.randomUUID();
    const eligibleTiers = this.getEligibleTiers();
    this.log('debug', `Eligible tiers: [${eligibleTiers.join(', ')}]`);
    const tiersGenerated: number[] = [];
    let totalTokensUsed = 0;
    let model = '';

    // Categorize substrate by type for the result
    const typeToKey: Record<string, keyof DigestCycleResult['substrate']> = {
      session: 'sessions',
      spore: 'spores',
      plan: 'plans',
      artifact: 'artifacts',
      'team-member': 'team',
    };
    const substrateIndex: DigestCycleResult['substrate'] = {
      sessions: [],
      spores: [],
      plans: [],
      artifacts: [],
      team: [],
    };
    for (const note of substrate) {
      const key = typeToKey[note.type];
      if (key) {
        substrateIndex[key].push(note.id);
      }
    }

    const systemPrompt = loadPrompt('digest-system');

    for (const tier of eligibleTiers) {
      const tierPrompt = loadPrompt(`digest-${tier}`);
      const previousExtract = this.readPreviousExtract(tier);

      // Calculate token budget for substrate:
      // context_window - output_tokens - system_prompt - tier_prompt - previous_extract
      const contextWindow = this.config.digest.intelligence.context_window;
      const systemTokens = DIGEST_SYSTEM_PROMPT_TOKENS;
      const tierPromptTokens = Math.ceil(tierPrompt.length / CHARS_PER_TOKEN);
      const previousExtractTokens = previousExtract
        ? Math.ceil(previousExtract.length / CHARS_PER_TOKEN) + PREVIOUS_EXTRACT_OVERHEAD_TOKENS
        : 0;
      const availableTokens = Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN);
      const substrateBudget = availableTokens - tier - systemTokens - tierPromptTokens - previousExtractTokens;

      if (substrateBudget <= 0) continue;

      const formattedSubstrate = this.formatSubstrate(substrate, substrateBudget);

      // Build user prompt (system prompt sent separately via LlmRequestOptions)
      const promptParts = [tierPrompt];

      if (previousExtract) {
        promptParts.push('', '## Previous Synthesis', '', previousExtract);
      }

      promptParts.push('', '## New Substrate', '', formattedSubstrate);
      promptParts.push(
        '',
        '---',
        'Produce your updated synthesis now. Stay within the token budget specified above.',
      );

      const userPrompt = promptParts.join('\n');
      const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / CHARS_PER_TOKEN);
      this.log('debug', `Tier ${tier}: sending LLM request`, { promptTokens, maxTokens: tier, substrateBudget });

      const tierStart = Date.now();
      const opts: LlmRequestOptions = {
        maxTokens: tier,
        timeoutMs: DIGEST_LLM_REQUEST_TIMEOUT_MS,
        contextLength: contextWindow,
        reasoning: 'off',
        systemPrompt,
      };
      const response = await this.llm.summarize(userPrompt, opts);
      const tierDuration = Date.now() - tierStart;

      // Strip reasoning tokens if present (some models output chain-of-thought)
      const extractText = stripReasoningTokens(response.text);
      model = response.model;
      const responseTokens = Math.ceil(extractText.length / CHARS_PER_TOKEN);
      totalTokensUsed += promptTokens + Math.ceil(extractText.length / CHARS_PER_TOKEN);

      this.log('info', `Tier ${tier}: completed`, { durationMs: tierDuration, responseTokens, model: response.model });
      this.writeExtract(tier, extractText, cycleId, response.model, substrate.length);
      tiersGenerated.push(tier);
    }

    const result: DigestCycleResult = {
      cycleId,
      timestamp: new Date().toISOString(),
      substrate: substrateIndex,
      tiersGenerated,
      model,
      durationMs: Date.now() - startTime,
      tokensUsed: totalTokensUsed,
    };

    this.appendTrace(result);
    return result;
  }
}

// --- Metabolism (Adaptive Timer) ---

export type MetabolismState = 'active' | 'cooling' | 'dormant';

/** Milliseconds per second for config conversion. */
const MS_PER_SECOND = 1000;

export class Metabolism {
  state: MetabolismState = 'active';
  currentIntervalMs: number;

  private cooldownStep = 0;
  private lastSubstrateTime: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeIntervalMs: number;
  private cooldownIntervalsMs: number[];
  private dormancyThresholdMs: number;

  constructor(config: MycoConfig['digest']['metabolism']) {
    this.activeIntervalMs = config.active_interval * MS_PER_SECOND;
    this.cooldownIntervalsMs = config.cooldown_intervals.map((s) => s * MS_PER_SECOND);
    this.dormancyThresholdMs = config.dormancy_threshold * MS_PER_SECOND;
    this.currentIntervalMs = this.activeIntervalMs;
    this.lastSubstrateTime = Date.now();
  }

  /** Reset to active state when new substrate is found. */
  onSubstrateFound(): void {
    this.state = 'active';
    this.cooldownStep = 0;
    this.currentIntervalMs = this.activeIntervalMs;
    this.lastSubstrateTime = Date.now();
  }

  /** Advance cooldown when a cycle finds no new substrate. */
  onEmptyCycle(): void {
    if (this.state === 'dormant') return;

    this.state = 'cooling';
    if (this.cooldownStep < this.cooldownIntervalsMs.length) {
      this.currentIntervalMs = this.cooldownIntervalsMs[this.cooldownStep];
      this.cooldownStep++;
    }

    this.checkDormancy();
  }

  /** Enter dormant state if enough time has elapsed since last substrate. */
  checkDormancy(): void {
    const elapsed = Date.now() - this.lastSubstrateTime;
    if (elapsed >= this.dormancyThresholdMs) {
      this.state = 'dormant';
      // Keep the last cooldown interval as the dormant polling rate
    }
  }

  /** Return to active from any state, resetting timers. */
  activate(): void {
    this.onSubstrateFound();
  }

  /** Set lastSubstrateTime explicitly (for testing). */
  markLastSubstrate(time: number): void {
    this.lastSubstrateTime = time;
  }

  /** Begin scheduling digest cycles with adaptive intervals. */
  start(callback: () => Promise<void>): void {
    this.stop();
    const schedule = (): void => {
      this.timer = setTimeout(async () => {
        await callback();
        schedule();
      }, this.currentIntervalMs);
      this.timer.unref();
    };
    schedule();
  }

  /** Stop the timer. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
