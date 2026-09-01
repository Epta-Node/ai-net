import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../src/api';
import { MetricsService } from '../src/services/metrics';
import { generatePrometheusMetrics } from '../src/services/prometheus';

// ---------------------------------------------------------------------------
// Unit tests for the Prometheus text formatter
// ---------------------------------------------------------------------------

describe('generatePrometheusMetrics', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({ disableCompression: true, enableQueueWorker: false });
  });

  afterAll(() => {
    app.close();
  });

  it('returns a text/plain response', async () => {
    const res = await request(app.httpServer).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('includes the ainet_up gauge', async () => {
    const res = await request(app.httpServer).get('/metrics');
    expect(res.text).toContain('ainet_up 1');
  });

  it('includes HELP and TYPE annotations', async () => {
    const res = await request(app.httpServer).get('/metrics');
    expect(res.text).toContain('# HELP ainet_up');
    expect(res.text).toContain('# TYPE ainet_up gauge');
  });

  it('includes HTTP metrics annotations', async () => {
    const res = await request(app.httpServer).get('/metrics');
    expect(res.text).toContain('# HELP ainet_http_requests_total');
    expect(res.text).toContain('# TYPE ainet_http_requests_total counter');
  });

  it('includes process memory gauges', async () => {
    const res = await request(app.httpServer).get('/metrics');
    expect(res.text).toContain('ainet_process_memory_rss_bytes');
    expect(res.text).toContain('ainet_process_memory_heap_used_bytes');
  });

  it('includes uptime gauge', async () => {
    const res = await request(app.httpServer).get('/metrics');
    expect(res.text).toContain('ainet_process_uptime_seconds');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for the pure formatting functions (indirectly via generatePrometheusMetrics)
// ---------------------------------------------------------------------------

describe('Prometheus metric families', () => {
  it('generates valid Prometheus text exposition format', () => {
    const output = generatePrometheusMetrics();

    // Every metric line should either start with # (comment/annotation) or
    // be a metric_name{labels} value line.
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      if (line.startsWith('#')) {
        // Comment lines must start with # HELP or # TYPE
        expect(line).toMatch(/^# (HELP|TYPE) \w+/);
      } else {
        // Metric lines: metric_name{labels} value or metric_name value
        expect(line).toMatch(/^[a-z_][a-z0-9_]*(\{[^}]+\})?\s+[\d.e+-]+$/);
      }
    }
  });

  it('includes histogram bucket format for HTTP latency', () => {
    const output = generatePrometheusMetrics();
    // Should have _bucket, _sum, and _count suffixes for histograms
    if (output.includes('ainet_http_request_duration_milliseconds')) {
      expect(output).toContain('ainet_http_request_duration_milliseconds_bucket');
      expect(output).toContain('ainet_http_request_duration_milliseconds_sum');
      expect(output).toContain('ainet_http_request_duration_milliseconds_count');
    }
  });
});
