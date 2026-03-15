import type { MycoIndex } from '../../index/sqlite.js';
import { sessionFm } from '../../vault/frontmatter.js';

interface TeamInput {
  files?: string[];
  plan?: string;
  since?: string;
}

interface TeamActivity {
  user: string;
  session_id: string;
  summary: string;
  files_changed: string[];
  decisions: string[];
}

export async function handleMycoTeam(
  index: MycoIndex,
  input: TeamInput,
  currentUser?: string,
): Promise<TeamActivity[]> {
  const sessions = index.query({
    type: 'session',
    since: input.since,
    limit: 50,
  });

  // Filter out current user and optionally by plan
  const filtered = sessions.filter((s) => {
    const f = sessionFm(s);
    if (!f.user || f.user === currentUser) return false;
    if (input.plan) {
      const planRef = f.plan;
      if (planRef !== `[[${input.plan}]]` && planRef !== input.plan) return false;
    }
    return true;
  });

  return filtered.map((s) => {
    const f = sessionFm(s);
    return {
      user: f.user ?? '',
      session_id: s.id,
      summary: s.content.slice(0, 200),
      files_changed: [],
      decisions: [],
    };
  });
}
