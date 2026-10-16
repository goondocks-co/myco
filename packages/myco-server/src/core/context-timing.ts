/** Request-local durations exposed by the context routes. */
export type ContextTimingStage = 'embed' | 'vector' | 'candidate' | 'hydrate';

const STAGES: readonly ContextTimingStage[] = ['embed', 'vector', 'candidate', 'hydrate'];
const duration = (milliseconds: number): string => Math.max(0, milliseconds).toFixed(3);

export class ContextTimings {
  private readonly durations: Partial<Record<ContextTimingStage, number>> = {};

  record(stage: ContextTimingStage, milliseconds: number): void {
    this.durations[stage] = (this.durations[stage] ?? 0) + milliseconds;
  }

  header(): string {
    return STAGES.flatMap((stage) => {
      const milliseconds = this.durations[stage];
      return milliseconds === undefined ? [] : [`${stage};dur=${duration(milliseconds)}`];
    }).join(', ');
  }
}

/** The pipeline adds total to every context answer, including pre-handler refusals. */
export function withContextServerTiming(response: Response, startedAt: number, timings: ContextTimings): Response {
  const headers = new Headers(response.headers);
  headers.set('server-timing', [timings.header(), `total;dur=${duration(performance.now() - startedAt)}`].filter(Boolean).join(', '));
  return new Response(response.body, { status: response.status, headers });
}
