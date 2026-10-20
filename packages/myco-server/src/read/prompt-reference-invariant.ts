/**
 * The prompt-reference invariant: a receipt or an answer that names a prompt names one the Deployment holds.
 *
 * A reference is dangling when it names a prompt (`prompt_id`, or the `delivered_prompt_id` its delivery named), its
 * ask came by the `v1` protocol, its session is not deleted, and a primary transcript of its session has been parsed
 * to its end past the reference's own instant, while no prompt row of the session carries the id. Both instants are
 * the member's clock: the ask's `asked_at` or the delivery's `delivered_at` against the transcript's latest dated line
 * (`parsed_through_at`). A reference whose transcript has not been read that far yet is in flight, not dangling.
 * `legacy` asks, session-scoped ones and history before the identity columns are excluded by construction.
 *
 * One statement per kind of reference: the hosted store caps a compound select at five terms. Each is bounded to rows
 * created at or after the bound instant (`from`), read Project by Project as a range over
 * `idx_spore_injections_created`/`idx_prompt_context_answers_created`, and checked against the prompt table's own key.
 * Run read-only against a Deployment with that one bound parameter.
 */
import type { RelationalStore } from '../core/adapters.js';

export const PROMPT_REFERENCE_KINDS = ['receipt_selected', 'answer_selected', 'receipt_delivered', 'answer_delivered'] as const;
export type PromptReferenceKind = (typeof PROMPT_REFERENCE_KINDS)[number];

const REFERENCES: Record<PromptReferenceKind, { table: string; prompt: string; at: string }> = {
  receipt_selected: { table: 'spore_injections', prompt: 'prompt_id', at: 'asked_at' },
  answer_selected: { table: 'prompt_context_answers', prompt: 'prompt_id', at: 'asked_at' },
  receipt_delivered: { table: 'spore_injections', prompt: 'delivered_prompt_id', at: 'delivered_at' },
  answer_delivered: { table: 'prompt_context_answers', prompt: 'delivered_prompt_id', at: 'delivered_at' },
};

/** The statement counting one kind's dangling references created at or after its one parameter. */
export function danglingReferenceSql(kind: PromptReferenceKind): string {
  const { table, prompt, at } = REFERENCES[kind];
  return `SELECT COUNT(*) AS n FROM projects pr CROSS JOIN ${table} r
    WHERE r.project_id = pr.project_id AND r.created_at >= ? AND r.ask_protocol = 'v1' AND r.${prompt} IS NOT NULL AND r.${at} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = r.project_id AND t.session_id = r.session_id)
      AND EXISTS (SELECT 1 FROM transcripts x WHERE x.project_id = r.project_id AND x.session_id = r.session_id
                    AND x.role = 'primary' AND x.parsed_offset = x.size AND x.parsed_through_at > r.${at})
      AND NOT EXISTS (SELECT 1 FROM prompt_batches p WHERE p.project_id = r.project_id AND p.session_id = r.session_id AND p.prompt_id = r.${prompt})`;
}

/** How many references of each kind, created at or after `from`, name a prompt the Deployment does not hold. */
export async function danglingPromptReferences(db: RelationalStore, from: number): Promise<Record<PromptReferenceKind, number>> {
  const results = await db.batch(PROMPT_REFERENCE_KINDS.map((kind) => db.prepare(danglingReferenceSql(kind)).bind(from)));
  return Object.fromEntries(PROMPT_REFERENCE_KINDS.map((kind, i) => [kind, (results[i]!.results[0] as { n: number } | undefined)?.n ?? 0])) as Record<PromptReferenceKind, number>;
}

/**
 * The statement counting, per agent, `v1` receipts created at or after its one parameter whose named prompt row
 * records a key hash (`prompt_batches.prompt_key_hash`) other than the receipt's own (`prompt_hash`): one id that
 * carried two texts. A Codex turn whose opener's hook never ran gives its opener id to the first steering hook, and
 * this is where that shows. A signal and never a link: nothing is attached or moved by it.
 */
export const PROMPT_KEY_MISMATCH_SQL = `SELECT s.agent AS agent, COUNT(*) AS n FROM projects pr CROSS JOIN spore_injections r
    JOIN prompt_batches p ON p.project_id = r.project_id AND p.prompt_id = r.prompt_id
    JOIN sessions s ON s.project_id = r.project_id AND s.session_id = r.session_id
  WHERE r.project_id = pr.project_id AND r.created_at >= ? AND r.ask_protocol = 'v1' AND r.prompt_id IS NOT NULL
    AND p.prompt_key_hash IS NOT NULL AND p.prompt_key_hash <> r.prompt_hash
  GROUP BY s.agent`;

/** Receipts created at or after `from` whose prompt row carried another text, counted per agent (`PROMPT_KEY_MISMATCH_SQL`). */
export async function promptKeyMismatches(db: RelationalStore, from: number): Promise<Record<string, number>> {
  const { results } = await db.prepare(PROMPT_KEY_MISMATCH_SQL).bind(from).all<{ agent: string | null; n: number }>();
  return Object.fromEntries(results.map((row) => [row.agent ?? '', row.n]));
}
