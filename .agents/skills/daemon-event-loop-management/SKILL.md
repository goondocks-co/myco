---
name: myco:daemon-event-loop-management
description: |
  Implement event-loop safety patterns, prevent main-thread blocking, add yield points,
  manage async work orchestration, implement lag monitoring, and build recovery procedures
  for the Myco daemon infrastructure. Use this when adding new async operations to the daemon,
  diagnosing responsiveness issues, or when /health endpoints become unresponsive,
  even if the user doesn't explicitly ask for event-loop hardening.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon Event Loop Management

This skill covers implementing event-loop safety patterns in the Myco daemon to prevent main-thread blocking, add yield points for async work orchestration, implement lag monitoring, and build recovery procedures. Use these patterns when adding new async operations, diagnosing responsiveness issues, or hardening daemon infrastructure against event-loop starvation.

## Prerequisites

- Understanding of Node.js event loop fundamentals (libuv, microtasks vs macrotasks)
- Access to daemon codebase in `packages/myco/src/daemon/`
- Familiarity with async/await patterns and AbortController usage
- Basic understanding of process profiling tools (sampling, strace)

## Procedure A: Implement Event Loop Lag Monitoring

Set up always-on observability to detect when the event loop becomes unresponsive:

1. **Create the lag probe** in `daemon/event-loop-lag.ts`:
   ```typescript
   export class EventLoopLagProbe {
     private intervalMs: number;
     private warnThresholdMs: number;
     private timerId: NodeJS.Timeout | null = null;
     private stats = { peakLag: 0, stallCount: 0 };

     constructor(intervalMs = 250, warnThresholdMs = 500) {
       this.intervalMs = intervalMs;
       this.warnThresholdMs = warnThresholdMs;
     }

     start() {
       this.scheduleNext();
     }

     private scheduleNext() {
       const start = Date.now();
       this.timerId = setTimeout(() => {
         const lag = Date.now() - start - this.intervalMs;
         if (lag > this.warnThresholdMs) {
           logger.warn('daemon.lag', { lagMs: lag });
           this.stats.stallCount++;
         }
         this.stats.peakLag = Math.max(this.stats.peakLag, lag);
         this.scheduleNext();
       }, this.intervalMs);
     }

     stop() {
       if (this.timerId) clearTimeout(this.timerId);
     }

     getStats() { return { ...this.stats }; }
   }
   ```

2. **Wire into daemon lifecycle** in `main.ts`:
   ```typescript
   import { EventLoopLagProbe } from './event-loop-lag.js';

   const lagProbe = new EventLoopLagProbe();
   lagProbe.start();

   // In shutdown handler
   lagProbe.stop();
   ```

3. **Add test coverage** in `tests/daemon/event-loop-lag.test.ts`:
   - Clean loop emits nothing
   - Sync block past threshold emits warn with observed lag
   - `stop()` halts further samples

**Rationale:** Chained setTimeout provides direct measurement of event loop responsiveness. 250ms sampling with 500ms warn threshold catches starvation without noise.

## Procedure B: Implement Instrumented Fetch with Yield Points

Create fetch wrappers that prevent blocking I/O from starving the event loop:

1. **Create instrumented fetch factory** in `utils/instrumented-fetch.ts`:
   ```typescript
   export function createInstrumentedFetch(options: {
     component: string;
     headersTimeoutMs?: number;
     idleTimeoutMs?: number;
   }): FetchLike {
     const { component, headersTimeoutMs = 60000, idleTimeoutMs = 30000 } = options;
     
     return async function instrumentedFetch(input, init) {
       const requestId = crypto.randomUUID().slice(0, 8);
       const url = typeof input === 'string' ? input : input.url;
       logger.debug('fetch.start', { component, requestId, url: redactUrl(url) });

       // Compose timeouts with caller's AbortSignal
       const composedSignal = composeAbortSignals([
         AbortSignal.timeout(headersTimeoutMs),
         createIdleWatchdog(idleTimeoutMs),
         init?.signal
       ]);

       const response = await fetch(input, { ...init, signal: composedSignal });
       
       // Wrap body to yield between chunks
       if (response.body) {
         response.body = wrapBodyWithYields(response.body, requestId, component);
       }

       return response;
     };
   }

   function wrapBodyWithYields(body: ReadableStream, requestId: string, component: string) {
     return new ReadableStream({
       start(controller) {
         const reader = body.getReader();
         let chunkCount = 0;

         function pump() {
           reader.read().then(({ done, value }) => {
             if (done) {
               controller.close();
               logger.debug('fetch.complete', { component, requestId, chunkCount });
               return;
             }
             chunkCount++;
             controller.enqueue(value);
             
             // Yield to libuv between chunks
             setImmediate(pump);
           }).catch(error => {
             controller.error(error);
             logger.warn('fetch.abort', { component, requestId, error: error.message });
           });
         }
         pump();
       }
     });
   }
   ```

2. **Wire into providers** (e.g., `harness/openai.ts`):
   ```typescript
   const harnessFetch = createInstrumentedFetch({
     component: 'agent.openai-harness',
     headersTimeoutMs: 90000, // Cold model warm-up tolerance
     idleTimeoutMs: 45000
   });

   const openai = new OpenAI({
     apiKey: config.apiKey,
     baseURL: config.baseURL,
     fetch: harnessFetch
   });
   ```

**Key insight:** The `setImmediate` between chunks is critical - without it, large streaming responses can monopolize the microtask queue and starve timer/I/O phases.

## Procedure C: Add Yield Points to Async Work

Insert strategic yield points in sync-heavy async operations to prevent event loop starvation:

1. **Identify blocking patterns** to look for:
   - Back-to-back `await` calls on already-resolved promises (microtask chains)
   - Loops processing large datasets without I/O
   - Sync operations like `runGit` shellouts in batches
   - Stream consumption without backpressure

2. **Add yield points at appropriate granularity**:
   ```typescript
   // Between processing waves
   async function processInWaves<T>(items: T[], waveSize: number, processor: (item: T) => Promise<void>) {
     for (let i = 0; i < items.length; i += waveSize) {
       const wave = items.slice(i, i + waveSize);
       await Promise.allSettled(wave.map(processor));
       
       // Yield between waves to allow timers/I/O to fire
       await new Promise(resolve => setImmediate(resolve));
     }
   }

   // In message stream consumption (like claude.ts harness)
   for await (const message of messageStream) {
     await processMessage(message);
     // Yield between messages to prevent microtask saturation
     await new Promise(resolve => setImmediate(resolve));
   }

   // In database/file operations (like reconcile.ts)
   for (const row of rows) {
     await processRow(row);
     if (shouldYield()) {
       await new Promise(resolve => setImmediate(resolve));
     }
   }
   ```

3. **Common yield patterns**:
   - **After microtask-heavy operations** (`Promise.allSettled`, JSON parsing)
   - **Between iterations** of large loops
   - **After sync shell operations** (`execSync`, `spawnSync`)
   - **In stream readers** before calling `reader.read()` again

**Critical locations in Myco daemon:**
- `agent/harness/claude.ts:117` - Claude SDK message stream consumption
- `phase-loop.ts:680` - Between wave processing
- `openai-local-mcp.ts:64` - After MCP tool handler calls
- `release-provenance/reconcile.ts` - Per row, per ref, every 32 commits

**Gotcha:** Don't yield too frequently (every iteration of a tight loop) as the yield overhead can hurt performance. Find the right granularity for your workload.

## Procedure D: Diagnose Event Loop Starvation

Systematic approach to identifying and fixing event loop blocking issues:

1. **Reproduce the starvation**:
   - Set up concurrent `/health` probing: `watch -n 0.1 'curl -w "%{time_total}s\n" -s localhost:8080/health'`
   - Run the suspected operation in parallel
   - Look for `/health` timeouts or high latency spikes

2. **Use profiling to identify hot paths**:
   ```bash
   # macOS: Sample the process during starvation
   sudo sample $(pgrep -f myco-daemon) 10 -file daemon-profile.txt

   # Linux: Use perf or strace to see syscall patterns
   strace -p $(pgrep -f myco-daemon) -f -e trace=poll,epoll_wait 2>&1 | grep -v EINTR
   ```

3. **Check existing observability**:
   - Look for `daemon.lag` warnings in logs during the starvation window
   - Check fetch instrumentation logs for stuck requests
   - Verify if specific components (claude-sdk, release-provenance) correlate with hangs

4. **Common false suspects**:
   - **Agent execution isolation**: Often the real culprit is sync work (shell operations, large data processing), not the async agent pipeline itself
   - **Database blocking**: Bun SQLite is generally fast; look for application-layer loops that don't yield rather than DB query performance
   - **Network I/O**: If instrumented fetch logs show normal completion, the issue is likely CPU/microtask saturation, not network blocking

**Pattern from the investigation:** Event loop starvation often results from several moderate blocking operations running concurrently (e.g., Claude SDK message processing + release-provenance reconcile sync shellouts) rather than one severe blocker.

## Procedure E: Implement Graceful Shutdown

Prevent shutdown hangs that can block daemon restarts:

1. **Understand the shutdown sequence** in `main.ts`:
   ```typescript
   async function runShutdown(signal: string) {
     logger.info('daemon.shutdown.start', { signal });
     
     // Drain in-flight work with timeout
     await inflightRuns.drain(30000); // 30s grace period
     
     // Close HTTP server (can block on keep-alive connections)
     await server.stop(); // Up to ~60s for keep-alive drain
     
     logger.info('daemon.shutdown.complete');
   }
   ```

2. **Implement fast shutdown** when grace period is unnecessary:
   ```typescript
   // Replace long keep-alive drain with immediate idle close + force close
   server.closeIdleConnections();
   await Promise.race([
     server.stop(),
     new Promise(resolve => setTimeout(resolve, 100)) // 100ms max wait
   ]);
   ```

3. **Monitor shutdown timing**:
   ```typescript
   const shutdownStart = Date.now();
   await runShutdown(signal);
   const shutdownMs = Date.now() - shutdownStart;
   logger.info('daemon.shutdown.timing', { shutdownMs });
   ```

**Gotcha from session 4271735f:** Sequential `await` of both `inflightRuns.drain(30s)` and `server.stop()` (60s) can result in 90+ second shutdown times. During development, this manifests as "port already in use" errors when restarting because the old daemon hasn't released the port yet.

## Procedure F: Test Event Loop Responsiveness

Build verification that ensures your changes don't introduce new starvation:

1. **Create responsiveness test** in `tests/daemon/agent-loop-responsiveness.test.ts`:
   ```typescript
   test('daemon maintains responsiveness during heavy async work', async () => {
     // Start loopback HTTP server for /health simulation
     const server = http.createServer((req, res) => {
       if (req.url === '/health') {
         res.writeHead(200, { 'Content-Type': 'text/plain' });
         res.end('ok');
       }
     });
     await new Promise(resolve => server.listen(0, resolve));
     const port = server.address().port;

     // Kick off heavy async work that might block
     const heavyWork = simulateHeavyAsyncWork();
     
     // Probe /health throughout the work
     const probeResults = [];
     const probeInterval = setInterval(async () => {
       const start = Date.now();
       try {
         await fetch(`http://localhost:${port}/health`);
         probeResults.push(Date.now() - start);
       } catch (error) {
         probeResults.push(Infinity); // Timeout/error
       }
     }, 100); // Every 100ms

     await heavyWork;
     clearInterval(probeInterval);
     
     // Assert max latency < 200ms (adjust threshold based on workload)
     const maxLatency = Math.max(...probeResults);
     expect(maxLatency).toBeLessThan(200);
   });
   ```

2. **Test yield point effectiveness**:
   ```typescript
   test('yield points prevent event loop starvation', async () => {
     const lagProbe = new EventLoopLagProbe(100, 150); // Tighter thresholds
     const lagWarnings = [];
     
     // Capture lag warnings
     const originalWarn = logger.warn;
     logger.warn = (message, data) => {
       if (message === 'daemon.lag') lagWarnings.push(data);
     };

     lagProbe.start();
     
     // Run operation that should yield properly
     await operationWithYieldPoints();
     
     lagProbe.stop();
     logger.warn = originalWarn;
     
     // Should not trigger lag warnings
     expect(lagWarnings).toEqual([]);
   });
   ```

3. **Integration smoke test pattern** (from the PR #276 verification):
   ```bash
   # 5-minute concurrent health check during real workload
   timeout 300 watch -n 0.1 'curl -w "%{time_total}s\n" -s localhost:8080/health' &
   
   # Run the potentially blocking operation
   npm run daemon:reconcile-all
   
   # Check probe results - should see consistent < 1s latency
   ```

**Verification metrics from the actual fix:**
- Before: 229/300 /health probes ok, max latency 199,000ms (wedge)
- After: 300/300 ok, max latency 902ms, zero lag.spike entries

## Cross-Cutting Gotchas

- **Microtask vs macrotask confusion**: `setImmediate` yields to libuv (timers, I/O), but `Promise.resolve().then(...)` stays in microtasks. Use `setImmediate` for true yields.

- **AbortSignal composition**: When adding timeouts to existing AbortSignal-aware APIs, compose signals rather than replacing them. The caller's signal may carry important cancellation logic. Watch for deadlocks where `reader.read()` doesn't observe AbortSignals directly - you need to call `reader.cancel()`.

- **Yield point granularity**: Too frequent yields hurt performance; too sparse yields don't help responsiveness. Start with logical boundaries (end of message processing, end of row processing) and measure.

- **Profiling misdirection**: `posix_spawn` storms in profiles often come from sync shellouts (`runGit`) in release-provenance reconcile rather than the async operation you're investigating. Follow the call stacks carefully.

- **Worker isolation temptation**: Before jumping to `worker_threads` or `child_process` isolation, verify that yield points don't solve the problem. The architectural complexity of worker isolation is significant.

- **Shutdown composition**: Multiple large timeout budgets in sequence (30s + 60s) can surprise developers expecting quick restart cycles. Consider fast-shutdown paths for development.

- **Test environment differences**: Local development may not reproduce production event loop patterns due to different concurrency levels, data sizes, or I/O latency.