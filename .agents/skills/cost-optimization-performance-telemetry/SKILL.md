---
name: myco:cost-optimization-performance-telemetry
description: Comprehensive procedures for analyzing, optimizing, and monitoring LLM costs and performance in Myco's agent harness system. Covers cost leak identification, performance bottleneck analysis, resource allocation optimization, SDK execution telemetry, and budget calibration patterns. Use when investigating cost spikes, optimizing agent task efficiency, calibrating turn budgets, or implementing cost control measures, even if the user doesn't explicitly ask for cost optimization analysis.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cost Optimization & Performance Telemetry

Systematic procedures for analyzing, optimizing, and monitoring LLM costs and performance in Myco's agent harness system. With Grove architecture, global daemon coordination affects cost attribution across multiple projects while new MCP transport patterns eliminate HTTP loopback overhead.

## Prerequisites

- Understanding of Myco's Grove architecture and global daemon coordination
- Access to task logs and cost telemetry data across grove boundaries
- Familiarity with model provider APIs (Claude SDK, OpenAI, local models)
- Knowledge of turn budget configuration in task definitions
- Understanding of map-phase architecture and accelerator systems
- Understanding of Grove global daemon cost attribution and multi-project scoping
- Familiarity with Bun test isolation and build profile optimization

## Procedure A: LLM Cost Analysis & Budget Calibration

Identify cost leak patterns and calibrate budgets for sustainable operation across grove boundaries.

1. **Analyze grove-aware cost leak patterns**:
   - Check for Claude SDK overhead: Look for 25k+ token requests in logs where actual content is minimal
   - Monitor vault-evolve cadence: Identify no-op runs burning $158/day
   - Review tool invocation costs vs token throughput ratios
   - Examine settingSources configuration causing unnecessary API calls
   - **Grove-specific**: Analyze global daemon cost allocation across multiple projects and groves
   - **Grove coordination overhead**: Monitor cross-grove communication costs

2. **Calibrate grove-scoped task budgets with cadence defaults**:
   ```yaml
   # In packages/myco/src/agent/definitions/tasks/*.yaml
   phases:
     analyze:
       turnBudget: 15  # Start conservative
       groveMultiplier: 1.2  # Account for cross-grove coordination
       cadence: 360  # minutes (6h standard) — DO NOT use 5-min default
     optimize:
       turnBudget: 25  # Scale based on complexity
       groveMultiplier: 1.1  # Lighter coordination overhead
       cadence: 360  # 6h standard reduces cost 72× vs 5-min default
   ```
   - **Cadence cost trap**: 5-minute task intervals cost 72× more than 6-hour intervals over a day
   - **Default guidance**: Start at 360m (6h) unless rapid feedback is explicitly required
   - **No-op detection**: Mechanical checks (drift detection, fingerprinting) beat expensive verification at 5m intervals

3. **Model grove cost-per-operation baselines**:
   - Document typical token consumption per grove and project type
   - Calculate cost-per-spore extraction with grove context overhead
   - Establish performance vs cost trade-off curves by model class and grove size
   - **Grove attribution**: Model cross-project cost sharing through global daemon
   - Track grove coordination overhead vs direct project costs

4. **Implement grove-aware cost kill switches**:
   - Add `settingSources: []` in `packages/myco/src/agent/harness/claude.ts` where appropriate
   - Use early termination conditions in expensive loops
   - Gate expensive operations behind session-terminal checks
   - **Grove-specific**: Implement per-grove and cross-grove cost budgets and throttling
   - Add grove-scoped circuit breakers for runaway costs

5. **Replace expensive verification with mechanical grove drift detection**:
   - **Pattern**: Replace LLM-based verification phases with grove file system drift detection
   - **Example**: skill-evolve moved from 15-minute verification cycles to 6-hour mechanical drift detection
   - **Grove implementation**: Use grove-aware file fingerprinting and structural analysis
   - **Cost impact**: Prevents $158/day burn from no-op verification runs across multiple groves

## Procedure B: Performance Bottleneck Identification

Prioritize optimization efforts based on runtime dominance analysis with Grove coordination overhead and test suite optimization patterns.

1. **Profile model inference vs grove coordination overhead**:
   - Measure actual model API call time vs tool execution time
   - Identify when runtime is model-dominated vs grove-coordination-dominated
   - Focus optimization on the dominant cost component (model vs coordination)
   - **Grove-specific**: Factor in global daemon communication and cross-grove coordination latency

2. **Compare SDK execution patterns with grove context**:
   ```bash
   # Profile different SDK approaches with grove coordination
   time node -e "// Claude SDK test with grove context"
   time node -e "// OpenAI SDK test with grove coordination"
   # Look for 15× performance differences via KV-cache reuse
   # Account for grove coordination overhead in measurements
   ```

3. **Analyze grove-aware tool emission ceiling**:
   - Monitor tool calls per turn and cumulative emissions across groves
   - Identify tasks hitting tool emission limits before budget limits
   - Optimize tool usage patterns to stay within efficient ranges across grove boundaries
   - **MCP transport**: Benefit from direct MCP connections eliminating HTTP loopback overhead
   - Track grove-scoped tool usage patterns and cross-grove coordination costs

4. **Test suite performance optimization with measured-isolation**:
   - **Isolation-boundary runner architecture**: Use `scripts/run-bun-tests.mjs` measured-isolation model
   - **Domain-scoped Bun processes**: Group related test files into single Bun processes rather than isolating every file
   - **Performance gain**: Achieve 20% test suite improvement through optimal isolation boundaries
   - **Trade-off analysis**: Balance test isolation safety vs execution speed
   - **Build profile optimization**: Exclude flaky integration tests from performance-critical build profiles

5. **Document grove optimization priorities**:
   - Runtime optimization takes precedence when model-dominated
   - Grove coordination optimization for coordination-dominated workloads
   - Token throughput optimization for system-dominated workloads
   - Tool consolidation for emission-ceiling cases with grove boundaries
   - Test suite optimization for development cycle acceleration

## Procedure C: Cost-Effective Scheduling & Resource Allocation

Optimize task cadence and resource allocation patterns across grove boundaries.

1. **Calibrate grove-aware task cadence**:
   - Set longer intervals for expensive intelligence tasks across multiple groves
   - Implement back-off for no-change scenarios within grove boundaries
   - Use session-terminal gating for costly operations:
   ```typescript
   if (session.status !== 'terminal') {
     throw new Error('Session not terminal - skipping expensive analysis');
   }

   // Grove-specific validation
   if (!isGroveCoordinationComplete(session.grove_id)) {
     throw new Error(`Grove ${session.grove_id} coordination incomplete`);
   }
   ```
   - **Grove-specific**: Coordinate task scheduling across projects to avoid global daemon overload

2. **Configure grove idle/sleep mode resource allocation**:
   - Reduce polling frequencies during grove inactive periods
   - Pause expensive background tasks when no new data across groves
   - Implement progressive back-off for repeated no-ops with grove awareness
   - **Grove-specific**: Implement grove activity-aware scheduling with global daemon coordination

3. **Optimize turn budget by model class with grove multipliers**:
   ```yaml
   # In task configuration files with grove support
   turnBudgetMultipliers:
     local: 4         # Local models need 3-4× budget
     claude: 1        # Baseline
     gpt: 1.2         # Slight increase for context handling
   groveMultipliers:
     single_grove: 1.0    # No coordination overhead
     multi_grove: 1.3     # Cross-grove coordination overhead
     global_daemon: 1.1   # Global daemon coordination cost
   ```

4. **Implement grove session-gating for expensive tasks**:
   - Gate skill-survey, full-intelligence on terminal sessions only
   - Prevent stale artifact generation from active sessions across groves
   - Add session state validation before expensive operations with grove coordination
   - Validate grove coordination state before cross-grove operations

5. **Understand JobRunner drain bounded-slice contracts**:
   - Background jobs migrated from PowerManager to `JobRunner` (`packages/myco/src/daemon/job-runner.ts`)
   - Each `RunnerJob` declares an optional `DrainSpec` with a `slice` count (base items per tick) and `softDeadlineMs` (default 2000ms) to bound work per tick
   - **Serial tick starvation**: Long-running jobs (e.g., release-provenance reconciler averaging 348s) block all subsequent jobs in the serial tick loop — do not schedule expensive jobs at short intervals without bounded drain specs
   - **Per-job dispatch tracking**: `JobRunner` maintains a `lastDispatched` map keyed by job name; each job tracks its own cadence independently rather than sharing a global state
   - **Deep-sleep hold from `HoldSpec`**: Jobs with a `HoldSpec` use a `pending()` function to signal non-empty queues; non-zero `pending()` prevents the daemon from entering deep sleep (`allowDeepSleepHold` defaults true)

## Procedure D: SDK Execution Telemetry & Monitoring

Implement comprehensive cost and performance tracking with grove attribution and improved accuracy.

1. **Set up grove-aware multi-provider runtime tracking**:
   ```typescript
   // Add to agent harness in packages/myco/src/agent/harness/
   const groveCostTracker = {
     provider: 'claude',
     grove_id: session.grove_id,
     project_id: session.project_id,
     tokensIn: request.tokens,
     tokensOut: response.tokens,
     cost: calculateCost(provider, tokensIn, tokensOut),
     latency: Date.now() - startTime,
     grove_coordination_overhead: coordinationLatency
   };
   ```

2. **Implement grove phase-level cost attribution**:
   - Track costs per task phase (extract, analyze, consolidate) with grove context
   - Monitor cumulative costs across task runs within grove boundaries
   - Alert on phase-level budget overruns with grove-specific thresholds
   - **Grove-specific**: Attribute costs to specific projects and groves through global daemon
   - Track cross-grove coordination costs separately from direct operation costs

3. **Monitor grove agent harness operational correctness**:
   - Track task completion rates vs budget exhaustion across groves
   - Monitor error rates by task type and model with grove context
   - Measure quality degradation under budget pressure with grove coordination delays
   - Track grove coordination failures and their cost impact

4. **Implement grove resource isolation monitoring**:
   - Track memory and CPU usage per task phase with grove coordination overhead
   - Monitor concurrent task interference patterns across grove boundaries
   - Validate phased executor resource boundaries with grove awareness
   - Track global daemon resource usage across multiple groves

5. **Improved telemetry accuracy for tool call counting and system batch filtering**:
   - **Accurate tool emission tracking**: Fix telemetry that undercounts tool calls in multi-tool turns
   - **Emission ceiling validation**: Monitor tasks hitting tool emission limits vs budget limits
   - **Tool-heavy vs token-heavy workload classification**: Categorize tasks by dominant resource consumption
   - **Tool consolidation effectiveness measurement**: Track performance improvements from tool usage optimization
   - **System batch origin filtering**: Exclude system-generated batches (~11% telemetry noise) from cost attribution
   - **Origin filtering implementation**: Check batch origin field before counting in cost models

6. **Monitor embedding provider health accurately**:
   - `isAvailable()` on local providers (Ollama, LM Studio) can return false-positive `true` when a brew stub is installed but the service is not actually running
   - Multiple search consumers (`packages/myco/src/intelligence/embed-query.ts` and semantic search routes) behave inconsistently when the provider is down: some retry, some silently skip, some return empty results
   - Embedding status endpoints may report available regardless of actual provider connectivity — always verify via an explicit provider health probe before trusting the status field
   - **Observability gap**: Treat `isAvailable()` as a necessary-but-not-sufficient check; supplement with an actual embedding probe for health dashboards

## Procedure E: Agent Harness Cost Control Patterns

Implement systematic cost control and budget management across grove boundaries.

1. **Configure grove adaptive turn budget calibration**:
   ```typescript
   // In packages/myco/src/agent/harness/ components
   const groveAdaptiveBudget = baseBudget * modelMultiplier * complexityFactor * groveMultiplier;

   // Local model handling with grove awareness
   if (model.provider === 'local') {
     turnBudget *= 4; // Account for slower inference
   }

   // Grove coordination overhead
   if (session.requiresGroveCoordination) {
     turnBudget *= 1.2; // Account for coordination costs
   }
   ```

2. **Implement grove model selection via advisor pattern with model tier architecture**:
   - Route simple tasks to cheaper models within grove boundaries
   - Use performance models for complex reasoning across groves
   - Implement fallback chains for budget exhaustion with grove context
   - Consider grove coordination costs in model selection decisions
   - **Haiku-extract/Sonnet-consolidate pattern**: Use Haiku for low-overhead extraction (batch processing, spore generation), Sonnet for consolidation (semantic merges, wisdom synthesis)
   - **Write-first pipeline optimization**: Haiku reduces extraction costs; Sonnet at consolidation handles semantic complexity without repeated re-processing
   - **Per-stage model gating**: Match model tier to operation type—Haiku for high-volume single-pass work, Sonnet for multi-pass semantic tasks

3. **Add grove phase-level cost overrides**:
   - Allow per-phase budget adjustments based on grove historical data
   - Implement emergency budget increases for critical cross-grove operations
   - Track override usage patterns for grove budget recalibration
   - Account for grove coordination overhead in budget planning

4. **Prevent grove budget exhaustion cascades**:
   - Implement graceful degradation under budget pressure across groves
   - Reserve emergency budget for critical grove coordination operations
   - Add circuit breakers for runaway cost scenarios with grove boundaries
   - Coordinate budget constraints across groves through global daemon

5. **Monitor local vs cloud model cost tradeoffs with grove context**:
   - Track inference speed vs cost per operation across grove boundaries
   - Model total cost of ownership including grove coordination infrastructure
   - Optimize model selection based on workload characteristics and grove topology
   - Consider grove coordination latency in model placement decisions

## Procedure F: Map-Phase Cost Optimization

Optimize costs specifically for map-phase architectures with accelerator systems and grove coordination.

1. **Grove agent scoping optimization**:
   - Implement runtime agent scoping to minimize context overhead across groves
   - Use grove-scoped tool surfaces to reduce unnecessary cross-grove API calls
   - Cache agent configurations across map-phase iterations with grove context
   - Optimize grove coordination patterns in map-phase operations

2. **Grove adaptive scheduling with accelerator awareness and threshold calibration**:
   ```typescript
   // Configure tick-rate reality for accelerator systems with grove coordination
   const groveTickRate = acceleratorConfig.enabled
     ? acceleratorConfig.tickMs * groveCoordinationMultiplier
     : DEFAULT_TICK_RATE;

   // Adjust scheduling based on grove accelerator capacity
   if (groveAcceleratorQueue.length > GROVE_THRESHOLD) {
     scheduleConfig.backoffMs *= 2; // Reduce pressure across groves
   }

   // Accelerator threshold calibration: prevent low steady-state from locking accelerated mode
   const steadyThreshold = 15;  // Raise default from 5 to prevent persistent acceleration
   if (metrics.steady_state_cost < steadyThreshold) {
     acceleratorConfig.enabled = false;  // Disable accelerator in low-cost periods
   } else {
     acceleratorConfig.enabled = true;
   }
   ```
   - **Threshold trap**: Default steady threshold of 5 permanently triggers accelerated mode during normal operations
   - **Calibration guidance**: Set steady-state threshold >= 15 to avoid persistent acceleration cost overhead
   - **Cost modeling**: Accelerated mode multiplies costs; reserve it for genuine bottlenecks, not sustained operation

3. **Grove prompt caching benefits in map-phase**:
   - Leverage shared context across map iterations within grove boundaries
   - Cache expensive system prompts and grove-scoped skill definitions
   - Implement grove-aware context deduplication for repeated map operations
   - Use prompt caching to reduce token costs for similar operations across groves
   - Coordinate prompt cache invalidation across grove boundaries

4. **Grove cost-aware map-phase execution**:
   - Monitor per-iteration costs in map operations with grove attribution
   - Implement early termination for low-value iterations within grove scope
   - Balance parallelism vs cost in grove map-phase scheduling
   - Use grove-specific cost thresholds to gate expensive map expansions
   - Track cross-grove map coordination overhead separately

5. **Grove accelerator system cost modeling**:
   - Track costs per accelerator type and configuration across groves
   - Model cost impact of different map-phase patterns with grove coordination
   - Optimize grove accelerator usage based on cost-effectiveness metrics
   - Implement grove-aware cost-based accelerator selection policies
   - Account for cross-grove accelerator coordination costs

## Procedure G: Grove Architecture Cost Management

Optimize costs specifically for Grove's global daemon and multi-project architecture.

1. **Global daemon resource allocation across groves**:
   - Monitor global daemon resource usage across all managed groves
   - Implement fair-share scheduling for competing grove projects
   - Track per-grove and per-project cost attribution through global daemon
   - Optimize global daemon coordination patterns to minimize cross-grove overhead

2. **Multi-grove cost isolation and attribution**:
   ```typescript
   // In grove cost tracking
   const groveCosts = {
     grove_id: grove.id,
     project_costs: aggregateProjectCosts(grove.projects),
     coordination_overhead: calculateGroveCoordinationShare(grove.id),
     global_daemon_share: calculateGlobalDaemonShare(grove.id),
     total_cost: project_costs + coordination_overhead + global_daemon_share
   };
   ```

3. **MCP transport optimization with grove awareness**:
   - Leverage direct MCP connections eliminating HTTP loopback costs across groves
   - Monitor MCP tool call latency and throughput with grove context
   - Optimize MCP batch operations for cost efficiency across grove boundaries
   - Track grove-specific MCP usage patterns and coordination costs

4. **Grove config layering cost impact**:
   - Account for Grove-level vs project-level config resolution overhead
   - Optimize config caching for frequently accessed settings across groves
   - Monitor grove config resolution latency impact on task performance
   - Track config coordination costs between groves and global daemon

5. **Cross-grove coordination cost patterns**:
   - Monitor costs of cross-grove operations vs within-grove operations
   - Track global daemon coordination overhead by grove size and activity
   - Optimize grove topology for cost-efficient cross-grove collaboration
   - Implement grove-aware cost budgets and throttling policies

## Procedure H: Test Suite & Build Performance Optimization

Optimize test execution and build performance to reduce development cycle costs and infrastructure overhead.

1. **Implement measured-isolation test architecture**:
   ```bash
   # Use scripts/run-bun-tests.mjs for optimized test isolation
   # Group related test files into domain-scoped Bun processes
   ./scripts/run-bun-tests.mjs --domain agent-harness
   ./scripts/run-bun-tests.mjs --domain daemon-core

   # Avoid expensive per-file isolation for related tests
   # Balance: test independence vs execution speed
   ```

2. **Domain-scoped test process management**:
   - **Agent harness tests**: Group all harness-related tests in one Bun process
   - **Daemon core tests**: Isolate daemon core tests for state management safety
   - **Utility/helper tests**: Bundle small utility tests to reduce process overhead
   - **Integration tests**: Keep integration tests isolated but exclude flaky tests from performance builds

3. **Build profile optimization strategies**:
   ```typescript
   // In build configuration
   const buildProfiles = {
     performance: {
       excludePatterns: [
         '**/flaky-integration/**',
         '**/slow-integration/**'
       ],
       testIsolation: 'domain-scoped',
       parallelism: 'high'
     },
     comprehensive: {
       includeAll: true,
       testIsolation: 'per-file',
       parallelism: 'medium'
     }
   };
   ```

4. **Test execution cost modeling**:
   - **Isolation overhead**: Measure cost of process spawning vs test parallelism benefits
   - **Domain boundary optimization**: Find optimal test grouping for fastest execution
   - **CI/CD resource allocation**: Balance test thoroughness vs build speed requirements
   - **Developer feedback loop**: Optimize local test execution for rapid iteration

5. **Performance regression detection**:
   - **Baseline test execution times**: Track test suite performance over time
   - **Isolation boundary effectiveness**: Monitor 20% improvement target from measured-isolation
   - **Build profile impact**: Compare performance vs comprehensive build outcomes
   - **Resource utilization tracking**: Monitor CPU/memory usage during test execution

## Cross-Cutting Gotchas

- **Never ignore settingSources overhead** — Claude SDK makes expensive config calls unless explicitly disabled with `settingSources: []`
- **Session state gating is critical** — Running expensive intelligence tasks on active sessions produces stale artifacts and wastes budget
- **Local model budgets need 3-4× multipliers** — They're slower but cheaper per token; budget for the time difference
- **Tool emission ceilings hit before token budgets** — Monitor tool usage patterns, not just token consumption; improved telemetry now tracks this accurately
- **No-op detection prevents cost burn** — Always check if work is actually needed before starting expensive operations
- **KV-cache reuse patterns vary by SDK** — OpenAI SDK can be 15× faster than Claude SDK for similar workloads due to better caching
- **Mechanical drift detection beats expensive verification** — File fingerprinting and structural analysis costs cents vs. dollars for LLM verification phases
- **Map-phase context sharing is cost-critical** — Proper prompt caching in map architectures can reduce costs by 60-80% for repeated operations
- **Cadence defaults are a cost trap** — 5-minute intervals cost 72× more than 6-hour intervals; verify cadence settings before deploying intelligence tasks
- **Accelerator threshold calibration is critical** — Default threshold of 5 permanently locks accelerated mode during normal work; raise to ≥15 to prevent cost multiplication
- **Haiku-extract/Sonnet-consolidate pattern reduces costs** — Use cheaper Haiku for high-volume extraction, Sonnet only for multi-pass semantic work
- **Origin filtering prevents system batch noise** — System-generated batches account for ~11% telemetry noise; exclude them from cost attribution
- **Agent scoping overhead scales with map size** — Large map operations require careful agent scope management to prevent context bloat
- **Grove coordination has measurable overhead** — Multi-grove environments need cost attribution and coordination overhead tracking
- **Direct MCP transport eliminates loopback costs** — New transport architecture removes HTTP overhead but requires grove-aware optimization patterns
- **Grove config layering affects performance** — Grove's multi-level config system adds resolution overhead that impacts high-frequency operations
- **Cross-grove costs compound quickly** — Operations spanning multiple groves have multiplicative coordination costs; prefer within-grove operations when possible
- **Global daemon cost attribution is complex** — Fair-share resource allocation across groves requires careful cost modeling and attribution
- **Grove coordination delays affect budget burn** — Cross-grove coordination latency can cause budget exhaustion before task completion; account for coordination overhead in budget planning
- **Test isolation boundaries are performance-critical** — Measured-isolation provides 20% performance improvement over naive per-file isolation; domain-scoped processes balance safety and speed
- **Build profile selection impacts development velocity** — Performance profiles exclude flaky tests for speed; comprehensive profiles include everything for thorough validation
- **Tool call telemetry accuracy matters** — Undercounting tool calls leads to incorrect budget allocation; ensure telemetry captures all tool emissions accurately
- **JobRunner drain starvation is real** — A single slow job (e.g., release-provenance reconciler averaging 348s) blocks all other jobs in the serial tick loop; always declare a `DrainSpec` with bounded `slice` and `softDeadlineMs` on expensive jobs to limit per-tick work
- **`isAvailable()` on local embedding providers is not reliable alone** — Brew-stub installations return `true` without a running service; probe actual connectivity before treating the embedding provider as up
- **Hubness recomputation is O(N²) and yields between chunks to avoid event-loop lag**: `computeHubnessStats` in `packages/myco/src/daemon/embedding/sqlite-vec-store.ts` performs a KNN query for every vector against all others (O(N²)). The implementation chunks work in batches of 32 rows with `setImmediate` yields between chunks to keep event-loop latency below 200ms. At ~870 spores this produces ~28 yields. For vaults growing past a few thousand spores, hubness recomputation becomes a meaningful background CPU cost — it is triggered automatically by `EmbeddingManager` after embedding updates.
- **Ref-movement gate makes release-provenance reconciliation near-free when refs are static**: `reconcileReleaseProvenance` (`packages/myco/src/release-provenance/reconcile.ts`) skips the expensive classify+patch-scan for any row already holding a `synced_at` classification when no configured ref has moved (`refsChanged = false`). This provides dramatic cost reduction on idle projects. If reconciler cost appears disproportionately high, confirm the gate is functioning by checking that `refsFingerprint` is stable across consecutive runs.
