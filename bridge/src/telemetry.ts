import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  metrics,
  type Counter,
  type Histogram,
  type UpDownCounter,
} from "@opentelemetry/api";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("telemetry");

const serviceName = process.env.OTEL_SERVICE_NAME ?? "ook-bridge";
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdk: NodeSDK | null = null;

export interface BridgeMetrics {
  requestLatency: Histogram;
  requestCount: Counter;
  errorCount: Counter;
  activeConnections: UpDownCounter;
  messagesIn: Counter;
  messagesOut: Counter;
}

let bridgeMetrics: BridgeMetrics | null = null;

export function initTelemetry(): void {
  if (!otlpEndpoint) {
    log.info("OTEL_EXPORTER_OTLP_ENDPOINT not set, telemetry disabled");
    return;
  }

  log.info({ endpoint: otlpEndpoint }, "Initializing OpenTelemetry");

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${otlpEndpoint}/v1/metrics`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 10000,
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
  });

  sdk.start();
  log.info("OpenTelemetry initialized");
}

export function getMetrics(): BridgeMetrics {
  if (bridgeMetrics) {
    return bridgeMetrics;
  }

  const meter = metrics.getMeter("ook-bridge", "0.1.0");

  bridgeMetrics = {
    requestLatency: meter.createHistogram("ook.request.latency", {
      description: "Request-response latency in milliseconds",
      unit: "ms",
    }),
    requestCount: meter.createCounter("ook.request.count", {
      description: "Total number of requests by method",
    }),
    errorCount: meter.createCounter("ook.error.count", {
      description: "Total number of errors by type",
    }),
    activeConnections: meter.createUpDownCounter("ook.connection.active", {
      description: "Number of active WebSocket connections",
    }),
    messagesIn: meter.createCounter("ook.messages.in", {
      description: "Messages received from WebSocket",
    }),
    messagesOut: meter.createCounter("ook.messages.out", {
      description: "Messages sent to WebSocket",
    }),
  };

  return bridgeMetrics;
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    log.info("Shutting down OpenTelemetry");
    await sdk.shutdown();
  }
}
