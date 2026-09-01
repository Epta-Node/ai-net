# Backend performance budgets

Run the list, submit, and authenticated stream latency checks locally with:

```bash
npm run test:performance
```

Budgets live in `budgets.json` and are evaluated independently at p50, p95,
and p99. Override the default 15 measured samples and 3 warmups with
`PERF_SAMPLES` and `PERF_WARMUPS`. A breached budget exits non-zero; in GitHub
Actions each percentile is also emitted as an annotation.
