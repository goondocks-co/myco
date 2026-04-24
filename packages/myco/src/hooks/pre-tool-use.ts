// Stub — real implementation lands in Track B (Canopy injection).
// Phase 0 registers this so the CLI dispatcher doesn't throw on the hook
// name once symbiont hook templates begin registering PreToolUse.
export async function main(): Promise<void> {
  // No-op by default. Track B replaces this with the injection handler.
}
