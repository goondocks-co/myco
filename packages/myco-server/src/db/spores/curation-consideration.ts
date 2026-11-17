/** Outcomes that adjudicate a revision, rather than defer its evaluation. */
export const curationDecisionSql = (row: string): string => `${row}.outcome IN ('offered','no_group','reviewed','curated')`;
