export const objectJournalSql = (selection: string): string =>
  `INSERT INTO object_releases(physical,kind,created_at) ${selection} ON CONFLICT(physical) DO NOTHING`;
