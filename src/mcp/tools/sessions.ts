import type { MycoIndex } from '../../index/sqlite.js';

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
  let sessions = index.query({
    type: 'session',
    since: input.since,
    limit: input.limit ?? 20,
  });

  if (input.plan) {
    sessions = sessions.filter((s) => {
      const planRef = (s.frontmatter as any)?.plan;
      return planRef === `[[${input.plan}]]` || planRef === input.plan;
    });
  }

  if (input.branch) {
    sessions = sessions.filter((s) =>
      (s.frontmatter as any)?.branch === input.branch,
    );
  }

  if (input.user) {
    sessions = sessions.filter((s) =>
      (s.frontmatter as any)?.user === input.user,
    );
  }

  return sessions.map((s) => ({
    id: s.id,
    summary: s.content.slice(0, 300),
    user: String((s.frontmatter as any)?.user ?? ''),
    agent: String((s.frontmatter as any)?.agent ?? ''),
    started: String((s.frontmatter as any)?.started ?? s.created),
    parent: ((s.frontmatter as any)?.parent as string) ?? null,
    plan: ((s.frontmatter as any)?.plan as string) ?? null,
    tags: ((s.frontmatter as any)?.tags as string[]) ?? [],
  }));
}
