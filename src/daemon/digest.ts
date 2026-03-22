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
import { stripFrontmatter } from '@myco/vault/frontmatter.js';
import { readLastTimestamp, appendTraceRecord } from './trace.js';
import {
  estimateTokens,
  CHARS_PER_TOKEN,
  DIGEST_TIERS,
  DIGEST_TIER_MIN_CONTEXT,
  DIGEST_SUBSTRATE_TYPE_WEIGHTS,
  DIGEST_LLM_REQUEST_TIMEOUT_MS,
  LLM_REASONING_MODE,
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

export interface DigestCycleOptions {
  /** Process all substrate regardless of last cycle timestamp. */
  fullReprocess?: boolean;
  /** Only generate these tiers (default: all eligible). */
  tiers?: number[];
  /** Skip previous extract — start from clean slate. */
  cleanSlate?: boolean;
}

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

/** Safety margin for context window — our CHARS_PER_TOKEN=4 heuristic significantly
 *  underestimates real token counts (observed ~3.2 chars/token for mixed content).
 *  0.70 provides a safe buffer: 32K * 0.70 = 22.4K usable tokens. */
const CONTEXT_SAFETY_MARGIN = 0.70;

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
  private cycleInProgress = false;

  /** Whether a digest cycle is currently running. */
  get isCycleInProgress(): boolean {
    return this.cycleInProgress;
  }

  /** Hooks that run before each digest cycle (e.g., consolidation). */
  private prePassHooks: Array<{ name: string; fn: () => Promise<void> }> = [];

  /** Hooks that run after each successful digest cycle. */
  private postPassHooks: Array<{ name: string; fn: (result: DigestCycleResult) => Promise<void> }> = [];

  constructor(engineConfig: DigestEngineConfig) {
    this.vaultDir = engineConfig.vaultDir;
    this.index = engineConfig.index;
    this.llm = engineConfig.llmProvider;
    this.config = engineConfig.config;
    this.log = engineConfig.log ?? (() => {});
  }

  /** Register a hook that runs before each digest cycle. Best-effort — errors are logged, not thrown. */
  registerPrePass(name: string, fn: () => Promise<void>): void {
    this.prePassHooks.push({ name, fn });
  }

  /** Register a hook that runs after each successful digest cycle. Best-effort — errors are logged, not thrown. */
  registerPostPass(name: string, fn: (result: DigestCycleResult) => Promise<void>): void {
    this.postPassHooks.push({ name, fn });
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

    // Guard against self-digestion: extract files are not currently indexed,
    // but this filter prevents feedback loops if they ever are (e.g., via rebuild)
    const filtered = notes
      .filter((n) => n.type !== EXTRACT_TYPE)
      .filter((n) => {
        if (n.type !== 'spore') return true;
        const status = n.frontmatter.status as string | undefined;
        return !status || status === 'active';
      });

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
    return DIGEST_TIERS.filter((tier) => {
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

    return stripFrontmatter(content).body;
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
    substrateNotes?: string[],
    tokensUsed?: number,
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
    if (substrateNotes && substrateNotes.length > 0) frontmatter.substrate_notes = substrateNotes;
    if (tokensUsed !== undefined) frontmatter.tokens_used = tokensUsed;

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
    const tracePath = path.join(this.vaultDir, 'digest', 'trace.jsonl');
    appendTraceRecord(tracePath, record as unknown as Record<string, unknown>);
    this.lastCycleTimestampCache = record.timestamp;
  }

  /**
   * Read the last cycle timestamp from trace.jsonl.
   * Cached in memory after first read — subsequent calls are O(1).
   */
  getLastCycleTimestamp(): string | null {
    if (this.lastCycleTimestampCache !== undefined) return this.lastCycleTimestampCache;

    const tracePath = path.join(this.vaultDir, 'digest', 'trace.jsonl');
    this.lastCycleTimestampCache = readLastTimestamp(tracePath);
    return this.lastCycleTimestampCache;
  }

  /**
   * Run a full digest cycle: discover substrate, generate extracts for each tier.
   * Returns the cycle result, or null if no substrate was found.
   */
  async runCycle(opts?: DigestCycleOptions): Promise<DigestCycleResult | null> {
    if (this.cycleInProgress) {
      this.log('debug', 'Cycle already in progress — skipping');
      return null;
    }
    this.cycleInProgress = true;

    try {
      // Ensure model is loaded BEFORE pre-pass hooks (e.g., consolidation).
      // Pre-pass hooks share the digest LLM provider — without ensureLoaded first,
      // requests go with just the model name (no instance ID), causing LM Studio
      // to spawn duplicate instances for each concurrent request.
      if (this.llm.ensureLoaded) {
        const { context_window: contextWindow, gpu_kv_cache: gpuKvCache } = this.config.digest.intelligence;
        this.log('debug', 'Verifying digest model', { contextWindow, gpuKvCache });
        await this.llm.ensureLoaded(contextWindow, gpuKvCache);
      }

      // Run pre-pass hooks (e.g., consolidation) before discovering substrate
      for (const hook of this.prePassHooks) {
        try {
          await hook.fn();
        } catch (err) {
          this.log('warn', `Pre-pass hook "${hook.name}" failed`, { error: (err as Error).message });
        }
      }

      return await this.runCycleInternal(opts);
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async runCycleInternal(opts?: DigestCycleOptions): Promise<DigestCycleResult | null> {

    const startTime = Date.now();
    const fullReprocess = opts?.fullReprocess ?? false;
    const lastTimestamp = fullReprocess ? null : this.getLastCycleTimestamp();
    const substrate = this.discoverSubstrate(lastTimestamp);

    this.log('debug', 'Discovering substrate', { lastTimestamp: lastTimestamp ?? 'full reprocess', substrateCount: substrate.length });
    if (substrate.length === 0) {
      this.log('debug', 'No substrate found — skipping cycle');
      return null;
    }

    this.log('info', `Starting digest cycle`, { substrateCount: substrate.length, fullReprocess });
    const cycleId = crypto.randomUUID();
    const allEligible = this.getEligibleTiers();
    const eligibleTiers = opts?.tiers
      ? allEligible.filter((t) => opts.tiers!.includes(t))
      : allEligible;
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

    // Record the cycle timestamp NOW, before tier processing. This ensures the
    // timestamp advances even if LLM calls fail, preventing the same substrate
    // from being rediscovered on every subsequent timer fire.
    const cycleTimestamp = new Date().toISOString();

    const systemPrompt = loadPrompt('digest-system');
    const allSubstrateIds = substrate.map((note) => note.id);

    for (const tier of eligibleTiers) {
      const tierPrompt = loadPrompt(`digest-${tier}`);
      const previousExtract = opts?.cleanSlate ? null : this.readPreviousExtract(tier);

      // Calculate token budget for substrate:
      // (context_window * safety_margin) - output - system_prompt - tier_prompt - previous_extract
      const contextWindow = this.config.digest.intelligence.context_window;
      const systemPromptTokens = estimateTokens(systemPrompt);
      const tierPromptTokens = estimateTokens(tierPrompt);
      const previousExtractTokens = previousExtract
        ? estimateTokens(previousExtract) + PREVIOUS_EXTRACT_OVERHEAD_TOKENS
        : 0;
      const availableTokens = Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN);
      const substrateBudget = availableTokens - tier - systemPromptTokens - tierPromptTokens - previousExtractTokens;

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
      const promptTokens = estimateTokens(systemPrompt + userPrompt);
      this.log('debug', `Tier ${tier}: sending LLM request`, { promptTokens, maxTokens: tier, substrateBudget });

      try {
        const tierStart = Date.now();
        const digestConfig = this.config.digest.intelligence;
        const opts: LlmRequestOptions = {
          maxTokens: tier,
          timeoutMs: DIGEST_LLM_REQUEST_TIMEOUT_MS,
          contextLength: contextWindow,
          reasoning: LLM_REASONING_MODE,
          systemPrompt,
          keepAlive: digestConfig.keep_alive ?? undefined,
        };
        const response = await this.llm.summarize(userPrompt, opts);
        const tierDuration = Date.now() - tierStart;

        // Strip reasoning tokens if present (some models output chain-of-thought)
        const extractText = stripReasoningTokens(response.text);
        model = response.model;
        const responseTokens = estimateTokens(extractText);
        totalTokensUsed += promptTokens + responseTokens;

        this.log('info', `Tier ${tier}: completed`, { durationMs: tierDuration, responseTokens, model: response.model });
        this.writeExtract(tier, extractText, cycleId, response.model, substrate.length, allSubstrateIds, promptTokens + responseTokens);
        tiersGenerated.push(tier);
      } catch (err) {
        this.log('warn', `Tier ${tier}: failed`, { error: (err as Error).message });
      }
    }

    // Patch tiers_generated into each extract's frontmatter (not known until all tiers complete)
    if (tiersGenerated.length > 0) {
      const digestDir = path.join(this.vaultDir, 'digest');
      for (const tier of tiersGenerated) {
        const extractPath = path.join(digestDir, `extract-${tier}.md`);
        try {
          const content = fs.readFileSync(extractPath, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
            parsed.tiers_generated = tiersGenerated;
            const fmYaml = YAML.stringify(parsed, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trim();
            const extractBody = content.slice(fmMatch[0].length);
            const tmpPath = `${extractPath}.tmp`;
            fs.writeFileSync(tmpPath, `---\n${fmYaml}\n---${extractBody}`, 'utf-8');
            fs.renameSync(tmpPath, extractPath);
          }
        } catch {
          // Extract file may not exist if that tier failed
        }
      }
    }

    const result: DigestCycleResult = {
      cycleId,
      timestamp: cycleTimestamp,
      substrate: substrateIndex,
      tiersGenerated,
      model,
      durationMs: Date.now() - startTime,
      tokensUsed: totalTokensUsed,
    };

    this.appendTrace(result);

    // Run post-pass hooks after successful digest
    for (const hook of this.postPassHooks) {
      try {
        await hook.fn(result);
      } catch (err) {
        this.log('warn', `Post-pass hook "${hook.name}" failed`, { error: (err as Error).message });
      }
    }

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

  /** Return to active from any state, resetting timers and rescheduling immediately. */
  activate(): void {
    this.onSubstrateFound();
    // Reschedule with the new active interval — without this, the old
    // (possibly dormant) timer continues ticking at the wrong rate
    if (this.callback) {
      this.reschedule();
    }
  }

  /** Set lastSubstrateTime explicitly (for testing). */
  markLastSubstrate(time: number): void {
    this.lastSubstrateTime = time;
  }

  /** Begin scheduling digest cycles with adaptive intervals. */
  start(callback: () => Promise<void>): void {
    this.callback = callback;
    this.reschedule();
  }

  /** Stop the timer. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private callback: (() => Promise<void>) | null = null;

  private reschedule(): void {
    this.stop();
    if (!this.callback) return;
    const cb = this.callback;
    const schedule = (): void => {
      this.timer = setTimeout(async () => {
        await cb();
        schedule();
      }, this.currentIntervalMs);
      this.timer.unref();
    };
    schedule();
  }
}
