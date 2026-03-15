import type { MycoIndex } from '../../index/sqlite.js';

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
  currentUser?: string,  // From config.team.user, injected by server
): Promise<TeamActivity[]> {
  const sessions = index.query({
    type: 'session',
    since: input.since,
    limit: 50,
  });

  // Exclude current user's sessions
  const teamSessions = sessions.filter((s) => {
    const user = (s.frontmatter as any)?.user;
    return user && user !== currentUser;
  });

  // Filter by plan if specified
  let filtered = teamSessions;
  if (input.plan) {
    filtered = filtered.filter((s) => {
      const planRef = (s.frontmatter as any)?.plan;
      return planRef === `[[${input.plan}]]` || planRef === input.plan;
    });
  }

  return filtered.map((s) => ({
    user: String((s.frontmatter as any)?.user ?? ''),
    session_id: s.id,
    summary: s.content.slice(0, 200),
    files_changed: [],  // Would be extracted from session content
    decisions: [],       // Would be extracted from linked memories
  }));
}
