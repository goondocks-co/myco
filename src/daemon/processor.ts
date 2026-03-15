import type { LlmBackend } from '../intelligence/llm.js';
import type { ObservationType } from '../vault/types.js';

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
  artifact_type: 'spec' | 'plan' | 'rfc' | 'doc' | 'other';
  title: string;
  tags: string[];
}

const SUMMARY_TASK = `Write a concise narrative summary of this session (3-6 sentences). Describe what was accomplished, key decisions made, and any problems encountered. Focus on outcomes rather than individual tool calls.

Respond with plain text only, no JSON or markdown fences.`;

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
      "type": "gotcha|bug_fix|decision|discovery|trade_off",
      "title": "Short descriptive title",
      "content": "Detailed explanation of the observation.",
      "tags": ["relevant", "tags"]
    }
  ]
}

## Type-Specific Fields
Include these additional fields when appropriate for the observation type:

- **bug_fix**: add "root_cause" (what caused the bug) and "fix" (what resolved it)
- **decision**: add "rationale" (why this choice) and "alternatives_rejected" (what was considered and why not)
- **trade_off**: add "gained" (what was achieved) and "sacrificed" (what was given up)

These fields are optional — only include them when the session provides clear evidence.

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

  async summarizeSession(
    conversationMarkdown: string,
    sessionId: string,
    user?: string,
  ): Promise<{ summary: string; title: string }> {
    const summaryPrompt = `You are summarizing a coding session for user "${user ?? 'unknown'}" (session "${sessionId}").

## Session Content
${conversationMarkdown.slice(0, 8000)}

## Task
${SUMMARY_TASK}`;

    let summaryText: string;
    try {
      const response = await this.backend.summarize(summaryPrompt);
      summaryText = response.text;
    } catch (error) {
      summaryText = `Session ${sessionId} — summarization failed: ${(error as Error).message}`;
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

  async classifyArtifacts(
    candidates: Array<{ path: string; content: string }>,
    sessionId: string,
  ): Promise<ClassifiedArtifact[]> {
    if (candidates.length === 0) return [];

    const prompt = this.buildClassificationPrompt(candidates, sessionId);
    const response = await this.backend.summarize(prompt);
    const parsed = JSON.parse(response.text) as { artifacts: ClassifiedArtifact[] };
    return parsed.artifacts ?? [];
  }

  private buildTitlePrompt(summary: string, sessionId: string): string {
    return `Given this session summary, produce a short, descriptive title (5-10 words) suitable for a vault note heading.

Summary:
${summary}

Session ID: ${sessionId}

Respond with the title text only, no quotes, no punctuation at the end.`;
  }

  private buildClassificationPrompt(
    candidates: Array<{ path: string; content: string }>,
    sessionId: string,
  ): string {
    const fileList = candidates
      .map((c) => {
        const truncated = c.content.slice(0, 2000);
        return `### ${c.path}\n\`\`\`\n${truncated}\n\`\`\``;
      })
      .join('\n\n');

    return `You are classifying files from coding session "${sessionId}" to determine which are substantive artifacts worth preserving in a knowledge vault.

## Candidate Files

${fileList}

## Task

For each file that is a substantive artifact (design doc, specification, implementation plan, RFC, or documentation), classify it. Skip implementation code, test files, config files, and generated output.

Artifact types:
- "spec" — Design specifications, architecture documents
- "plan" — Implementation plans, roadmaps
- "rfc" — Requests for comment, proposals
- "doc" — Documentation, guides, READMEs
- "other" — Other substantive documents

Respond with valid JSON only, no markdown fences:
{
  "artifacts": [
    {
      "source_path": "exact/path/from/above",
      "artifact_type": "spec|plan|rfc|doc|other",
      "title": "Human-readable title",
      "tags": ["relevant", "tags"]
    }
  ]
}

If none of the candidates are artifacts, respond with: {"artifacts": []}`;
  }

  private summarizeEvents(events: Array<Record<string, unknown>>): string {
    const toolCounts = new Map<string, number>();
    const filesAccessed = new Set<string>();
    const prompts: string[] = [];
    const aiResponses: string[] = [];

    for (const event of events) {
      if (event.type === 'user_prompt') {
        const prompt = String(event.prompt ?? '');
        if (prompt) prompts.push(prompt.slice(0, 300));
        continue;
      }

      if (event.type === 'ai_response') {
        const content = String(event.content ?? '');
        if (content) aiResponses.push(content.slice(0, 500));
        continue;
      }

      // Hooks send tool_name/tool_input; also support legacy tool/input
      const tool = String(event.tool_name ?? event.tool ?? 'unknown');
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);

      const input = (event.tool_input ?? event.input) as Record<string, unknown> | undefined;
      if (input?.path) filesAccessed.add(String(input.path));
      if (input?.file_path) filesAccessed.add(String(input.file_path));
      if (input?.command) filesAccessed.add(`[cmd] ${String(input.command).slice(0, 80)}`);
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
