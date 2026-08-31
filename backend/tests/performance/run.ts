import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';

type Percentile = 'p50' | 'p95' | 'p99';
type EndpointName = 'list' | 'submit' | 'stream';
type Budget = Record<Percentile, number>;
type Budgets = Record<EndpointName, Budget>;
type Measurements = Record<Percentile, number>;

const PERCENTILES: Array<{ name: Percentile; value: number }> = [
  { name: 'p50', value: 50 },
  { name: 'p95', value: 95 },
  { name: 'p99', value: 99 },
];
const SAMPLE_COUNT = Number(process.env.PERF_SAMPLES ?? 15);
const WARMUP_COUNT = Number(process.env.PERF_WARMUPS ?? 3);

function percentile(samples: number[], value: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function summarize(samples: number[]): Measurements {
  return Object.fromEntries(
    PERCENTILES.map(({ name, value }) => [name, percentile(samples, value)]),
  ) as Measurements;
}

async function measure(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

async function benchmark(operation: () => Promise<void>): Promise<Measurements> {
  for (let index = 0; index < WARMUP_COUNT; index += 1) await operation();

  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(await measure(operation));
  }
  return summarize(samples);
}

function requestJson(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        walletpublickey: 'GPERFORMANCEWALLET',
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {}),
      },
    }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`${method} ${path} returned ${response.statusCode}`));
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function report(results: Record<EndpointName, Measurements>, budgets: Budgets): boolean {
  let failed = false;
  console.log('\nBackend latency budgets (milliseconds)');
  console.log('endpoint\tpercentile\tactual\tbudget\tresult');

  for (const endpoint of Object.keys(results) as EndpointName[]) {
    for (const { name } of PERCENTILES) {
      const actual = results[endpoint][name];
      const budget = budgets[endpoint][name];
      const passed = actual <= budget;
      failed ||= !passed;
      console.log(`${endpoint}\t${name}\t${actual.toFixed(2)}\t${budget}\t${passed ? 'PASS' : 'FAIL'}`);

      if (process.env.GITHUB_ACTIONS === 'true') {
        const level = passed ? 'notice' : 'error';
        console.log(
          `::${level} title=${endpoint} ${name} latency::${actual.toFixed(2)}ms (budget ${budget}ms)`,
        );
      }
    }
  }

  return !failed;
}

async function main(): Promise<void> {
  if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1) throw new Error('PERF_SAMPLES must be a positive integer');
  if (!Number.isInteger(WARMUP_COUNT) || WARMUP_COUNT < 0) throw new Error('PERF_WARMUPS must be a non-negative integer');

  process.env.NODE_ENV = 'test';
  process.env.DAILY_TASK_LIMIT_PER_WALLET = '0';
  const originalCwd = process.cwd();
  const workingDirectory = mkdtempSync(join(tmpdir(), 'ai-net-performance-'));
  process.chdir(workingDirectory);

  const budgets = JSON.parse(
    readFileSync(join(__dirname, 'budgets.json'), 'utf8'),
  ) as Budgets;

  let closeApp: ((callback?: () => void) => void) | undefined;
  let closeStores: (() => void) | undefined;

  try {
    const [appModule, taskStoreModule, eventStoreModule, eventTypesModule, taskDbModule, jobStoreModule, dbModule, wsModule] = await Promise.all([
      import('../../src/api/app'),
      import('../../src/coordinator/taskStore'),
      import('../../src/events/eventStore'),
      import('../../src/events/eventTypes'),
      import('../../src/db/tasks'),
      import('../../src/queue/jobStore'),
      import('../../src/db'),
      import('ws'),
    ]);

    const eventStore = eventStoreModule.createEventStore();
    const streamTaskId = 'task_performance_stream';
    const walletPublicKey = 'GPERFORMANCEWALLET';
    const now = new Date().toISOString();
    taskStoreModule.createTask({
      id: streamTaskId,
      prompt: 'Performance stream fixture',
      walletPublicKey,
      status: 'queued',
      dag: [],
      createdAt: now,
      updatedAt: now,
    });
    eventStore.append({
      ...eventTypesModule.makeTaskCompleted(streamTaskId, now),
      taskSeq: 0,
    });

    const { httpServer, close } = appModule.createApp({
      eventStore,
      enableHeartbeatCleanup: false,
      enableQueueWorker: false,
      disableCompression: true,
      dispatch: async () => ({}),
      releasePayment: async () => 'performance-hash',
    });
    closeApp = close;
    closeStores = () => {
      eventStore.close();
      taskDbModule.closeTaskDb();
      jobStoreModule.closeJobDb();
      dbModule.closeDb();
    };

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    let submitIndex = 0;

    const results = {
      list: await benchmark(() => requestJson(port, '/api/tasks?page=1&pageSize=10', 'GET')),
      submit: await benchmark(() => {
        submitIndex += 1;
        return requestJson(port, '/api/tasks', 'POST', {
          prompt: `Performance task ${submitIndex}`,
          walletPublicKey: `GPERFORMANCE${submitIndex}`,
        });
      }),
      stream: await benchmark(() => new Promise<void>((resolve, reject) => {
        const socket = new wsModule.WebSocket(`ws://127.0.0.1:${port}/tasks/${streamTaskId}/stream`);
        let received = false;
        socket.once('open', () => socket.send(JSON.stringify({ walletPublicKey })));
        socket.once('message', () => {
          received = true;
          socket.close();
        });
        socket.once('close', () => received ? resolve() : reject(new Error('Stream closed before replay')));
        socket.once('error', reject);
      })),
    } satisfies Record<EndpointName, Measurements>;

    if (!report(results, budgets)) process.exitCode = 1;
  } finally {
    if (closeApp) await new Promise<void>((resolve) => closeApp?.(resolve));
    closeStores?.();
    process.chdir(originalCwd);
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
