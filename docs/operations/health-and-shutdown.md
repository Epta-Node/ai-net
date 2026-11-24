# Health Checks and Graceful Shutdown

## Probe Contract

| Probe | Purpose | Expected status |
| --- | --- | --- |
| `GET /health` or `GET /health/live` | Process liveness. Returns without checking dependencies. | `200` while the process can answer HTTP |
| `GET /health/ready` | Readiness for serving traffic. Checks local task and payment stores. | `200` when ready, `500` when local stores fail |
| `GET /health/deep` or `GET /health/dependencies` | Dependency probes for Venice AI and Stellar Horizon. | `200` when all dependencies are reachable, `503` when degraded |

Readiness should be removed from load balancers before shutdown starts. Liveness should remain successful until the process is ready to exit so supervisors do not hard-kill the server during drain.

## Shutdown Order

1. Stop accepting new HTTP and websocket connections.
2. Stop registry sync and recurring background workers.
3. Mark running tasks as failed or interrupted with a durable reason.
4. Mark online agents offline so stale capacity is not advertised.
5. Flush logs, metrics, and reconciliation state.
6. Close task, agent, payment, and queue databases.

`GRACEFUL_SHUTDOWN_TIMEOUT` bounds the full drain. Production deployments should set the platform termination grace period higher than this value.

## Operator Checks

- Confirm `/health/ready` returns non-200 before terminating an instance during rolling deploys.
- Confirm `/health/deep` reports both `venice` and `horizon` as `ok` before enabling traffic.
- Review shutdown logs for each phase when debugging interrupted task execution.
