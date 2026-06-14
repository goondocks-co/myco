/**
 * The Team page must NOT silently default to the first registered team:
 * comparing an arbitrary team's cloud against the current context produced a
 * phantom delta (and exposed a destructive "Rebuild from local" against a store
 * the user never chose). Only honor an explicit URL selection; otherwise show
 * an empty state prompting the user to pick a team.
 */
export function resolveDefaultSelectedTeamId(
  urlTeamParam: string | null,
  _teams: Array<{ team_id: string }>,
): string | undefined {
  return urlTeamParam ?? undefined;
}
