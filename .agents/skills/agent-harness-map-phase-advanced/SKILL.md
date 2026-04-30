---
name: myco:agent-harness-map-phase-advanced
description: |
  Advanced implementation patterns for Myco's agent harness map-phase architecture.
  Covers debugging contract violations, sink schema construction, accelerator systems,
  runtime scoping optimizations, cost models, fault tolerance, and workflow integration.
  Use when implementing complex map-phase operations, debugging harness issues, or
  optimizing bulk agent task performance, even if the user doesn't explicitly ask
  for map-phase implementation guidance.
managed_by: myco
user-invocable: true
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# Agent Harness Map-Phase Advanced Implementation

Advanced implementation patterns for Myco's agent harness map-phase architecture. Use this when building complex map-phase operations that require debugging contract violations, optimizing performance, or integrating with custom accelerator systems.

## Prerequisites

- Basic understanding of Myco's agent harness architecture and standard phase workflows
- Familiarity with task YAML structure in `packages/myco/src/agent/definitions/tasks/`
- Access to agent harness source code in `packages/myco/src/agent/`
- Understanding of map-phase vs standard phase execution models

## Procedure 1: Debug Map-Phase Contract Violations

When map-phase operations fail with contract violations or unexpected behavior:

1. **Check sink schema compatibility**:
   ```bash
   # Examine the sink schema in your task definition
   cat packages/myco/src/agent/definitions/tasks/your-task.yaml | grep -A 10 "sink:"
   ```

2. **Verify argMap injection and schema stripping**:
   - Map-phase harness strips sink schema and injects argMap automatically
   - Check that your phase handler doesn't expect sink_schema in args
   - Validate that argMap contains expected iteration variables
   - **Common bug**: Phase handlers that check for `args.sink_schema` will fail in map mode

3. **Debug abort controller and outcome latching**:
   ```javascript
   // Check for proper abort controller propagation
   if (abortController.signal.aborted) {
     throw new Error('Operation aborted');
   }
   
   // Verify sink outcome latching isn't premature
   // Sink should only latch after ALL iterations complete
   ```

4. **Examine wrapped tool surface**:
   - Map-phase creates a wrapped tool surface for each iteration
   - Tools are scoped to prevent cross-iteration interference
   - Check tool call logs for unexpected scope violations
   - **Common issue**: Stateful tools bleeding between iterations

5. **Debug TaskParams threading patterns**:
   ```typescript
   // Verify TaskParams are properly threaded through map iterations
   interface MapIterationParams {
     taskParams: TaskParams; // Must be preserved from parent
     iterationIndex: number;
     argMap: Record<string, any>;
     // sink_schema is intentionally absent
   }
   ```

6. **Debug with harness logging**:
   ```bash
   # Enable detailed harness logging
   DEBUG=myco:harness:map npm run daemon
   ```

7. **Validate batch composition**:
   - Ensure input items match expected schema for map operations
   - Check for malformed or incomplete iteration data
   - Verify that batch boundaries align with logical operation units

## Procedure 2: Configure Accelerator and Scheduler Systems

For adaptive cadence and performance optimization:

1. **Design accelerator strategy**:
   - Determine if your map operation benefits from adaptive batching
   - Consider I/O patterns, LLM cost, and parallelization constraints
   - Plan for ramp-up, steady-state, and error recovery phases

2. **Implement scheduler configuration**:
   ```yaml
   # In your task YAML
   phases:
     - name: process_items
       mode: map
       accelerator:
         strategy: adaptive
         initial_batch_size: 5
         max_batch_size: 20
         ramp_factor: 1.5
         backoff_on_error: true
         success_threshold: 0.85
   ```

3. **Debug accelerator bugs**:
   - **Counter scan issues**: Verify accelerator counters don't overflow during long operations
   - **Config schema validation**: Ensure accelerator config matches expected schema
   - **Callback stalls**: Check for deadlocks in accelerator callback chains
   ```javascript
   // Common accelerator debugging pattern
   if (acceleratorState.pendingCallbacks > maxCallbacks) {
     console.warn('Potential callback stall detected');
     // Implement callback timeout and recovery
   }
   ```

4. **Monitor and tune performance**:
   - Watch for batch size oscillation (indicates poor tuning)
   - Monitor LLM token costs vs latency trade-offs
   - Adjust ramp_factor based on actual workload characteristics
   - Set appropriate success_threshold to balance speed vs quality

5. **Handle scheduler state transitions**:
   - Implement proper state persistence for long-running operations
   - Design graceful recovery from scheduler crashes
   - Plan for manual intervention points during optimization

## Procedure 3: Optimize Runtime Agent Scoping

For performance and resource management:

1. **Implement agent instance pooling**:
   - Reuse agent instances across map iterations when safe
   - Consider state isolation requirements between iterations
   - Balance memory usage vs initialization overhead
   - Monitor for memory leaks in long-running pools

2. **Debug runtime adapter regressions**:
   ```typescript
   // Check for runtime adapter state corruption
   if (runtimeAdapter.isStale()) {
     await runtimeAdapter.refresh();
   }
   
   // Verify adapter scoping doesn't leak between iterations
   const scopedAdapter = runtimeAdapter.createIterationScope(iterationId);
   ```

3. **Configure tool surface optimization**:
   - Strip unnecessary tools from map-phase iterations
   - Use tool surface templates for consistent scoping across iterations
   - Implement lazy tool loading for large tool sets
   - Cache tool configurations to reduce setup overhead

4. **Design batch sizing strategies**:
   ```javascript
   // Cost-aware batch sizing logic
   function calculateOptimalBatchSize(inputSize, costModel) {
     const memoryConstraint = Math.floor(availableMemory / avgItemMemory);
     const costConstraint = Math.floor(maxBatchCost / estimatedItemCost);
     const latencyConstraint = Math.min(inputSize, maxBatchLatency);
     
     return Math.min(memoryConstraint, costConstraint, latencyConstraint);
   }
   ```

5. **Implement resource monitoring**:
   - Track memory usage per agent instance
   - Monitor CPU utilization during parallel operations
   - Alert on resource exhaustion before failures occur

## Procedure 4: Implement Cost Models and Optimization

For efficient resource utilization:

1. **Design cost-aware batch composition**:
   ```javascript
   // Group items by estimated processing cost
   const batchGroups = items.reduce((groups, item) => {
     const costTier = estimateProcessingCost(item);
     groups[costTier] = groups[costTier] || [];
     groups[costTier].push(item);
     return groups;
   }, {});
   ```

2. **Implement adaptive pricing strategies**:
   - Monitor token consumption patterns across iterations
   - Adjust batch sizes based on cost efficiency metrics
   - Implement circuit breakers for unexpectedly expensive operations
   - Track cost per successful operation for optimization feedback

3. **Optimize for different cost models**:
   - **Token-based**: Minimize context switching and prompt overhead
   - **Time-based**: Maximize parallelization within rate limits
   - **Memory-based**: Balance batch size with instance reuse
   - **API quota**: Spread load across time windows

4. **Leverage provider metadata consolidation**:
   - Use consolidated provider metadata to optimize model selection across iterations
   - Cache provider configurations to avoid repeated API calls (600x+ speedup observed)
   - Implement efficient provider switching logic for cost optimization
   - Monitor provider availability and automatically failover to alternatives

## Procedure 5: Implement Fault Tolerance Patterns

For robust map-phase operations:

1. **Design retry strategies**:
   ```yaml
   # In your task YAML
   phases:
     - name: process_items
       mode: map
       retry:
         max_attempts: 3
         backoff: exponential
         base_delay: 1000
         jitter: true
         recoverable_errors: ["rate_limit", "timeout", "temporary_failure"]
         permanent_errors: ["auth_error", "invalid_input"]
   ```

2. **Handle partial failures gracefully**:
   - Implement checkpoint/resume for large maps to avoid losing progress
   - Design idempotent operations where possible
   - Plan for graceful degradation on systematic failures
   - Preserve partial results for manual recovery

3. **Implement failure isolation**:
   - Contain failures to individual iterations without affecting the batch
   - Implement circuit breakers for cascading failure prevention
   - Design fallback strategies for critical path operations

4. **Monitor and alerting**:
   - Track success rates per batch and over time
   - Alert on sustained failure patterns or error rate spikes
   - Log detailed context for debugging failed iterations
   - Implement automated recovery triggers for known failure modes

## Procedure 6: Integrate with Standard Phase Workflows

For seamless phase transitions:

1. **Design phase boundary contracts**:
   - Ensure map output format matches downstream phase expectations
   - Plan for aggregation and consolidation in subsequent phases
   - Handle empty or partial map results gracefully in the workflow
   - Define clear error propagation semantics

2. **Manage state transitions**:
   ```yaml
   # State preservation pattern
   phases:
     - name: map_process
       mode: map
       outputSchema:
         successful_items: array
         failed_items: array
         iteration_context:
           batch_stats: object
           performance_metrics: object
           error_summary: object
   ```

3. **Handle exception scenarios**:
   - Define behavior for empty input sets (should subsequent phases run?)
   - Plan for rate limit scenarios that affect the entire operation
   - Implement graceful shutdown on resource exhaustion
   - Design recovery strategies for mid-operation failures

4. **Implement workflow checkpointing**:
   - Persist intermediate state at logical boundaries
   - Enable resumption from the last successful checkpoint
   - Design checkpoint data to be human-readable for debugging

## Procedure 7: Harness-Ready Architecture Integration

For modern harness-ready agent implementations:

1. **Implement Pi integration patterns**:
   - Design agent implementations that integrate with the central harness registry
   - Use durable state contracts for reliable agent lifecycle management
   - Implement proper agent scoping and resource cleanup
   - Follow Pi conceptual framework for agent architecture consistency

2. **Leverage central harness registry**:
   - Register agent implementations in the central harness for discoverability
   - Use registry-based agent resolution for dynamic task assignment
   - Implement proper agent metadata for harness optimization
   - Design agents for composability within the harness ecosystem

3. **Implement durable state contracts**:
   - Design state persistence that survives agent restarts and failures
   - Use contract-based state management for predictable recovery
   - Implement state validation and migration patterns
   - Design for state consistency across distributed agent operations

4. **Apply efficiency improvements**:
   - Implement config caching patterns to reduce initialization overhead
   - Use migration efficiency patterns for smooth state transitions
   - Optimize provider metadata access for faster agent startup
   - Design for minimal resource consumption during idle periods

## Cross-Cutting Implementation Gotchas

- **Sink schema stripping**: Map-phase harness automatically removes sink_schema from phase args and replaces it with argMap. Don't expect sink_schema to be present in your phase handler. Phase handlers that check `if (args.sink_schema)` will always fail in map mode.

- **Abort controller propagation**: Ensure abort controllers are properly threaded through all map iterations. Premature abort signal handling can cause incomplete results or resource leaks.

- **Sink outcome latching**: Outcomes should only latch after ALL map iterations complete, not after individual iterations. Early latching causes incomplete results.

- **TaskParams threading**: TaskParams must be preserved and passed through each map iteration. Missing TaskParams cause downstream phase failures.

- **Tool surface wrapping**: Each map iteration gets its own wrapped tool surface. Tools that maintain state between calls may behave unexpectedly across iterations.

- **Runtime adapter scope isolation**: Runtime adapters must be properly scoped per iteration to prevent state bleeding. Stale adapters cause unpredictable behavior.

- **Accelerator counter overflow**: Long-running accelerators can overflow internal counters. Implement counter resets and bounds checking.

- **Callback stall detection**: Monitor accelerator callback chains for deadlocks. Implement timeouts and circuit breakers.

- **Memory accumulation**: Long-running map phases can accumulate memory in agent instances. Monitor and restart instances periodically for large maps.

- **Rate limit amplification**: Map phases can hit API rate limits much faster than standard phases. Always implement backoff and consider your API quota when sizing batches.

- **Error context loss**: Failed iterations may lose important context. Always log sufficient information to reproduce and debug failures offline.

- **Cost explosion**: Poorly configured accelerators can lead to exponential cost growth. Always set maximum cost bounds and monitor spending in real-time.

- **Provider metadata staleness**: Cached provider configurations can become stale over time. Implement refresh mechanisms and validate provider availability before use.

- **State contract violations**: Durable state implementations must strictly adhere to defined contracts. Contract violations can cascade through the entire harness system.