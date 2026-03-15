import type { LlmBackend } from '../intelligence/llm.js';

export interface Observation {
  type: 'decision' | 'gotcha' | 'discovery' | 'cross-cutting';
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
      "type": "decision|gotcha|discovery|cross-cutting",
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
- "decision": An architectural or technical choice, with rationale and rejected alternatives
- "gotcha": A non-obvious problem, pitfall, or workaround
- "discovery": A significant learning about the codebase, tooling, or domain
- "cross-cutting": Something affecting multiple parts of the system

Routine activity (file reads, searches, test runs, navigation) goes in the summary only.
Target 0-5 observations. Err on fewer, higher-quality observations.

Respond with valid JSON only, no markdown fences.`;
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
