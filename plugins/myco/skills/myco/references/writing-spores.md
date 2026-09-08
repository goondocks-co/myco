# Writing a spore worth keeping

A spore is an observation that survives the session that produced it. The test is simple: would someone six months from now, who never saw this session, be glad it exists?

## Search before you write

If a spore already covers the ground, supersede it. Two near-duplicates are worse than one stale entry, because the reader has to work out which is current and nothing tells them.

## The two kinds that earn their place

**A gotcha names the trap and the tell.** The trap alone is a war story; the tell is what makes it useful, because it is what the next person will actually see.

> Weak: "The test suite is flaky."
>
> Strong: "Running the agent suite directly instead of through the test driver fails about 486 tests. The tell is that they fail on module resolution rather than assertions — the driver swaps the runtime config per phase, and nothing else does."

**A decision names the alternative it rejected.** A decision without its alternatives reads as an arbitrary preference, and the next person re-litigates it.

> Weak: "We use one directory for the plugin bundle."
>
> Strong: "One plugin directory carries every client's manifest over a shared skills tree. The alternative, a directory per client, duplicates the skills and lets the config prompts drift independently — which is the failure the single generator exists to prevent. Cost: one manifest filename collides across two clients and has to be reconciled."

## What does not belong

- **Status.** "Finished the parser" is true for a day.
- **Anything the code already says.** A function's signature is not an observation.
- **Anything git already says.** Who changed what, when.
- **Session-local detail.** The path of a scratch file, the id of a run.

## Shape

Write for a reader who has the codebase open and no memory of the work. Name files, functions and errors so they can navigate. Say what is true now, not the story of how it was discovered — the reasoning belongs in the observation, the narrative does not.

Keep one idea per spore. A spore that carries three findings is one nobody can supersede without losing the other two.
