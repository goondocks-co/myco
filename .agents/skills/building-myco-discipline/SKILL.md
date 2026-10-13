---
name: building-myco-discipline
description: Build non-trivial Myco changes with explicit ownership, structural invariants, contract tests and isolated runtime evidence.
---

# Build Myco changes

Read `AGENTS.md` and `docs/architecture/myco-2.0.md` before choosing a runtime owner. Search Myco for the decision behind unfamiliar structure.

1. Identify the owner. Deployment core owns Project state, processing, MCP and schedules; member capabilities own routing, capture spools and machine state; registered runners own harness execution.
2. Route every shared-state mutation through its existing capability. Create an owner before adding a second writer. One operation has one implementation across CLI, UI and MCP.
3. Encode invariants structurally. Run guards before mutations, hold leases across the whole operation, and return fresh reads even for empty inputs.
4. Before removing validation or recovery, identify the input or state it defends against and where the equivalent defense remains. Audit deleted suites for pins used by surviving surfaces.
5. Pin observable contracts: input, status, named error and response shape. Cover refusal and rightful admission together. Use property tests for multi-file invariants and mutation tests for architectural gates.
6. Start with focused tests, then run `make build` and smoke-test the changed behavior through the compiled binary in an isolated scratch home. Exercise native/D1 parity when shared server behavior changes.
7. Run the `code-review` skill before completion. Triage its Standards and Spec findings, fix confirmed issues, and review those fixes.

Use `myco-settings` for Deployment settings, `debug-capture` for capture diagnosis, and `dogfood-worktree` for worktree runtime pins. Test service lifecycle through injected runners; isolate every harness home and stop only processes you started.
