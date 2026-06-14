/**
 * Resolve which team the Team page shows. Priority: an explicit URL `?team=`,
 * then the persisted prior selection, then the first registered team. Auto-
 * selecting the first team (rather than an empty state) keeps the page populated;
 * persisting the choice keeps it stable across tab navigation within the section.
 * Stale ids (a team since removed) fall through to the next valid candidate.
 */
export function resolveDefaultSelectedTeamId(
  urlTeamParam: string | null,
  teams: Array<{ team_id: string }>,
  storedTeamId?: string | null,
): string | undefined {
  const ids = new Set(teams.map((t) => t.team_id));
  if (urlTeamParam && ids.has(urlTeamParam)) return urlTeamParam;
  if (storedTeamId && ids.has(storedTeamId)) return storedTeamId;
  return teams[0]?.team_id;
}
