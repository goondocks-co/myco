/** Settings revisions outlive configured values and reset receipts. */
export const V710_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS setting_revisions (
    scope TEXT NOT NULL, leaf TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
    PRIMARY KEY(scope,leaf)) WITHOUT ROWID`,
  `INSERT OR IGNORE INTO setting_revisions(scope,leaf,revision)
    SELECT '',leaf,1 FROM deployment_settings UNION SELECT '',leaf,1 FROM deployment_setting_resets
    UNION SELECT project_id,leaf,1 FROM project_settings
    UNION SELECT 'capability:' || project_id,capability,1 FROM project_capabilities`,
  ...[
    { table: 'deployment_settings', scope: "''", leaf: 'leaf' },
    { table: 'deployment_setting_resets', scope: "''", leaf: 'leaf' },
    { table: 'project_settings', scope: '$.project_id', leaf: 'leaf' },
    { table: 'project_capabilities', scope: "'capability:' || $.project_id", leaf: 'capability' },
  ].flatMap(({ table, scope, leaf }) => (['INSERT','UPDATE','DELETE'] as const).map(operation => {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER IF NOT EXISTS ${table}_revision_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN INSERT INTO setting_revisions(scope,leaf,revision) VALUES(${scope.replaceAll('$', row)},${row}.${leaf},1)
        ON CONFLICT(scope,leaf) DO UPDATE SET revision=setting_revisions.revision+1; END`;
  })),
];
