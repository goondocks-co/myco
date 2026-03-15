import type { MycoIndex } from '../../index/sqlite.js';
import { sessionFm } from '../../vault/frontmatter.js';
import { SESSION_SUMMARY_PREVIEW_CHARS } from '../../constants.js';

interface SessionsInput {
  plan?: string;
  branch?: string;
  user?: string;
  since?: string;
  limit?: number;
}

interface SessionSummary {
  id: string;
  summary: string;
  user: string;
  agent: string;
  started: string;
  parent: string | null;
  plan: string | null;
  tags: string[];
}

export async function handleMycoSessions(
  index: MycoIndex,
  input: SessionsInput,
): Promise<SessionSummary[]> {
  const frontmatter: Record<string, string> = {};
  if (input.branch) frontmatter.branch = input.branch;
  if (input.user) frontmatter.user = input.user;

  let sessions = index.query({
    type: 'session',
    since: input.since,
    limit: input.limit ?? 20,
    frontmatter,
  });

  // Plan filtering needs special handling for [[wikilink]] format
  if (input.plan) {
    sessions = sessions.filter((s) => {
      const planRef = sessionFm(s).plan;
      return planRef === `[[${input.plan}]]` || planRef === input.plan;
    });
  }

  return sessions.map((s) => {
    const f = sessionFm(s);
    return {
      id: s.id,
      summary: s.content.slice(0, SESSION_SUMMARY_PREVIEW_CHARS),
      user: f.user ?? '',
      agent: f.agent ?? '',
      started: f.started ?? s.created,
      parent: f.parent ?? null,
      plan: f.plan ?? null,
      tags: f.tags ?? [],
    };
  });
}
