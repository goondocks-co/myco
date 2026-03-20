/**
 * myco reprocess — re-run the observation extraction and summarization pipeline
 * for existing sessions. Useful after bugs or when the LLM backend changes.
 *
 * Reads transcripts (the source of truth), re-extracts observations, regenerates
 * summaries/titles, and re-indexes everything. Existing spore files from those
 * sessions are preserved — new observations are additive.
 *
 * Flags:
 *   --session <id>   Filter to sessions matching this substring
 *   --date <YYYY-MM-DD>  Filter to sessions from a specific date
 *   --failed         Only reprocess sessions with failed summaries
 *   --index-only     Skip all LLM calls (re-index only)
 */
import fs from 'node:fs';
import path from 'node:path';
import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { initFts } from '../index/fts.js';
import { indexNote } from '../index/rebuild.js';
import { loadConfig } from '../config/loader.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { batchExecute, LLM_BATCH_CONCURRENCY, EMBEDDING_BATCH_CONCURRENCY } from '../intelligence/batch.js';
import { BufferProcessor } from '../daemon/processor.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { VaultWriter } from '../vault/writer.js';
import { writeObservationNotes } from '../vault/observations.js';
import { createPerProjectAdapter } from '../agents/adapter.js';
import { claudeCodeAdapter } from '../agents/claude-code.js';
import { sessionNoteId, bareSessionId } from '../vault/session-id.js';
import { EMBEDDING_INPUT_LIMIT } from '../constants.js';
import { callout } from '../obsidian/formatter.js';
import { parseStringFlag } from './shared.js';
import matter from 'gray-matter';

/** Marker text that appears in summaries when summarization fails. */
const FAILED_SUMMARY_MARKER = 'summarization failed';

interface EmbedJob {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

interface SessionTask {
  relativePath: string;
  sessionId: string;
  bare: string;
  frontmatter: Record<string, unknown>;
  rawContent: string;
  conversationSection: string;
  batchEvents: Array<Record<string, unknown>> | null;
  turnCount: number;
  hasFailed: boolean;
}

/**
 * Extract the ## Conversation section from a session note body.
 * Returns everything from "## Conversation" to the next `#type/` footer tag line.
 */
function extractConversationSection(body: string): string {
  const marker = '## Conversation';
  const start = body.indexOf(marker);
  if (start === -1) return '';
  const section = body.slice(start + marker.length);
  // Strip trailing footer tags (lines starting with #type/)
  const footerIdx = section.lastIndexOf('\n#type/');
  if (footerIdx !== -1) return section.slice(0, footerIdx).trim();
  return section.trim();
}

/**
 * Replace the title (first `# ` line) and summary callout in a session note body.
 */
function updateTitleAndSummary(body: string, newTitle: string, newNarrative: string): string {
  // Replace the title line (first occurrence of `# ...`)
  let updated = body.replace(/^# .*/m, `# ${newTitle}`);

  // Replace the summary callout block: from `> [!abstract]` through consecutive `> ` lines
  const summaryCallout = callout('abstract', 'Summary', newNarrative);
  updated = updated.replace(/> \[!abstract\] Summary\n(?:> .*\n?)*/m, summaryCallout + '\n');

  return updated;
}

export async function run(args: string[], vaultDir: string): Promise<void> {
  const sessionFilter = parseStringFlag(args, '--session');
  const dateFilter = parseStringFlag(args, '--date');
  const failedOnly = args.includes('--failed');
  const skipLlm = args.includes('--index-only');

  const config = loadConfig(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  initFts(index);

  const llmProvider = skipLlm ? null : createLlmProvider(config.intelligence.llm);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);

  let vectorIndex: VectorIndex | null = null;
  try {
    const testEmbed = await embeddingProvider.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
  } catch (e) {
    console.log(`Vector index unavailable: ${(e as Error).message}`);
  }

  const processor = llmProvider
    ? new BufferProcessor(llmProvider, config.intelligence.llm.context_window, config.capture)
    : null;
  const writer = new VaultWriter(vaultDir);
  const miner = new TranscriptMiner({
    additionalAdapters: config.capture.transcript_paths.map((p: string) =>
      createPerProjectAdapter(p, claudeCodeAdapter.parseTurns),
    ),
  });

  // Find sessions to reprocess
  const sessionsDir = path.join(vaultDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions directory found.');
    index.close();
    vectorIndex?.close();
    return;
  }

  const sessionFiles: Array<{ relativePath: string; sessionId: string }> = [];
  for (const dateDir of fs.readdirSync(sessionsDir)) {
    if (dateFilter && dateDir !== dateFilter) continue;
    const datePath = path.join(sessionsDir, dateDir);
    if (!fs.statSync(datePath).isDirectory()) continue;
    for (const file of fs.readdirSync(datePath)) {
      if (!file.startsWith('session-') || !file.endsWith('.md')) continue;
      const sessionId = file.replace('session-', '').replace('.md', '');
      if (sessionFilter && !sessionId.includes(sessionFilter)) continue;
      sessionFiles.push({
        relativePath: path.join('sessions', dateDir, file),
        sessionId,
      });
    }
  }

  if (sessionFiles.length === 0) {
    const filters = [sessionFilter && `session="${sessionFilter}"`, dateFilter && `date="${dateFilter}"`].filter(Boolean);
    console.log(filters.length ? `No sessions matching ${filters.join(', ')} found.` : 'No sessions found.');
    index.close();
    vectorIndex?.close();
    return;
  }

  // Prepare tasks: read transcripts and session content, build extraction inputs
  let tasks: SessionTask[] = sessionFiles.map(({ relativePath, sessionId }) => {
    const rawContent = fs.readFileSync(path.join(vaultDir, relativePath), 'utf-8');
    const { data: frontmatter, content: body } = matter(rawContent);
    const bare = bareSessionId(sessionId);
    const turnsResult = miner.getAllTurnsWithSource(bare);
    const conversationSection = extractConversationSection(body);
    const hasFailed = body.includes(FAILED_SUMMARY_MARKER);

    const batchEvents = turnsResult && turnsResult.turns.length > 0
      ? turnsResult.turns.map((t) => ({
          type: 'turn' as const,
          prompt: t.prompt,
          tool_count: t.toolCount,
          response: t.aiResponse ?? '',
          timestamp: t.timestamp,
        }))
      : null;

    return { relativePath, sessionId, bare, frontmatter, rawContent, conversationSection, batchEvents, turnCount: turnsResult?.turns.length ?? 0, hasFailed };
  });

  // Apply --failed filter after reading content
  if (failedOnly) {
    const before = tasks.length;
    tasks = tasks.filter((t) => t.hasFailed);
    if (tasks.length === 0) {
      console.log(`No failed sessions found (checked ${before} sessions).`);
      index.close();
      vectorIndex?.close();
      return;
    }
    console.log(`Found ${tasks.length} failed session(s) out of ${before} checked.\n`);
  }

  console.log(`Reprocessing ${tasks.length} session(s)...\n`);

  // Phase 1: LLM extraction (concurrency-limited) + FTS re-indexing
  const embedJobs: EmbedJob[] = [];
  let totalObservations = 0;

  const extractionResult = await batchExecute(
    tasks,
    async (task) => {
      let obs = 0;
      process.stdout.write(`  ${task.sessionId.slice(0, 12)}... ${task.turnCount} turns`);

      if (processor && task.batchEvents) {
        const result = await processor.process(task.batchEvents, task.bare);
        if (result.observations.length > 0) {
          writeObservationNotes(result.observations, task.bare, writer, index, vaultDir);
          obs = result.observations.length;
          process.stdout.write(` → ${obs} observations`);

          for (const o of result.observations) {
            embedJobs.push({
              id: `${o.type}-${task.bare.slice(-6)}-${Date.now()}`,
              text: `${o.title}\n${o.content}`.slice(0, EMBEDDING_INPUT_LIMIT),
              metadata: { type: 'spore', session_id: task.bare },
            });
          }
        }
      }

      // FTS re-index (fast, no LLM)
      indexNote(index, vaultDir, task.relativePath);

      // Queue session embedding
      const embText = `${task.frontmatter.title ?? ''}\n${task.frontmatter.summary ?? ''}`.slice(0, EMBEDDING_INPUT_LIMIT);
      if (embText.trim()) {
        embedJobs.push({
          id: sessionNoteId(task.bare),
          text: embText,
          metadata: { type: 'session', session_id: task.bare },
        });
      }

      process.stdout.write('\n');
      return obs;
    },
    {
      concurrency: LLM_BATCH_CONCURRENCY,
      onProgress: (done, total) => {
        if (done === total) console.log(`\nExtraction complete: ${done} sessions processed.`);
      },
    },
  );

  for (const r of extractionResult.results) {
    if (r.status === 'fulfilled') totalObservations += r.value;
  }

  // Phase 2: Resummarize sessions (sequential — each needs an LLM call)
  let summarized = 0;
  if (processor) {
    console.log(`\nRegenerating summaries...`);

    for (const task of tasks) {
      if (!task.conversationSection) {
        process.stdout.write(`  ${task.sessionId.slice(0, 12)}... no conversation section, skipped\n`);
        continue;
      }

      process.stdout.write(`  ${task.sessionId.slice(0, 12)}...`);
      const user = typeof task.frontmatter.user === 'string' ? task.frontmatter.user : undefined;
      const result = await processor.summarizeSession(task.conversationSection, task.bare, user);

      // Check if summarization actually succeeded (not a fallback error message)
      if (result.summary.includes(FAILED_SUMMARY_MARKER)) {
        process.stdout.write(` summarization failed again, skipped\n`);
        continue;
      }

      // Update the session note in-place — replace body without re-serializing frontmatter
      // (matter.stringify corrupts YAML values like ISO dates by adding extra quotes)
      const fmEnd = task.rawContent.indexOf('---', 4);
      const frontmatterBlock = task.rawContent.slice(0, fmEnd + 3);
      const body = task.rawContent.slice(fmEnd + 3);
      const updatedBody = updateTitleAndSummary(body, result.title, result.summary);
      fs.writeFileSync(path.join(vaultDir, task.relativePath), frontmatterBlock + updatedBody);

      // Re-index with updated content
      indexNote(index, vaultDir, task.relativePath);
      summarized++;
      process.stdout.write(` → "${result.title}"\n`);
    }

    console.log(`\nSummarization complete: ${summarized}/${tasks.length} sessions updated.`);
  }

  // Phase 3: Parallel embeddings
  if (vectorIndex && embedJobs.length > 0) {
    console.log(`Embedding ${embedJobs.length} notes (concurrency: ${EMBEDDING_BATCH_CONCURRENCY})...`);

    const embResult = await batchExecute(
      embedJobs,
      async (job) => {
        const emb = await generateEmbedding(embeddingProvider, job.text);
        vectorIndex!.upsert(job.id, emb.embedding, job.metadata);
      },
      {
        concurrency: EMBEDDING_BATCH_CONCURRENCY,
        onProgress: (done, total) => process.stdout.write(`\r  Embedded ${done}/${total}`),
      },
    );

    process.stdout.write('\n');
    if (embResult.failed > 0) {
      console.log(`  ${embResult.failed} embedding(s) failed.`);
    }
  }

  console.log(`\nDone: ${tasks.length} sessions reprocessed, ${totalObservations} observations extracted, ${summarized} summaries regenerated.`);

  index.close();
  vectorIndex?.close();
}
