# Backend performance regression suite

The suite measures API throughput/latency, queue throughput (including the
dead-letter path), and database query latency against committed budgets. It
runs in-process against a temporary SQLite directory so it needs no external
services.

```bash
npm run perf          # compare against budgets + baselines, exit 1 on regression
npm run perf:update   # refresh baselines/latest.json from a verified run
```

`npm run perf` finishes in under three minutes and prints a tabular report. It
also writes `test-results/performance/report.json` and `report.md`; CI uploads
both as an artifact.

## Interpreting the report

Each row shows the measured value, its budget, the committed baseline, the
allowed limit, and PASS/FAIL:

- Throughput metrics are `min`: the limit is `max(budget, baseline) * 0.9`.
- Latency and duration metrics are `max`: the limit is `min(budget, baseline) * 1.1`.

A 10% tolerance is applied in the forgiving direction: throughput may dip 10%
and latency may rise 10%. For example, `POST /api/tasks p95LatencyMs` has a
budget of 200 ms and fails above 220 ms. Connection errors or non-2xx responses
during an autocannon run fail the suite immediately.

Tunables: `PERF_DURATION_SECONDS` (autocannon duration per endpoint, default 3)
and `PERF_DB_SAMPLES` (database samples, default 200).

## Updating baselines

Run `npm run perf:update` on a dedicated `perf` branch only after confirming
the new numbers are intentional. It writes the measured values to
`baselines/latest.json`; commit that file with the change. The next `npm run
perf` enforces the stricter of the new baseline and the published budget, so a
slower baseline immediately becomes the new gate. Never refresh baselines just
to silence a regression.

## Scenarios

| Scenario                              |             Budget |
| ------------------------------------- | -----------------: |
| `POST /api/tasks` throughput / P95    | 100 req/s / 200 ms |
| `GET /api/agents` throughput / P95    | 100 req/s / 100 ms |
| `GET /api/tasks/:id` throughput / P95 | 100 req/s / 100 ms |
| 100 concurrent jobs completed         |               30 s |
| 20 poison jobs dead-lettered          |                5 s |
| `listAgents(limit=50)` P99            |              10 ms |
| `getTask(id)` P99                     |               5 ms |
