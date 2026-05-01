---
name: myco:cost-optimization-performance-telemetry
description: |
  Comprehensive procedures for analyzing, optimizing, and monitoring LLM costs and performance in Myco's agent harness system. Covers cost leak identification, performance bottleneck analysis, resource allocation optimization, SDK execution telemetry, and budget calibration patterns. Use when investigating cost spikes, optimizing agent task efficiency, calibrating turn budgets, or implementing cost control measures, even if the user doesn't explicitly ask for cost optimization analysis.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Cost Optimization & Performance Telemetry

Systematic procedures for analyzing, optimizing, and monitoring LLM costs and performance in Myco's agent harness system. Essential for maintaining cost efficiency as new tasks are added, model providers evolve, and workload scales.

## Prerequisites

- Understanding of Myco's agent harness architecture (`packages/myco/src/agent/`, `packages/myco/src/agent/definitions/tasks/`)
- Access to task logs and cost telemetry data
- Familiarity with model provider APIs (Claude SDK, OpenAI, local models)
- Knowledge of turn budget configuration in task definitions
- Understanding of map-phase architecture and accelerator systems

## Procedure A: LLM Cost Analysis & Budget Calibration

Identify cost leak patterns and calibrate budgets for sustainable operation.

1. **Analyze cost leak patterns**:
   - Check for Claude SDK overhead: Look for 25k+ token requests in logs where actual content is minimal
   - Monitor vault-evolve cadence: Identify no-op runs burning $158/day
   - Review tool invocation costs vs token throughput ratios
   - Examine settingSources configuration causing unnecessary API calls

2. **Calibrate task budgets**:
   ```yaml
   # In packages/myco/src/agent/definitions/tasks/*.yaml
   phases:
     analyze: 
       turnBudget: 15  # Start conservative
     optimize: 
       turnBudget: 25  # Scale based on complexity
   ```

3. **Model cost-per-operation baselines**:
   - Document typical token consumption for each task type
   - Calculate cost-per-spore extraction, cost-per-session summary
   - Establish performance vs cost trade-off curves by model class

4. **Implement cost kill switches**:
   - Add `settingSources: []` in `packages/myco/src/agent/harness/claude.ts` where appropriate
   - Use early termination conditions in expensive loops
   - Gate expensive operations behind session-terminal checks

5. **Replace expensive verification with mechanical drift detection**:
   - **Pattern**: Replace LLM-based verification phases with file system drift detection to reduce costs
   - **Example**: skill-evolve moved from 15-minute verification cycles (expensive LLM fact-checking) to 6-hour mechanical drift detection
   - **Implementation**: Use file fingerprinting and structural analysis instead of full content verification
   - **Cost impact**: Prevents $158/day burn from no-op verification runs

## Procedure B: Performance Bottleneck Identification

Prioritize optimization efforts based on runtime dominance analysis.

1. **Profile model inference vs system overhead**:
   - Measure actual model API call time vs tool execution time
   - Identify when runtime is model-dominated vs system-dominated
   - Focus optimization on the dominant cost component

2. **Compare SDK execution patterns**:
   ```bash
   # Profile different SDK approaches
   time node -e "// Claude SDK test"
   time node -e "// OpenAI SDK test"
   # Look for 15× performance differences via KV-cache reuse
   ```

3. **Analyze tool emission ceiling**:
   - Monitor tool calls per turn and cumulative emissions
   - Identify tasks hitting tool emission limits before budget limits
   - Optimize tool usage patterns to stay within efficient ranges

4. **Document optimization priorities**:
   - Runtime optimization takes precedence when model-dominated
   - Token throughput optimization for system-dominated workloads
   - Tool consolidation for emission-ceiling cases

## Procedure C: Cost-Effective Scheduling & Resource Allocation

Optimize task cadence and resource allocation patterns.

1. **Calibrate task cadence**:
   - Set longer intervals for expensive intelligence tasks
   - Implement back-off for no-change scenarios
   - Use session-terminal gating for costly operations:
   ```typescript
   if (session.status !== 'terminal') {
     throw new Error('Session not terminal - skipping expensive analysis');
   }
   ```

2. **Configure idle/sleep mode resource allocation**:
   - Reduce polling frequencies during inactive periods
   - Pause expensive background tasks when no new data
   - Implement progressive back-off for repeated no-ops

3. **Optimize turn budget by model class**:
   ```yaml
   # In task configuration files
   turnBudgetMultipliers:
     local: 4     # Local models need 3-4× budget
     claude: 1    # Baseline
     gpt: 1.2     # Slight increase for context handling
   ```

4. **Implement session-gating for expensive tasks**:
   - Gate skill-survey, full-intelligence on terminal sessions only
   - Prevent stale artifact generation from active sessions
   - Add session state validation before expensive operations

## Procedure D: SDK Execution Telemetry & Monitoring

Implement comprehensive cost and performance tracking.

1. **Set up multi-provider runtime tracking**:
   ```typescript
   // Add to agent harness in packages/myco/src/agent/runtime/
   const costTracker = {
     provider: 'claude',
     tokensIn: request.tokens,
     tokensOut: response.tokens,
     cost: calculateCost(provider, tokensIn, tokensOut),
     latency: Date.now() - startTime
   };
   ```

2. **Implement phase-level cost attribution**:
   - Track costs per task phase (extract, analyze, consolidate)
   - Monitor cumulative costs across task runs
   - Alert on phase-level budget overruns

3. **Monitor agent harness operational correctness**:
   - Track task completion rates vs budget exhaustion
   - Monitor error rates by task type and model
   - Measure quality degradation under budget pressure

4. **Implement resource isolation monitoring**:
   - Track memory and CPU usage per task phase
   - Monitor concurrent task interference patterns
   - Validate phased executor resource boundaries

## Procedure E: Agent Harness Cost Control Patterns

Implement systematic cost control and budget management.

1. **Configure adaptive turn budget calibration**:
   ```typescript
   // In packages/myco/src/agent/ components
   const adaptiveBudget = baseBudget * modelMultiplier * complexityFactor;
   
   // Local model handling
   if (model.provider === 'local') {
     turnBudget *= 4; // Account for slower inference
   }
   ```

2. **Implement model selection via advisor pattern**:
   - Route simple tasks to cheaper models
   - Use performance models for complex reasoning
   - Implement fallback chains for budget exhaustion

3. **Add phase-level cost overrides**:
   - Allow per-phase budget adjustments based on historical data
   - Implement emergency budget increases for critical phases
   - Track override usage patterns for budget recalibration

4. **Prevent budget exhaustion cascades**:
   - Implement graceful degradation under budget pressure
   - Reserve emergency budget for critical operations
   - Add circuit breakers for runaway cost scenarios

5. **Monitor local vs cloud model cost tradeoffs**:
   - Track inference speed vs cost per operation
   - Model total cost of ownership including infrastructure
   - Optimize model selection based on workload characteristics

## Procedure F: Map-Phase Cost Optimization

Optimize costs specifically for map-phase architectures with accelerator systems.

1. **Agent scoping optimization**:
   - Implement runtime agent scoping to minimize context overhead
   - Use scoped tool surfaces to reduce unnecessary API calls
   - Cache agent configurations across map-phase iterations

2. **Adaptive scheduling with accelerator awareness**:
   ```typescript
   // Configure tick-rate reality for accelerator systems
   const tickRate = acceleratorConfig.enabled 
     ? acceleratorConfig.tickMs 
     : DEFAULT_TICK_RATE;
   
   // Adjust scheduling based on accelerator capacity
   if (acceleratorQueue.length > THRESHOLD) {
     scheduleConfig.backoffMs *= 2; // Reduce pressure
   }
   ```

3. **Prompt caching benefits in map-phase**:
   - Leverage shared context across map iterations
   - Cache expensive system prompts and skill definitions
   - Implement context deduplication for repeated map operations
   - Use prompt caching to reduce token costs for similar operations

4. **Cost-aware map-phase execution**:
   - Monitor per-iteration costs in map operations
   - Implement early termination for low-value iterations
   - Balance parallelism vs cost in map-phase scheduling
   - Use cost thresholds to gate expensive map expansions

5. **Accelerator system cost modeling**:
   - Track costs per accelerator type and configuration
   - Model cost impact of different map-phase patterns
   - Optimize accelerator usage based on cost-effectiveness metrics
   - Implement cost-aware accelerator selection policies

## Cross-Cutting Gotchas

- **Never ignore settingSources overhead** — Claude SDK makes expensive config calls unless explicitly disabled with `settingSources: []`
- **Session state gating is critical** — Running expensive intelligence tasks on active sessions produces stale artifacts and wastes budget
- **Local model budgets need 3-4× multipliers** — They're slower but cheaper per token; budget for the time difference
- **Tool emission ceilings hit before token budgets** — Monitor tool usage patterns, not just token consumption
- **No-op detection prevents cost burn** — Always check if work is actually needed before starting expensive operations
- **KV-cache reuse patterns vary by SDK** — OpenAI SDK can be 15× faster than Claude SDK for similar workloads due to better caching
- **Mechanical drift detection beats expensive verification** — File fingerprinting and structural analysis costs cents vs. dollars for LLM verification phases
- **Map-phase context sharing is cost-critical** — Proper prompt caching in map architectures can reduce costs by 60-80% for repeated operations
- **Accelerator tick-rate reality affects cost modeling** — Real-world accelerator performance varies significantly from configuration; measure actual costs not theoretical ones
- **Agent scoping overhead scales with map size** — Large map operations require careful agent scope management to prevent context bloat