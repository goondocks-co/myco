const retiredLeaf = 'cortex.canopy.refresh.background_enabled';

/** Preserve the map refresh switch's stored value and attribution before removal. */
export const V698_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO retired_deployment_settings (leaf,value,updated_at,updated_by,retired_at)
    SELECT leaf,value,updated_at,updated_by,unixepoch()*1000
    FROM deployment_settings WHERE leaf='${retiredLeaf}'`,
  `CREATE TABLE IF NOT EXISTS _v698_guard_retired_settings (ok INTEGER NOT NULL CHECK (ok=1))`,
  `INSERT INTO _v698_guard_retired_settings(ok) SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM deployment_settings live WHERE leaf='${retiredLeaf}'
    AND NOT EXISTS (SELECT 1 FROM retired_deployment_settings saved WHERE saved.leaf=live.leaf
      AND saved.value=live.value AND saved.updated_at=live.updated_at AND saved.updated_by=live.updated_by)
    ) THEN 1 ELSE 0 END`,
  `DROP TABLE _v698_guard_retired_settings`,
  `DELETE FROM deployment_settings WHERE leaf='${retiredLeaf}'`,
];
