import { z } from 'zod';
import type { LlmProvider } from '../intelligence/llm.js';
import { ARTIFACT_TYPES } from '../vault/types.js';
import { estimateTokens, CHARS_PER_TOKEN, PROMPT_PREVIEW_CHARS, AI_RESPONSE_PREVIEW_CHARS, COMMAND_PREVIEW_CHARS, LLM_REASONING_MODE } from '../constants.js';
import type { MycoConfig } from '../config/schema.js';
import type { ObservationType, ArtifactType } from '../vault/types.js';
import { buildExtractionPrompt, buildSummaryPrompt, buildTitlePrompt, buildClassificationPrompt } from '../prompts/index.js';
import { extractJson, stripReasoningTokens } from '../intelligence/response.js';

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

  async process(
    events: Array<Record<string, unknown>>,
    sessionId: string,
  ): Promise<ProcessorResult> {
    const rawPrompt = this.buildPromptForExtraction(events, sessionId);
    const prompt = this.truncateForContext(rawPrompt, this.extractionMaxTokens);

    try {
      const response = await this.backend.summarize(prompt, { maxTokens: this.extractionMaxTokens, reasoning: LLM_REASONING_MODE });
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
        summary: `LLM processing failed for session ${sessionId}. ${events.length} events captured. Error: ${(error as Error).message}`,
        observations: [],
        degraded: true,
      };
    }
  }

  private buildPromptForExtraction(
    events: Array<Record<string, unknown>>,
    sessionId: string,
  ): string {
    const toolSummary = this.summarizeEvents(events);
    return buildExtractionPrompt(sessionId, events.length, toolSummary, this.extractionMaxTokens);
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
      summaryText = `Session ${sessionId} — summarization failed: ${(error as Error).message}`;
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

  private summarizeEvents(events: Array<Record<string, unknown>>): string {
    const toolCounts = new Map<string, number>();
    const filesAccessed = new Set<string>();
    const prompts: string[] = [];
    const aiResponses: string[] = [];

    for (const event of events) {
      if (event.type === 'user_prompt') {
        const prompt = String(event.prompt ?? '');
        if (prompt) prompts.push(prompt.slice(0, PROMPT_PREVIEW_CHARS));
        continue;
      }

      if (event.type === 'ai_response') {
        const content = String(event.content ?? '');
        if (content) aiResponses.push(content.slice(0, AI_RESPONSE_PREVIEW_CHARS));
        continue;
      }

      // Hooks send tool_name/tool_input; also support legacy tool/input
      const tool = String(event.tool_name ?? event.tool ?? 'unknown');
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);

      const input = (event.tool_input ?? event.input) as Record<string, unknown> | undefined;
      if (input?.path) filesAccessed.add(String(input.path));
      if (input?.file_path) filesAccessed.add(String(input.file_path));
      if (input?.command) filesAccessed.add(`[cmd] ${String(input.command).slice(0, COMMAND_PREVIEW_CHARS)}`);
    }

    const lines: string[] = [];

    if (prompts.length > 0) {
      lines.push('### User Prompts');
      for (const p of prompts) {
        lines.push(`- "${p}"`);
      }
    }

    lines.push('\n### Tool Usage');
    for (const [tool, count] of toolCounts) {
      lines.push(`- ${tool}: ${count} calls`);
    }

    if (filesAccessed.size > 0) {
      lines.push('\n### Files Accessed');
      for (const file of filesAccessed) {
        lines.push(`- ${file}`);
      }
    }

    if (aiResponses.length > 0) {
      lines.push('\n### AI Responses');
      for (const r of aiResponses) {
        lines.push(`- "${r}"`);
      }
    }

    return lines.join('\n');
  }
}
