/** A reporter-issued positive safe integer, independent of wall time. */
export const isReportOrder = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
