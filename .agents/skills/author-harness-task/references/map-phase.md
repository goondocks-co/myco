# Map-Phase Architecture

Reference material for the `author-harness-task` skill.

# Procedure 1.1: Map-Phase Architecture

Use `mode: map` for bulk operations with identical per-item logic. The harness owns batch fetch and iteration; the model invokes once per item with constrained tools.

## When to use map mode

**Ideal for:** Bulk operations with identical per-item processing, cost-sensitive batch work.
**Not suitable for:** Cross-item reasoning, operations requiring dynamic tool selection, phases needing full batch context.

## Map-phase configuration

```ts
{
  name: 'process_items',
  mode: 'map',
  systemPrompt: ITEM_PROCESSING_PROMPT,
  turnBudget: 3,
  tools: ITEM_TOOLS,
  fetchConfig: {
    tool: 'canopy_get_entries',
    params: { limit: 20, types: ['file'] },
    itemField: 'entries',
    emptySkip: true,
  },
}
```

## Advanced debugging and optimization

**Contract violations**: Map-phase harness strips sink_schema and injects argMap. Phase handlers checking `args.sink_schema` will fail.

**Accelerator configuration** and **Cost optimization** patterns implemented for long-running operations.

**Runtime optimization**: Agent instance pooling, tool surface templates, resource monitoring.

**Fault tolerance**: Retry mechanisms with exponential backoff and error classification.
