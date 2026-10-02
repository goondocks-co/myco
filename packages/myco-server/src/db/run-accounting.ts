const RECORDED_HARNESS_ESTIMATE = 'Estimate reported by the harness; not a billing statement';

/** Only recognized cost provenance leaves the stored cost detail. */
export const costProvenanceValue = (prefix = ''): string =>
  `CASE WHEN json_valid(${prefix}cost_data) THEN CASE
    WHEN json_type(${prefix}cost_data, '$.provenance') = 'text' THEN json_extract(${prefix}cost_data, '$.provenance')
    WHEN json_extract(${prefix}cost_data, '$.message') = '${RECORDED_HARNESS_ESTIMATE}' THEN 'harness_estimate'
  END END`;
