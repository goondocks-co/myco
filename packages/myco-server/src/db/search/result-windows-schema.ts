/** The stored rankings later pages of a search read, as one schema step freezes them. */
export function searchResultWindowStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS search_result_windows(search_id TEXT NOT NULL PRIMARY KEY, reader TEXT NOT NULL, binding TEXT NOT NULL,
      asof INTEGER NOT NULL, expires_at INTEGER NOT NULL, round INTEGER NOT NULL, kinds TEXT NOT NULL, hits TEXT NOT NULL) WITHOUT ROWID`.replace(/\s+/g, ' '),
    'CREATE INDEX IF NOT EXISTS idx_search_result_windows_expiry ON search_result_windows(expires_at, search_id)',
    'CREATE INDEX IF NOT EXISTS idx_search_result_windows_reader ON search_result_windows(reader, expires_at)',
  ];
}
