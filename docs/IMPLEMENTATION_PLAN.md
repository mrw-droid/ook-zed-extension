# Ook Implementation Plan

This document outlines the implementation steps for both Ook components.

## Overview

Two components to build:

1. **Ook Extension** (Rust/WASM) - Zed agent extension that proxies ACP to remote
2. **Ook Bridge** (Node.js/TypeScript) - WebSocket-to-stdio bridge for `claude-code-acp`

## Component 1: Ook Bridge (Remote)

Build the bridge first since it's simpler to test standalone and the extension depends on it.

### 1.1 Project Setup

- Initialize Node.js/TypeScript project
- Dependencies:
  - `ws` - WebSocket server
  - `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http` - Telemetry
  - `pino` - JSON structured logging
- TypeScript config targeting Node 20+ (matches distroless node image)
- ESLint/Prettier for consistency

### 1.2 Core Bridge Implementation

**WebSocket Server:**
- Listen on port 8647 (configurable via env)
- Accept single connection (reject additional connections while one is active)
- Handle connection lifecycle (open, close, error)

**Process Management:**
- Spawn `claude-code-acp` as child process on connection
- Pipe WebSocket messages → child stdin (NDJSON format)
- Pipe child stdout → WebSocket messages
- Handle child stderr (log it)
- Kill child on WebSocket disconnect
- Handle child exit (close WebSocket with appropriate error)

**Message Handling:**
- ACP uses newline-delimited JSON (NDJSON)
- WebSocket receives text frames, each containing one JSON-RPC message
- Forward to child stdin with newline terminator
- Read child stdout line-by-line, send each line as WebSocket text frame

### 1.3 Session Resume Support

- On WebSocket reconnect, check if `claude-code-acp` process is still alive
- If alive, reattach WebSocket to existing process
- If dead, spawn new process
- Track session state to determine if resume is possible

### 1.4 OpenTelemetry Instrumentation

**Metrics (Golden Signals):**
- `ook.request.latency` - Histogram of request-response times
- `ook.request.count` - Counter of requests by method
- `ook.error.count` - Counter of errors by type
- `ook.connection.active` - Gauge of active connections (0 or 1)

**Logging:**
- All inbound messages (WebSocket → process)
- All outbound messages (process → WebSocket)
- Connection events
- Process lifecycle events
- Errors with full context

**Tracing:**
- Span per JSON-RPC request (correlate by `id`)
- Child spans for process I/O
- Propagate trace context if provided by client

### 1.5 Dockerfile

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# claude-code-acp installed globally or bundled
EXPOSE 8647
CMD ["dist/index.js"]
```

Note: May need to iterate on base image if distroless lacks required system deps.

### 1.6 Configuration

Environment variables:
- `OOK_PORT` - WebSocket port (default: 8647)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTLP collector endpoint
- `OTEL_SERVICE_NAME` - Service name for telemetry (default: ook-bridge)
- `LOG_LEVEL` - Logging level (default: info)

---

## Component 2: Ook Extension (Local)

### 2.1 Project Setup

- Zed extension structure:
  ```
  ook-extension/
  ├── extension.toml
  ├── Cargo.toml
  ├── src/
  │   └── lib.rs
  └── icon.svg
  ```
- Cargo.toml with `crate-type = ["cdylib"]` for WASM
- Dependency: `zed_extension_api`

### 2.2 Extension Manifest

```toml
[extension]
id = "ook"
name = "Ook"
version = "0.1.0"
schema_version = 1
authors = ["Matt"]
description = "Remote Claude Code agent via Ook Bridge"
repository = "https://github.com/..."

[agent]
# Agent-specific configuration TBD based on Zed's agent extension API
```

### 2.3 Research Gap: Agent Extension API

The current `zed_extension_api` (v0.7.0) doesn't expose agent-specific traits. Options:

1. **Wait for official API** - Zed's agent extension support is new; API may be in flux
2. **Inspect existing agent extensions** - Look at how Zed's built-in Claude Code works
3. **Use MCP server approach** - Register as MCP server instead of agent (different UX)
4. **Direct integration** - Fork/contribute to Zed if needed

**Recommended approach:** Start with the bridge (it's transport-agnostic), then revisit the extension once Zed's agent API stabilizes or by examining their source.

### 2.4 WebSocket Client Implementation

Regardless of the Zed API, the extension needs:

**Connection Management:**
- Connect to `ws://<remote-host>:8647`
- Default remote host: `lima-<hostname>-sandbox`
- Handle connection errors gracefully
- Implement reconnect with exponential backoff

**Message Proxying:**
- Receive ACP messages from Zed (via whatever interface Zed provides)
- Forward to WebSocket as text frames
- Receive WebSocket messages, forward to Zed
- No transformation needed—pure passthrough

**Session Resume:**
- On reconnect, attempt to resume existing session
- ACP may have session tokens or IDs to track
- If resume fails, notify Zed of session loss

### 2.5 Configuration

Zed extension settings (mechanism TBD):
- `ook.remote_host` - Override default hostname
- `ook.remote_port` - Override default port (8647)

---

## Implementation Order

### Phase 1: Bridge MVP
1. Project setup with TypeScript, WebSocket, basic logging
2. Core message proxying (WebSocket ↔ stdio)
3. Process spawning and lifecycle management
4. Manual testing with `wscat` or similar

### Phase 2: Bridge Hardening
1. OpenTelemetry integration
2. Session resume logic
3. Dockerfile and container testing
4. Error handling edge cases

### Phase 3: Extension Research
1. Deep dive into Zed's agent extension source code
2. Identify the actual API/traits for agent extensions
3. Determine if additional Zed contribution is needed

### Phase 4: Extension Implementation
1. Scaffold extension structure
2. Implement WebSocket client in Rust/WASM
3. Wire up to Zed's agent interface
4. Test end-to-end

### Phase 5: Integration Testing
1. Full flow: Zed → Extension → Bridge → claude-code-acp
2. Reconnection scenarios
3. Error propagation
4. Telemetry validation

---

## Open Questions

1. **Zed Agent API** - Need to examine Zed source or wait for docs. The public extension API doesn't expose agent traits yet.

2. **WASM WebSocket** - Need to verify Zed's WASM environment supports WebSocket. May need to use Zed-provided networking primitives instead.

3. **claude-code-acp installation** - Should it be baked into the container image or installed at runtime? Baking in is simpler but less flexible.

4. **Session state persistence** - If the bridge restarts, can sessions survive? Probably not without external state storage (out of scope for v1).

---

## File Structure

```
ook/
├── README.md
├── docs/
│   └── IMPLEMENTATION_PLAN.md
├── bridge/                    # Ook Bridge (Node.js)
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── src/
│       ├── index.ts          # Entry point
│       ├── server.ts         # WebSocket server
│       ├── process.ts        # Child process management
│       ├── telemetry.ts      # OpenTelemetry setup
│       └── logger.ts         # Pino logger config
└── extension/                 # Ook Extension (Rust)
    ├── extension.toml
    ├── Cargo.toml
    ├── icon.svg
    └── src/
        └── lib.rs            # Extension implementation
```
