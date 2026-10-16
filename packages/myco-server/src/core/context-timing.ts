/** Request-local durations exposed by the context routes. */
export type ContextTimingStage = 'embed' | 'vector' | 'candidate' | 'hydrate';

const STAGES: readonly ContextTimingStage[] = ['embed', 'vector', 'candidate', 'hydrate'];
const duration = (milliseconds: number): string => Math.max(0, milliseconds).toFixed(3);

export class ContextTimings {
  private readonly durations: Record<ContextTimingStage, number> = { embed: 0, vector: 0, candidate: 0, hydrate: 0 };

  record(stage: ContextTimingStage, milliseconds: number): void {
    this.durations[stage] += milliseconds;
  }

  header(): string {
    return STAGES.map((stage) => `${stage};dur=${duration(this.durations[stage])}`).join(', ');
  }
}

/** The pipeline adds total to every context answer, including pre-handler refusals. */
export function withContextServerTiming(response: Response, startedAt: number): Response {
  const headers = new Headers(response.headers);
  const stages = headers.get('server-timing') ?? new ContextTimings().header();
  headers.set('server-timing', `${stages}, total;dur=${duration(performance.now() - startedAt)}`);
  return new Response(response.body, { status: response.status, headers });
}
