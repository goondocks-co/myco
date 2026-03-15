import type { LlmBackend } from '../intelligence/llm.js';

export interface Observation {
  type: 'gotcha' | 'bug_fix' | 'decision' | 'discovery' | 'trade_off';
  title: string;
  content: string;
  tags: string[];
}

export interface ProcessorResult {
  summary: string;
  observations: Observation[];
  degraded: boolean;
}

export class BufferProcessor {
  constructor(private backend: LlmBackend) {}

  async process(
    events: Array<Record<string, unknown>>,
    sessionId: string,
  ): Promise<ProcessorResult> {
    const prompt = this.buildExtractionPrompt(events, sessionId);

    try {
      const response = await this.backend.summarize(prompt);
      const parsed = JSON.parse(response.text) as {
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

  async summarize(
    events: Array<Record<string, unknown>>,
    sessionId: string,
    user?: string,
  ): Promise<{ summary: string; title: string }> {
    const summaryPrompt = this.buildSummaryPrompt(events, sessionId, user ?? 'unknown');

    let summaryText: string;
    try {
      const response = await this.backend.summarize(summaryPrompt);
      summaryText = response.text;
    } catch (error) {
      summaryText = `Session ${sessionId} — ${events.length} events captured. LLM summarization failed: ${(error as Error).message}`;
    }

    const titlePrompt = this.buildTitlePrompt(summaryText, sessionId);
    let title: string;
    try {
      const response = await this.backend.summarize(titlePrompt);
      title = response.text.trim();
    } catch {
      title = `Session ${sessionId}`;
    }

    return { summary: summaryText, title };
  }

  private buildExtractionPrompt(
    events: Array<Record<string, unknown>>,
    sessionId: string,
  ): string {
    const toolSummary = this.summarizeEvents(events);

    return `You are analyzing a coding session buffer for session "${sessionId}".

## Events (${events.length} total)
${toolSummary}

## Task
Analyze these events and produce a JSON response with exactly this structure:
{
  "summary": "A concise narrative of what happened in this session (2-4 sentences).",
  "observations": [
    {
      "type": "gotcha|bug_fix|decision|discovery|trade_off",
      "title": "Short descriptive title",
      "content": "Detailed explanation of the observation.",
      "tags": ["relevant", "tags"]
    }
  ]
}

## Observation Guidelines
Only include observations that meet ALL criteria:
- Valuable to a teammate encountering the same code/problem
- Not obvious from reading the code itself
- Not specific to this session's transient state

Types:
- "gotcha": A non-obvious problem, pitfall, or workaround
- "bug_fix": Root cause of a bug and what fixed it
- "decision": An architectural or technical choice, with rationale and rejected alternatives
- "discovery": A significant learning about the codebase, tooling, or domain
- "trade_off": What was sacrificed and why

Routine activity (file reads, searches, test runs, navigation) goes in the summary only.
Target 0-5 observations. Err on fewer, higher-quality observations.

Respond with valid JSON only, no markdown fences.`;
  }

  private buildSummaryPrompt(
    events: Array<Record<string, unknown>>,
    sessionId: string,
    user: string,
  ): string {
    const toolSummary = this.summarizeEvents(events);

    return `You are summarizing a complete coding session for user "${user}" (session "${sessionId}").

## Events (${events.length} total)
${toolSummary}

## Task
Write a concise narrative summary of this session (3-6 sentences). Describe what was accomplished, key decisions made, and any problems encountered. Focus on outcomes rather than individual tool calls.

Respond with plain text only, no JSON or markdown fences.`;
  }

  private buildTitlePrompt(summary: string, sessionId: string): string {
    return `Given this session summary, produce a short, descriptive title (5-10 words) suitable for a vault note heading.

Summary:
${summary}

Session ID: ${sessionId}

Respond with the title text only, no quotes, no punctuation at the end.`;
  }

  private summarizeEvents(events: Array<Record<string, unknown>>): string {
    const toolCounts = new Map<string, number>();
    const filesAccessed = new Set<string>();

    for (const event of events) {
      const tool = String(event.tool ?? 'unknown');
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);

      const input = event.input as Record<string, unknown> | undefined;
      if (input?.path) filesAccessed.add(String(input.path));
      if (input?.file_path) filesAccessed.add(String(input.file_path));
    }

    const lines: string[] = [];
    lines.push('### Tool Usage');
    for (const [tool, count] of toolCounts) {
      lines.push(`- ${tool}: ${count} calls`);
    }

    if (filesAccessed.size > 0) {
      lines.push('\n### Files Accessed');
      for (const file of filesAccessed) {
        lines.push(`- ${file}`);
      }
    }

    return lines.join('\n');
  }
}
