/**
 * Trace propagation tests for Issue #407.
 *
 * Verifies the two acceptance criteria:
 *   1. A single task user journey shares one traceId across every hop
 *      (REST request → agent task → payment call).
 *   2. Admin can query a trace for a requestId, and non-admin access is
 *      rejected.
 *
 * These tests are self-contained: they drive the TracingService and
 * Coordinator directly (with the AsyncLocalStorage context) and exercise the
 * admin route through an isolated Express app, so they are independent of any
 * persisted SQLite state.
 */

import request from 'supertest';
import express from 'express';
import { randomUUID } from 'crypto';

import { tracingService } from '../src/services/tracing';
import {
  runWithTraceContext,
  currentTraceId,
} from '../src/services/traceContext';
import { Coordinator } from '../src/coordinator/coordinator';
import type { DAGNode } from '../src/types/task';
import { createAdminQueueRouter } from '../src/api/routes/admin';

// ── Acceptance criterion 2: admin trace-view route ──────────────────────────

describe('Trace propagation acceptance criteria', () => {
  describe('criterion 1: a single task user journey shares one traceId', () => {
    const traceId = `trace-${randomUUID()}`;
    const spanIds: string[] = [];
    const hops: Array<{ service: string; operation: string }> = [
      { service: 'backend', operation: 'http_request' },
      { service: 'coordinator', operation: 'executeDAG' },
      { service: 'coordinator', operation: 'node_execution' },
      { service: 'payment', operation: 'release' },
    ];

    beforeAll(async () => {
      // Establish an AsyncLocalStorage trace context, simulating a REST request
      // that seeds traceId + a fresh spanId.
      await runWithTraceContext(
        { traceId, spanId: randomUUID(), requestId: `req-${traceId}` },
        async () => {
          // REST hop span.
          const httpSpan = tracingService.startSpan(traceId, 'backend', 'http_request', {
            requestId: `req-${traceId}`,
          });
          spanIds.push(httpSpan.spanId);

          // Coordinator with an in-memory agent-registry lookup and a mocked
          // HTTP dispatch (fetch). Payment release is a real call bound with a
          // traceId resolved from the AsyncLocalStorage context.
          const coordinator = new Coordinator({
            correlationId: currentTraceId(),
            eventBus: ({
              emit: () => false,
              subscribe: () => () => {},
              subscribeAll: () => () => {},
            }) as unknown as typeof import('../src/coordinator/eventBus').eventBus,
            timeoutMs: 2000,
            fetch: (async () => ({
              ok: true,
              status: 200,
              statusText: 'OK',
              text: async () => JSON.stringify({ summary: 'ok', sections: ['ok'] }),
            })) as unknown as typeof fetch,
            agentRegistry: {
              getAgents: async (agentType: string) => [
                {
                  id: `agent-${agentType}`,
                  type: agentType,
                  endpoint: 'http://127.0.0.1:1',
                  cost: 1,
                  status: 'online' as const,
                },
              ],
            },
            paymentService: {
              release: async (taskId: string, nodeId: string) => {
                // Payment hop — inside the AsyncLocalStorage context, so it
                // resolves traceId implicitly via the logger/context chain.
                const releaseSpan = tracingService.startSpan(
                  currentTraceId()!,
                  'payment',
                  'release',
                  { taskId, nodeId },
                );
                spanIds.push(releaseSpan.spanId);
                tracingService.endSpan(releaseSpan.spanId, 'completed', { txHash: 'mock' });
                return 'mock-hash';
              },
            },
          });

          const dag: DAGNode[] = [
            {
              nodeId: 'node_research',
              type: 'research',
              dependencies: [],
              status: 'pending',
              prompt: 'research topic',
            },
            {
              nodeId: 'node_report',
              type: 'report',
              dependencies: ['node_research'],
              status: 'pending',
              prompt: 'write report',
            },
          ];

          // Run the full DAG. The coordinator opens executeDAG + node_execution
          // spans, then releases payment per node — all under the same
          // AsyncLocalStorage context established above.
          await coordinator.executeDAG('task_multi_hop', dag);

          tracingService.endSpan(httpSpan.spanId, 'completed');
        },
      );
    });

    afterAll(() => {
      tracingService.clearTrace(traceId);
    });

    it('records spans for every hop (REST, coordinator, payment)', () => {
      const trace = tracingService.getTrace(traceId);
      expect(trace).toBeDefined();
      const ops = new Set(trace!.spans.map((s) => s.operation));
      expect(ops.has('http_request')).toBe(true);
      expect(ops.has('executeDAG')).toBe(true);
      expect(ops.has('node_execution')).toBe(true);
      expect(ops.has('release')).toBe(true);
    });

    it('every span shares the same traceId', () => {
      const trace = tracingService.getTrace(traceId);
      for (const span of trace!.spans) {
        expect(span.correlationId).toBe(traceId);
      }
    });

    it('the trace carries a distinct spanId per hop', () => {
      const trace = tracingService.getTrace(traceId);
      const ids = trace!.spans.map((s) => s.spanId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('criterion 2: admin can query trace for a requestId (and non-admin is rejected)', () => {
    let app: express.Express;

    beforeAll(() => {
      process.env.ADMIN_API_KEY = 'test-admin-key';
      app = express();
      // Mount only the admin routes (which include the trace-view endpoint).
      const adminRouter = createAdminQueueRouter();
      app.use('/api/admin', adminRouter);
    });

    afterAll(() => {
      delete process.env.ADMIN_API_KEY;
    });

    it('returns the correlated trace when queried by requestId', async () => {
      const requestId = `req-${randomUUID()}`;
      const span = tracingService.startSpan('trace-view-1', 'backend', 'http_request', {
        requestId,
      });
      tracingService.endSpan(span.spanId, 'completed');

      try {
        const res = await request(app)
          .get(`/api/admin/traces/${requestId}`)
          .set('X-Admin-API-Key', 'test-admin-key');

        expect(res.status).toBe(200);
        expect(res.body.correlationId).toBe('trace-view-1');
        expect(res.body.requestedId).toBe(requestId);
        expect(res.body.spans.length).toBeGreaterThanOrEqual(1);
      } finally {
        tracingService.clearTrace('trace-view-1');
      }
    });

    it('returns 404 when no trace exists for a requestId', async () => {
      const res = await request(app)
        .get('/api/admin/traces/unknown-request-id')
        .set('X-Admin-API-Key', 'test-admin-key');

      expect(res.status).toBe(404);
    });

    it('rejects non-admin access with 401', async () => {
      const res = await request(app).get('/api/admin/traces/some-id');
      expect(res.status).toBe(401);
    });

    it('rejects a request with a wrong admin key', async () => {
      const res = await request(app)
        .get('/api/admin/traces/some-id')
        .set('X-Admin-API-Key', 'wrong-key');
      expect(res.status).toBe(401);
    });
  });

  describe('criterion 2 (extension): admin can query by traceId too', () => {
    let app: express.Express;

    beforeAll(() => {
      process.env.ADMIN_API_KEY = 'test-admin-key';
      app = express();
      app.use('/api/admin', createAdminQueueRouter());
    });

    afterAll(() => {
      delete process.env.ADMIN_API_KEY;
    });

    it('returns the trace when queried directly by correlationId', async () => {
      const correlationId = `trace-${randomUUID()}`;
      const span = tracingService.startSpan(correlationId, 'coordinator', 'executeDAG');
      tracingService.endSpan(span.spanId, 'completed');

      try {
        const res = await request(app)
          .get(`/api/admin/traces/${correlationId}`)
          .set('Authorization', 'Bearer test-admin-key');

        expect(res.status).toBe(200);
        expect(res.body.correlationId).toBe(correlationId);
      } finally {
        tracingService.clearTrace(correlationId);
      }
    });
  });
});
