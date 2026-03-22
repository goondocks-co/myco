import { z } from 'zod';
import type { LlmProvider } from '../intelligence/llm.js';
import { ARTIFACT_TYPES } from '../vault/types.js';
import { estimateTokens, CHARS_PER_TOKEN, LLM_REASONING_MODE } from '../constants.js';
import type { MycoConfig } from '../config/schema.js';
import type { ObservationType, ArtifactType } from '../vault/types.js';
import { buildExtractionPrompt, buildSummaryPrompt, buildTitlePrompt, buildClassificationPrompt } from '../prompts/index.js';
import { extractJson, stripReasoningTokens } from '../intelligence/response.js';
import { TURN_HEADING_PREFIX } from '../obsidian/formatter.js';

/** Estimated token overhead for the extraction prompt template (excluding conversation content). */
const EXTRACTION_PROMPT_OVERHEAD_TOKENS = 500;

/** Marker substring in failed summary text. Used by reprocess --failed to detect failures. */
export const SUMMARIZATION_FAILED_MARKER = 'summarization failed';

export interface Observation {
  type: ObservationType;
  title: string;
  content: string;
  tags: string[];
  root_cause?: string;
  fix?: string;
  rationale?: string;
  alternatives_rejected?: string;
  gained?: string;
  sacrificed?: string;
}

export interface ProcessorResult {
  summary: string;
  observations: Observation[];
  degraded: boolean;
}

export interface ClassifiedArtifact {
  source_path: string;
  artifact_type: ArtifactType;
  title: string;
  tags: string[];
}

const ClassificationResponseSchema = z.object({
  artifacts: z.array(z.object({
    source_path: z.string(),
    artifact_type: z.enum(ARTIFACT_TYPES),
    title: z.string(),
    tags: z.array(z.string()).default([]),
  })).default([]),
});

export class BufferProcessor {
  private extractionMaxTokens: number;
  private summaryMaxTokens: number;
  private titleMaxTokens: number;
  private classificationMaxTokens: number;

  constructor(private backend: LlmProvider, private contextWindow: number = 8192, captureConfig?: MycoConfig['capture']) {
    this.extractionMaxTokens = captureConfig?.extraction_max_tokens ?? 2048;
    this.summaryMaxTokens = captureConfig?.summary_max_tokens ?? 512;
    this.titleMaxTokens = captureConfig?.title_max_tokens ?? 32;
    this.classificationMaxTokens = captureConfig?.classification_max_tokens ?? 1024;
  }

  private truncateForContext(data: string, maxTokens: number): string {
    const available = this.contextWindow - maxTokens;
    const dataTokens = estimateTokens(data);
    if (dataTokens <= available) return data;
    const charBudget = available * CHARS_PER_TOKEN;
    return data.slice(0, charBudget);
  }

  async process(conversationMarkdown: string, sessionId: string): Promise<ProcessorResult> {
    if (!conversationMarkdown.trim()) {
      return { summary: '', observations: [], degraded: false };
    }

    // Truncate from the beginning (keep recent turns) if conversation exceeds budget
    const availableTokens = this.contextWindow - EXTRACTION_PROMPT_OVERHEAD_TOKENS - this.extractionMaxTokens;
    const availableChars = availableTokens * CHARS_PER_TOKEN;
    let truncated = conversationMarkdown;
    if (conversationMarkdown.length > availableChars) {
      truncated = conversationMarkdown.slice(-availableChars);
      // Find first turn boundary to avoid cutting mid-turn
      const turnBoundary = truncated.indexOf(TURN_HEADING_PREFIX);
      if (turnBoundary > 0) {
        truncated = truncated.slice(turnBoundary);
      }
    }

    const prompt = buildExtractionPrompt(sessionId, truncated, this.extractionMaxTokens);

    try {
      const response = await this.backend.summarize(prompt, {
        maxTokens: this.extractionMaxTokens,
        reasoning: LLM_REASONING_MODE,
      });
      const parsed = extractJson(response.text) as {
        summary: string;
        observations: Observation[];
      };
      return {
        summary: parsed.summary,
        observations: parsed.observations ?? [],
        degraded: false,
      };
    } catch (error) {
      return {
        summary: `LLM processing failed for session ${sessionId}. Error: ${(error as Error).message}`,
        observations: [],
        degraded: true,
      };
    }
  }

  async summarizeSession(
    conversationMarkdown: string,
    sessionId: string,
    user?: string,
  ): Promise<{ summary: string; title: string }> {
    const truncatedContent = this.truncateForContext(conversationMarkdown, this.summaryMaxTokens);
    const summaryPrompt = buildSummaryPrompt(sessionId, user ?? 'unknown', truncatedContent, this.summaryMaxTokens);

    let summaryText: string;
    try {
      const response = await this.backend.summarize(summaryPrompt, { maxTokens: this.summaryMaxTokens, reasoning: LLM_REASONING_MODE });
      summaryText = stripReasoningTokens(response.text);
    } catch (error) {
      summaryText = `Session ${sessionId} — ${SUMMARIZATION_FAILED_MARKER}: ${(error as Error).message}`;
    }

    const titlePrompt = buildTitlePrompt(summaryText, sessionId);
    let title: string;
    try {
      const response = await this.backend.summarize(titlePrompt, { maxTokens: this.titleMaxTokens, reasoning: LLM_REASONING_MODE });
      title = stripReasoningTokens(response.text).trim();
    } catch {
      title = `Session ${sessionId}`;
    }

    return { summary: summaryText, title };
  }

  async classifyArtifacts(
    candidates: Array<{ path: string; content: string }>,
    sessionId: string,
  ): Promise<ClassifiedArtifact[]> {
    if (candidates.length === 0) return [];

    const prompt = this.buildPromptForClassification(candidates, sessionId);
    const response = await this.backend.summarize(prompt, { maxTokens: this.classificationMaxTokens, reasoning: LLM_REASONING_MODE });
    const raw = extractJson(response.text);
    const parsed = ClassificationResponseSchema.parse(raw);
    return parsed.artifacts;
  }

  private buildPromptForClassification(
    candidates: Array<{ path: string; content: string }>,
    sessionId: string,
  ): string {
    return buildClassificationPrompt(sessionId, candidates, this.classificationMaxTokens);
  }

}
