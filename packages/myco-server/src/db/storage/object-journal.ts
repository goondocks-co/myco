/** The one statement that writes a journal row: `selection` yields the physical key, the kind and the instant. */
export const objectJournalSql = (selection: string): string =>
  `INSERT INTO object_releases(physical,kind,created_at) ${selection} ON CONFLICT(physical) DO NOTHING`;
