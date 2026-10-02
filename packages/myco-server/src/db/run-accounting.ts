/** Only the named cost provenance scalar leaves the stored cost detail. */
export const costProvenanceValue = (prefix = ''): string =>
  `CASE WHEN json_valid(${prefix}cost_data) THEN CASE WHEN json_type(${prefix}cost_data, '$.provenance') = 'text' THEN json_extract(${prefix}cost_data, '$.provenance') END END`;
