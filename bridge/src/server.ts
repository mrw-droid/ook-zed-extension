import { WebSocketServer, WebSocket, type RawData } from "ws";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { createChildLogger } from "./logger.js";
import { ProcessManager } from "./process.js";
import { getMetrics } from "./telemetry.js";

const log = createChildLogger("server");
const tracer = trace.getTracer("ook-bridge", "0.1.0");

export interface ServerConfig {
  port: number;
  command: string;
  commandArgs: string[];
}

interface PendingRequest {
  startTime: number;
  method: string;
  span: Span;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private activeConnection: WebSocket | null = null;
  private processManager: ProcessManager | null = null;
  private config: ServerConfig;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private sessionAuthenticated = false;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  start(): void {
    const metrics = getMetrics();

    this.wss = new WebSocketServer({ port: this.config.port });
    log.info({ port: this.config.port }, "WebSocket server started");

    this.wss.on("connection", (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      log.info({ clientIp }, "Connection attempt");

      // Single-user: reject if already connected
      if (this.activeConnection && this.activeConnection.readyState === WebSocket.OPEN) {
        log.warn({ clientIp }, "Rejecting connection, already have active client");
        ws.close(1013, "Server busy - single user mode");
        return;
      }

      this.activeConnection = ws;
      metrics.activeConnections.add(1);
      log.info({ clientIp }, "Client connected");

      // Spawn or reattach to process
      this.ensureProcess();

      ws.on("message", (data: RawData) => {
        this.handleIncomingMessage(data);
      });

      ws.on("close", (code, reason) => {
        log.info({ code, reason: reason.toString() }, "Client disconnected");
        metrics.activeConnections.add(-1);
        this.activeConnection = null;

        // Kill process if session wasn't authenticated
        if (!this.sessionAuthenticated && this.processManager) {
          log.info("Session not authenticated, killing process");
          this.processManager.kill();
          this.processManager = null;
        }
        // TODO: Re-enable session resume for authenticated sessions
        // For now, always kill on disconnect
        if (this.processManager) {
          log.info("Killing process on disconnect (session resume disabled)");
          this.processManager.kill();
          this.processManager = null;
        }
        this.sessionAuthenticated = false;
      });

      ws.on("error", (err) => {
        log.error(err, "WebSocket error");
        metrics.errorCount.add(1, { type: "websocket" });
      });
    });

    this.wss.on("error", (err) => {
      log.error(err, "Server error");
    });
  }

  private ensureProcess(): void {
    // TODO: Re-enable session resume once authentication is implemented
    // if (this.sessionAuthenticated && this.processManager?.isRunning) {
    //   log.info({ pid: this.processManager.pid }, "Reattaching to existing process");
    //   return;
    // }

    // Always spawn fresh process (session resume disabled)
    if (this.processManager?.isRunning) {
      log.info({ pid: this.processManager.pid }, "Killing existing process (session resume disabled)");
      this.processManager.kill();
    }

    // Spawn new process
    this.processManager = new ProcessManager(
      this.config.command,
      this.config.commandArgs
    );

    this.processManager.on("message", (data) => {
      this.handleOutgoingMessage(data);
    });

    this.processManager.on("error", (err) => {
      log.error(err, "Process error");
      getMetrics().errorCount.add(1, { type: "process" });
      this.activeConnection?.close(1011, "Process error");
    });

    this.processManager.on("exit", (code, signal) => {
      log.info({ code, signal }, "Process exited");
      // Clear pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.span.setStatus({ code: SpanStatusCode.ERROR, message: "Process exited" });
        pending.span.end();
      }
      this.pendingRequests.clear();

      if (this.activeConnection?.readyState === WebSocket.OPEN) {
        this.activeConnection.close(1011, "Process exited");
      }
    });

    this.processManager.spawn();
  }

  private handleIncomingMessage(data: RawData): void {
    const metrics = getMetrics();
    const message = data.toString();

    metrics.messagesIn.add(1);
    log.info({ direction: "ws->process", message }, "Message received");

    // Try to parse for request tracking
    try {
      const parsed = JSON.parse(message);
      if (parsed.id !== undefined && parsed.method) {
        // This is a request, track it for latency
        const span = tracer.startSpan(`acp.${parsed.method}`);
        span.setAttribute("rpc.method", parsed.method);
        span.setAttribute("rpc.id", String(parsed.id));

        this.pendingRequests.set(parsed.id, {
          startTime: Date.now(),
          method: parsed.method,
          span,
        });

        metrics.requestCount.add(1, { method: parsed.method });
      }
    } catch {
      // Not valid JSON or no id/method - just forward it
    }

    // Forward to process
    if (!this.processManager?.send(message)) {
      log.error("Failed to send message to process");
      metrics.errorCount.add(1, { type: "send_failed" });
    }
  }

  private handleOutgoingMessage(data: string): void {
    const metrics = getMetrics();

    metrics.messagesOut.add(1);
    log.info({ direction: "process->ws", message: data }, "Message sending");

    // Try to parse for response tracking
    try {
      const parsed = JSON.parse(data);
      if (parsed.id !== undefined) {
        const pending = this.pendingRequests.get(parsed.id);
        if (pending) {
          const latency = Date.now() - pending.startTime;
          metrics.requestLatency.record(latency, { method: pending.method });

          if (parsed.error) {
            pending.span.setStatus({
              code: SpanStatusCode.ERROR,
              message: parsed.error.message,
            });
            metrics.errorCount.add(1, { type: "rpc_error", method: pending.method });
          } else {
            pending.span.setStatus({ code: SpanStatusCode.OK });

            // Mark session authenticated after successful initialize
            if (pending.method === "initialize" && !this.sessionAuthenticated) {
              log.info("Session authenticated (initialize succeeded)");
              this.sessionAuthenticated = true;
            }
          }

          pending.span.end();
          this.pendingRequests.delete(parsed.id);
        }
      }
    } catch {
      // Not valid JSON - just forward it
    }

    // Forward to WebSocket
    if (this.activeConnection?.readyState === WebSocket.OPEN) {
      this.activeConnection.send(data);
    } else {
      log.warn("No active connection to send message to");
    }
  }

  async stop(): Promise<void> {
    log.info("Stopping server");

    // Close active connection
    if (this.activeConnection) {
      this.activeConnection.close(1001, "Server shutting down");
      this.activeConnection = null;
    }

    // Kill process
    if (this.processManager) {
      this.processManager.kill();
      this.processManager = null;
    }

    // Close server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    log.info("Server stopped");
  }
}
