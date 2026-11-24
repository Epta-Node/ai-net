/**
 * OpenTelemetry distributed tracing initialisation.
 *
 * Call `initTracing()` once at the very start of `src/index.ts` — before any
 * other import that touches Express, HTTP, or fetch — so that the
 * auto-instrumentations can patch the Node.js built-ins in time.
 *
 * Issue #998
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { BatchSpanProcessor, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "tracing" });

let sdk: NodeSDK | null = null;

export function initTracing(): void {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "ai-net-backend";
  const serviceVersion = process.env.npm_package_version ?? "0.1.0";

  // Build the span processor chain:
  //   - In development (or when OTLP endpoint unset): ConsoleSpanExporter so
  //     developers can see spans in stdout without running a collector.
  //   - When OTEL_EXPORTER_OTLP_ENDPOINT is set: BatchSpanProcessor →
  //     OTLPTraceExporter for production / staging.
  //
  // No span data is emitted when OTEL_EXPORTER_OTLP_ENDPOINT is unset and
  // NODE_ENV is production — the ConsoleSpanExporter is skipped in that case.

  const spanProcessors = [];

  const isDev = process.env.NODE_ENV !== "production";

  if (otlpEndpoint) {
    const otlpExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
    spanProcessors.push(new BatchSpanProcessor(otlpExporter));
    logger.info({ otlpEndpoint }, "OTLP trace exporter configured");
  } else if (isDev) {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    logger.info("Console span exporter active (dev mode)");
  } else {
    // Production with no OTLP endpoint: tracing is a no-op; nothing is logged.
    logger.info("Tracing disabled — set OTEL_EXPORTER_OTLP_ENDPOINT to enable");
  }

  sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
    }),
    spanProcessors,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy file-system instrumentation; keep http + express + fetch.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.info({ serviceName, serviceVersion }, "OpenTelemetry SDK initialised");
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    logger.info("OpenTelemetry SDK shut down");
  }
}
