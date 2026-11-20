export const telemetryAttribute = (key: string, value: string | number) => ({
  key,
  value: typeof value === 'string' ? { stringValue: value } : { intValue: String(value) },
});
export const telemetryId = (number: number, length = 16) => number.toString(16).padStart(length, '0');
export function telemetrySpan(
  number: number,
  options: {
    trace?: number;
    parent?: number;
    agent?: string;
    conversation?: string;
    operation?: string;
    at?: number;
    attributes?: ReturnType<typeof telemetryAttribute>[];
  } = {},
) {
  const at = options.at ?? 1_800_000_000_000;
  return {
    traceId: telemetryId(options.trace ?? 1, 32),
    spanId: telemetryId(number),
    ...(options.parent === undefined ? {} : { parentSpanId: telemetryId(options.parent) }),
    name:
      options.operation === 'invoke_agent' ? 'invoke_agent worker' : number === 2 ? 'classify model' : 'launch agent',
    kind: number === 2 || options.operation === 'invoke_agent' ? 3 : 1,
    startTimeUnixNano: String(BigInt(at) * 1000000n),
    endTimeUnixNano: String(BigInt(at + 1000) * 1000000n),
    attributes: [
      telemetryAttribute('gen_ai.agent.name', options.agent ?? 'worker'),
      ...(options.conversation === undefined
        ? []
        : [telemetryAttribute('gen_ai.conversation.id', options.conversation)]),
      telemetryAttribute('gen_ai.operation.name', options.operation ?? (number === 2 ? 'classify' : 'create_agent')),
      telemetryAttribute('gen_ai.provider.name', 'openai'),
      telemetryAttribute('gen_ai.request.model', 'example-model'),
      ...(options.attributes ?? []),
    ],
  };
}
export function telemetryBatch<Span>(spans: Span[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            telemetryAttribute('service.name', 'dispatch-service'),
            telemetryAttribute('service.version', '1.0'),
          ],
        },
        scopeSpans: [{ scope: { name: 'dispatch-service' }, spans }],
      },
    ],
  };
}
/** Decision, launch and worker turn share a trace; only standard attributes supply session identity. */
export const telemetryTrace = (lead: string, worker: string, at?: number) =>
  telemetryBatch([
    telemetrySpan(1, { conversation: lead, at }),
    telemetrySpan(2, { parent: 1, at }),
    telemetrySpan(3, { parent: 1, conversation: worker, operation: 'invoke_agent', at }),
  ]);
