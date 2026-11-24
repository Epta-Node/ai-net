/**
 * MetricsCollector — Issue #1002
 *
 * Singleton wrapper around prom-client that exposes all operational gauges,
 * counters and histograms required by the ai-net Prometheus endpoint.
 */
import client from "prom-client";

// Enable default Node.js metrics (process_cpu_seconds_total, etc.)
client.collectDefaultMetrics();

// ── Counters ─────────────────────────────────────────────────────────────────

export const tasksTotal = new client.Counter({
  name: "ainnet_tasks_total",
  help: "Total number of tasks by lifecycle status",
  labelNames: ["status"] as const,
});

export const paymentsXlmTotal = new client.Counter({
  name: "ainnet_payments_xlm_total",
  help: "Total XLM involved in payment operations",
  labelNames: ["operation"] as const,
});

// ── Gauges ───────────────────────────────────────────────────────────────────

export const agentsRegisteredTotal = new client.Gauge({
  name: "ainnet_agents_registered_total",
  help: "Current number of registered agents",
});

export const dlqSize = new client.Gauge({
  name: "ainnet_dlq_size",
  help: "Current number of jobs in the dead-letter queue",
});

export const websocketConnectionsActive = new client.Gauge({
  name: "ainnet_websocket_connections_active",
  help: "Number of currently active WebSocket connections",
});

// ── Histograms ───────────────────────────────────────────────────────────────

export const agentDispatchDurationSeconds = new client.Histogram({
  name: "ainnet_agent_dispatch_duration_seconds",
  help: "Duration in seconds from node_started to node_completed per agent dispatch",
  labelNames: ["agentType"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

// ── Registry ─────────────────────────────────────────────────────────────────

export const registry = client.register;

/**
 * Convenience: return the Prometheus text-format scrape payload.
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Content-Type header value expected by Prometheus scrapers.
 */
export const METRICS_CONTENT_TYPE = client.register.contentType;
