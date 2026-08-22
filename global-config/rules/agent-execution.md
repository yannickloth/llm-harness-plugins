<!-- Change Driver: UX_REQUIREMENTS -->
<!-- Changes when: agent-execution visibility/output expectations shift -->
<!-- Lazy-loaded reference file — load on demand when running/monitoring agents or evaluating agent output. Not injected by default. -->

# Agent Execution Visibility

Visibility > execution mode. User priority: knowing what's happening.

| Rule | Detail |
|------|--------|
| Real-time updates | always; foreground or background |
| Background agents | monitor with tail on output file |
| Report key milestones | "Now analyzing chapter 6…", "Found 3 candidates…" |
| Never fire-and-forget | no unmonitored background tasks |

# Agent Output Quality

Every agent MUST produce usable output. Silent completion ✗.

| ✓ Acceptable | ✗ Unacceptable |
|--------------|----------------|
| Direct output in response | Completes silently |
| File path to stored results | Says "done" without showing what was done |
| Modified files (report which changed) | Output produced without reporting where it is |
| Status/summary of completed action | |
