# ADR-004: DAG-Based Task Decomposition

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** @Epta-Node/core

## Context

When a user submits a complex request (e.g. "research topic X, then write a
report, then design a visual summary"), the coordinator must break it into
sub-tasks and orchestrate their execution across multiple agents. Two models
were considered:

1. **Queue-based sequential execution**: sub-tasks enter a FIFO queue and are
   processed one at a time.
2. **DAG-based parallel execution**: sub-tasks are represented as nodes in a
   directed acyclic graph; edges encode dependencies; nodes with no outstanding
   dependencies run in parallel.

## Decision

Use a **Directed Acyclic Graph (DAG)** to represent workflows. Each `Task`
record has a `dag: DAGNode[]` field where each `DAGNode` lists its
dependencies. The coordinator resolves and dispatches nodes as their
dependencies complete.

Relevant code: `backend/src/coordinator/dag.ts` and the `DAGNode` type in
`backend/src/types/task.ts`.

DAG was chosen over simple sequential queuing because:
1. **Parallelism**: independent sub-tasks (e.g. a research step and a risk
   analysis step with no data dependency) can run concurrently, reducing
   end-to-end latency significantly.
2. **Explicit dependency tracking**: a DAG makes the dependency structure
   visible in the data model; debugging a stuck workflow means inspecting the
   graph, not searching log timestamps.
3. **Partial retries**: when a single node fails, only it (and its dependents)
   need to be retried; completed nodes are not re-run.
4. **Extensibility**: adding a new sub-task type is a matter of inserting a new
   node with the correct edges; the scheduling logic is unchanged.

## Consequences

**Positive:**
- Multi-step workflows complete significantly faster due to parallelism.
- Dependency violations are caught at plan time (cycle detection), not at
  runtime.
- The DAG is serialised to JSON in the `tasks` table, making it inspectable
  via the admin UI and the `/api/tasks/:id` endpoint.

**Negative / trade-offs:**
- The coordinator's DAG planner adds complexity vs a simple queue; bugs in
  cycle detection or dependency resolution are subtle.
- Parallel execution increases the number of concurrent outbound HTTP requests
  to agent nodes; backpressure/rate-limiting logic is required.
- DAG serialisation format must be versioned carefully to avoid breaking
  in-flight tasks during deployments.
