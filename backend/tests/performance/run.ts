import autocannon from 'autocannon';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import type { AddressInfo } from 'net';

type ApiEndpoint = 'POST /api/tasks' | 'GET /api/agents' | 'GET /api/tasks/:id';
type ApiMetric = 'throughputRps' | 'p95LatencyMs';
type ApiBudgets = Record<ApiEndpoint, Record<ApiMetric, number>>;

interface Budgets {
  api: ApiBudgets;
  queue: { enqueue100DurationMs: number; dlq20DurationMs: number };
  database: { listAgentsP99Ms: number; getTaskP99Ms: number };
}

type MetricDirection = 'min' | 'max';
type Checks = Record<
  string,
  { actual: number; budget: number; baseline: number; direction: MetricDirection }
>;

interface AutocannonResult {
  requests: { mean: number };
  latency: { p97_5: number };
  errors: number;
  non2xx: number;
}

const TOLERANCE = 0.1;
const API_ENDPOINTS: ApiEndpoint[] = ['POST /api/tasks', 'GET /api/agents', 'GET /api/tasks/:id'];
const DURATION_SECONDS = Number(process.env.PERF_DURATION_SECONDS ?? 3);
const DB_SAMPLES = Number(process.env.PERF_DB_SAMPLES ?? 200);
const DB_WARMUPS = 50;
const DB_PASSES = 3;
const CONNECTIONS: Record<ApiEndpoint, number> = {
  'POST /api/tasks': 5,
  'GET /api/agents': 5,
  'GET /api/tasks/:id': 5,
};
const WALLET = 'GPERFORMANCEWALLET';
const UPDATE_BASELINE = process.argv.includes('--update');
const REPORT_DIRECTORY = join(process.cwd(), 'test-results', 'performance');

function percentile(samples: number[], value: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measureRepeated(operation: () => void): Promise<number> {
  for (let index = 0; index < DB_WARMUPS; index += 1) operation();
  const passResults: number[] = [];
  for (let pass = 0; pass < DB_PASSES; pass += 1) {
    const samples: number[] = [];
    for (let index = 0; index < DB_SAMPLES; index += 1) {
      const startedAt = performance.now();
      operation();
      samples.push(performance.now() - startedAt);
    }
    passResults.push(percentile(samples, 99));
  }
  return Math.min(...passResults);
}

async function runAutocannon(
  options: Parameters<typeof autocannon>[0]
): Promise<{ result: AutocannonResult; p95LatencyMs: number }> {
  return new Promise((resolve, reject) => {
    const latencies: number[] = [];
    const instance = autocannon(options, (error: unknown, rawResult: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      const result = rawResult as AutocannonResult;
      resolve({
        result,
        p95LatencyMs: latencies.length > 0 ? percentile(latencies, 95) : result.latency.p97_5,
      });
    });
    instance.on(
      'response',
      (_client: unknown, _statusCode: number, _bytes: number, responseTime: number) => {
        latencies.push(responseTime);
      }
    );
  });
}

async function benchmarkEndpoint(
  port: number,
  endpoint: ApiEndpoint,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>
): Promise<Record<ApiMetric, number>> {
  const headers: Record<string, string> = { walletpublickey: WALLET };
  if (method === 'GET') headers['x-cache-bypass'] = '1';
  if (body) headers['content-type'] = 'application/json';

  const { result, p95LatencyMs } = await runAutocannon({
    url: `http://127.0.0.1:${port}${path}`,
    connections: CONNECTIONS[endpoint],
    duration: DURATION_SECONDS,
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (result.errors > 0 || result.non2xx > 0) {
    throw new Error(
      `${endpoint} benchmark failed: ${result.errors} connection errors, ${result.non2xx} non-2xx responses`
    );
  }
  return {
    throughputRps: result.requests.mean,
    p95LatencyMs,
  };
}

function threshold(budget: number, baseline: number, direction: MetricDirection): number {
  return direction === 'max'
    ? Math.min(budget, baseline) * (1 + TOLERANCE)
    : Math.max(budget, baseline) * (1 - TOLERANCE);
}

function passes(actual: number, limit: number, direction: MetricDirection): boolean {
  return direction === 'max' ? actual <= limit : actual >= limit;
}

function printReport(checks: Checks): boolean {
  let passed = true;
  console.log('\nBackend performance regression report');
  console.log('metric\tactual\tbudget\tbaseline\tlimit\tstatus');
  for (const [metric, check] of Object.entries(checks)) {
    const limit = threshold(check.budget, check.baseline, check.direction);
    const ok = passes(check.actual, limit, check.direction);
    passed &&= ok;
    console.log(
      `${metric}\t${check.actual.toFixed(2)}\t${check.budget}\t${check.baseline}\t${limit.toFixed(2)}\t${ok ? 'PASS' : 'FAIL'}`
    );
    if (process.env.GITHUB_ACTIONS === 'true') {
      const level = ok ? 'notice' : 'error';
      console.log(
        `::${level} title=${metric}::${check.actual.toFixed(2)} (limit ${limit.toFixed(2)})`
      );
    }
  }
  return passed;
}

function writeReports(checks: Checks, passed: boolean): void {
  mkdirSync(REPORT_DIRECTORY, { recursive: true });

  const measurements: Record<string, number> = Object.fromEntries(
    Object.entries(checks).map(([metric, check]) => [metric, check.actual])
  );
  const jsonReport = {
    generatedAt: new Date().toISOString(),
    passed,
    tolerance: TOLERANCE,
    measurements,
    checks: Object.fromEntries(
      Object.entries(checks).map(([metric, check]) => [
        metric,
        {
          ...check,
          limit: threshold(check.budget, check.baseline, check.direction),
          passed: passes(
            check.actual,
            threshold(check.budget, check.baseline, check.direction),
            check.direction
          ),
        },
      ])
    ),
  };
  writeFileSync(join(REPORT_DIRECTORY, 'report.json'), `${JSON.stringify(jsonReport, null, 2)}\n`);

  const markdown = [
    '# Backend performance report',
    '',
    `- Result: **${passed ? 'PASS' : 'FAIL'}**`,
    `- Generated: ${jsonReport.generatedAt}`,
    `- Tolerance: ${TOLERANCE * 100}%`,
    '',
    '| Metric | Actual | Budget | Baseline | Limit | Status |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...Object.entries(checks).map(([metric, check]) => {
      const limit = threshold(check.budget, check.baseline, check.direction);
      const ok = passes(check.actual, limit, check.direction);
      return `| ${metric} | ${check.actual.toFixed(2)} | ${check.budget} | ${check.baseline} | ${limit.toFixed(2)} | ${ok ? 'PASS' : 'FAIL'} |`;
    }),
    '',
  ].join('\n');
  writeFileSync(join(REPORT_DIRECTORY, 'report.md'), markdown);
}

function updateBaselines(checks: Checks): void {
  const measurements: Record<string, number> = Object.fromEntries(
    Object.entries(checks).map(([metric, check]) => [metric, check.actual])
  );
  const directory = join(__dirname, 'baselines');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'latest.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), measurements }, null, 2)}\n`
  );
  console.log(`Updated ${join(directory, 'latest.json')}`);
}

async function waitForJobs(
  store: { findById(id: string): { status: string } | undefined },
  ids: string[],
  status: string,
  timeoutMs: number
): Promise<number> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (ids.every((id) => store.findById(id)?.status === status)) {
      return performance.now() - startedAt;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${ids.length} jobs to reach ${status}`);
}

async function main(): Promise<void> {
  if (!Number.isInteger(DURATION_SECONDS) || DURATION_SECONDS < 1) {
    throw new Error('PERF_DURATION_SECONDS must be a positive integer');
  }
  if (!Number.isInteger(DB_SAMPLES) || DB_SAMPLES < 1) {
    throw new Error('PERF_DB_SAMPLES must be a positive integer');
  }

  process.env.NODE_ENV = 'test';
  process.env.DAILY_TASK_LIMIT_PER_WALLET = '0';
  process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
  process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS = '100000';
  process.env.RATE_LIMIT_AUTHED_MAX_REQUESTS = '100000';

  const originalCwd = process.cwd();
  const workingDirectory = mkdtempSync(join(tmpdir(), 'ai-net-performance-'));
  process.chdir(workingDirectory);

  const budgets = JSON.parse(readFileSync(join(__dirname, 'budgets.json'), 'utf8')) as Budgets;
  const baselinePath = join(__dirname, 'baselines', 'latest.json');
  let baselineMeasurements: Record<string, number> = {};
  try {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      measurements?: Record<string, number>;
    };
    baselineMeasurements = baseline.measurements ?? {};
  } catch {
    if (!UPDATE_BASELINE) throw new Error(`Missing baseline file: ${baselinePath}`);
  }

  let closeApp: ((callback?: () => void) => void) | undefined;
  let closeAgentDb: (() => Promise<void>) | undefined;
  let closeStores: (() => Promise<void>) | undefined;

  try {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
    const moduleLoader = require('module') as any;
    const resolveFilename = moduleLoader._resolveFilename;
    moduleLoader._resolveFilename = function (
      request: string,
      parent: unknown,
      ...args: unknown[]
    ) {
      if (request.startsWith('.') && request.endsWith('.js')) {
        try {
          return resolveFilename.call(this, request.slice(0, -3), parent, ...args);
        } catch {
          // Fall through to the original specifier.
        }
      }
      return resolveFilename.call(this, request, parent, ...args);
    };

    const appModule = require('../../src/api/app') as typeof import('../../src/api/app');
    const taskStoreModule =
      require('../../src/coordinator/taskStore') as typeof import('../../src/coordinator/taskStore');
    const eventStoreModule =
      require('../../src/events/eventStore') as typeof import('../../src/events/eventStore');
    const eventTypesModule =
      require('../../src/events/eventTypes') as typeof import('../../src/events/eventTypes');
    const taskDbModule = require('../../src/db/tasks') as typeof import('../../src/db/tasks');
    const jobStoreModule =
      require('../../src/queue/jobStore') as typeof import('../../src/queue/jobStore');
    const workerModule =
      require('../../src/queue/worker') as typeof import('../../src/queue/worker');
    const agentDbModule = require('../../src/db/agents') as typeof import('../../src/db/agents');
    const dbModule = require('../../src/db') as typeof import('../../src/db');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const eventStore = eventStoreModule.createEventStore();
    const now = new Date().toISOString();
    const apiTaskId = 'task_performance_api';
    const streamTaskId = 'task_performance_stream';
    taskStoreModule.createTask({
      id: apiTaskId,
      prompt: 'Performance API fixture',
      walletPublicKey: WALLET,
      status: 'queued',
      dag: [],
      createdAt: now,
      updatedAt: now,
    });
    taskStoreModule.createTask({
      id: streamTaskId,
      prompt: 'Performance stream fixture',
      walletPublicKey: WALLET,
      status: 'queued',
      dag: [],
      createdAt: now,
      updatedAt: now,
    });
    eventStore.append({ ...eventTypesModule.makeTaskCompleted(streamTaskId, now), taskSeq: 0 });

    const agentDb = agentDbModule.createAgentDb(agentDbModule.getAgentDb());
    for (let index = 0; index < 60; index += 1) {
      agentDb.upsert({
        id: `performance_agent_${index}`,
        capabilities: ['coding'],
        pricingXLM: 1,
        endpoint: 'https://example.invalid',
        stellarPublicKey: `GPERFORMANCEAGENT${index}`,
        reputationScore: 3,
        lastSeenAt: now,
        status: 'online',
      });
    }

    const { httpServer, close } = appModule.createApp({
      eventStore,
      enableHeartbeatCleanup: false,
      enableQueueWorker: false,
      disableCompression: true,
      dispatch: async () => ({}),
      releasePayment: async () => 'performance-hash',
    });
    closeApp = close;
    closeAgentDb = async () => {
      await agentDbModule.closeAgentDb();
    };
    closeStores = async () => {
      eventStore.close();
      await taskDbModule.closeTaskDb();
      await jobStoreModule.closeJobDb();
      await dbModule.closeDb();
    };

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const [tasks, agents, taskById] = await Promise.all([
      benchmarkEndpoint(port, 'POST /api/tasks', '/api/tasks', 'POST', {
        prompt: 'Performance task',
        walletPublicKey: WALLET,
      }),
      benchmarkEndpoint(port, 'GET /api/agents', '/api/agents?limit=50', 'GET'),
      benchmarkEndpoint(port, 'GET /api/tasks/:id', `/api/tasks/${apiTaskId}`, 'GET'),
    ]);

    const store = jobStoreModule.createJobStore(jobStoreModule.getJobDb());
    const enqueue = (id: string, maxAttempts: number): void => {
      store.insert({
        id,
        taskId: `performance_task_${id}`,
        type: 'performance',
        payload: {},
        status: 'pending',
        priority: 'normal',
        progress: 0,
        attempts: 0,
        maxAttempts,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };

    const successWorker = new workerModule.JobWorker({
      jobStore: store,
      handler: async () => ({}),
      concurrency: 20,
      pollIntervalMs: 5,
      baseBackoffMs: 1,
      maxAttempts: 1,
    });
    successWorker.start();
    const successIds = Array.from({ length: 100 }, (_, index) => `perf_success_${index}`);
    for (const id of successIds) enqueue(id, 1);
    const enqueue100DurationMs = await waitForJobs(store, successIds, 'completed', 30_000);
    await successWorker.stop(1_000);

    const poisonWorker = new workerModule.JobWorker({
      jobStore: store,
      handler: async () => {
        throw new Error('poison job');
      },
      concurrency: 20,
      pollIntervalMs: 5,
      baseBackoffMs: 1,
      maxAttempts: 1,
    });
    poisonWorker.start();
    const poisonIds = Array.from({ length: 20 }, (_, index) => `perf_poison_${index}`);
    for (const id of poisonIds) enqueue(id, 1);
    const dlq20DurationMs = await waitForJobs(store, poisonIds, 'dead-letter', 5_000);
    await poisonWorker.stop(1_000);

    const taskDb = taskDbModule.createTaskDb(taskDbModule.getTaskDb());
    const listAgentsP99Ms = await measureRepeated(() => {
      agentDb.list({ limit: 50 });
    });
    const getTaskP99Ms = await measureRepeated(() => {
      taskDb.findById(apiTaskId);
    });

    const checks: Checks = {};
    const addCheck = (
      metric: string,
      actual: number,
      budget: number,
      direction: MetricDirection
    ): void => {
      checks[metric] = {
        actual,
        budget,
        baseline: baselineMeasurements[metric] ?? budget,
        direction,
      };
    };

    for (const endpoint of API_ENDPOINTS) {
      const values =
        endpoint === 'POST /api/tasks' ? tasks : endpoint === 'GET /api/agents' ? agents : taskById;
      addCheck(
        `${endpoint} throughputRps`,
        values.throughputRps,
        budgets.api[endpoint].throughputRps,
        'min'
      );
      addCheck(
        `${endpoint} p95LatencyMs`,
        values.p95LatencyMs,
        budgets.api[endpoint].p95LatencyMs,
        'max'
      );
    }
    addCheck(
      'queue enqueue100 durationMs',
      enqueue100DurationMs,
      budgets.queue.enqueue100DurationMs,
      'max'
    );
    addCheck('queue dlq20 durationMs', dlq20DurationMs, budgets.queue.dlq20DurationMs, 'max');
    addCheck(
      'database listAgents(limit=50) p99Ms',
      listAgentsP99Ms,
      budgets.database.listAgentsP99Ms,
      'max'
    );
    addCheck('database getTask(id) p99Ms', getTaskP99Ms, budgets.database.getTaskP99Ms, 'max');

    const passed = printReport(checks);
    if (UPDATE_BASELINE) {
      updateBaselines(checks);
      writeReports(checks, true);
      return;
    }

    writeReports(checks, passed);
    if (!passed) process.exitCode = 1;
  } finally {
    if (closeAgentDb) await closeAgentDb();
    if (closeApp) await new Promise<void>((resolve) => closeApp?.(resolve));
    await closeStores?.();
    process.chdir(originalCwd);
    try {
      rmSync(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`Could not remove temporary directory ${workingDirectory}: ${String(error)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
