export interface ProjectionInput {
  profile?: 'serial' | 'parallel';
  heldBytes: number;
  peakDailyBytes: number;
  growthSource: string;
  latencySource: string;
  liveBytesPerSecond: number;
  localNet: number;
  bytesPerCall: number;
  bytesPerStatement: number;
  bytesPerBlob: number;
  wakeMs: number;
  roundTripsPerByte: number;
  blobCallsPerByte: number;
  sqlLatencyMs: number;
  blobLatencyMs: number;
  contentBytes: number;
  contentCpuMs: number;
  liveLagStable: boolean;
  publications: number;
}

/** Hosted admission is limited by observed progress, invocation resources and sourced latency. */
export function projectHostedConvergence(input: ProjectionInput) {
  const invalid = Object.values(input).some(
    (value) => typeof value === 'number' && (!Number.isFinite(value) || value < 0),
  );
  const gate = Math.ceil(input.peakDailyBytes / 86400);
  if (invalid || !input.growthSource || !input.latencySource || gate <= 0 || input.liveBytesPerSecond < gate)
    return {
      admit: false as const,
      reason: 'missing_evidence',
      binding_constraint: 'missing_evidence',
      liveGate: gate,
    };
  const period = (input.wakeMs + 2000) / 1000;
  const buildCalls = input.profile === 'parallel' ? 500 : 125;
  const resources = {
    calls: (input.bytesPerCall * buildCalls) / period,
    SQL: (input.bytesPerStatement * 200) / period,
    blobs: (input.bytesPerBlob * 60) / period,
  };
  const budgetGross = Math.min(...Object.values(resources));
  const budget = budgetGross - input.liveBytesPerSecond;
  const latencyPerByte =
    (input.roundTripsPerByte * input.sqlLatencyMs + input.blobCallsPerByte * input.blobLatencyMs) / 1000;
  const latencyGross = latencyPerByte > 0 ? 1 / latencyPerByte : 0;
  const latency = latencyGross - input.liveBytesPerSecond;
  const unitMs = input.contentBytes * latencyPerByte * 1000 + input.contentCpuMs;
  const net = Math.min(input.localNet, budget, latency);
  const constraint =
    unitMs > 2000
      ? 'content_wall'
      : !input.liveLagStable
        ? 'live_capacity'
        : input.publications === 0
          ? 'publication'
          : net === input.localNet
            ? 'local'
            : net === latency
              ? 'latency'
              : Object.entries(resources).find(([, rate]) => rate === budgetGross)![0];
  const days = net > 0 ? input.heldBytes / net / 86400 : null;
  return {
    admit: unitMs <= 2000 && input.liveLagStable && input.publications > 0 && days !== null && days <= 7,
    local: input.localNet,
    budgetGross,
    latencyGross,
    budget,
    latency,
    net,
    days,
    unitMs,
    liveGate: gate,
    binding_constraint: constraint,
  };
}
