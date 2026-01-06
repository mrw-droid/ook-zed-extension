# Ook - Zed Extension for Remote Claude Code Agent

## What This Is

Ook is a WebSocket bridge that lets Zed talk to `claude-code-acp` running in a remote Docker container. Zed expects agents as local subprocesses; this fakes that by proxying ACP messages over the network.

```
Zed <--stdio--> Ook Extension (local) <--WebSocket--> Ook Bridge (remote) <--stdio--> claude-code-acp
```

Transport is WebSocket over Tailscale. No additional auth—Tailscale handles identity.

## Architecture

### Agent (Rust, runs locally in Zed)
- `agent/src/main.rs` - WebSocket client, bidirectional stdin/stdout ↔ WebSocket proxy
- Logs to stderr, stdout reserved for ACP messages
- Config via env: `OOK_REMOTE_HOST` (default: `lima-<hostname>-sandbox`), `OOK_REMOTE_PORT` (default: `8647`)

### Bridge (Node.js/TypeScript, runs in Docker on remote VM)
- `bridge/src/server.ts` - WebSocket server, message routing, request tracking
- `bridge/src/process.ts` - Spawns/manages `claude-code-acp` subprocess
- `bridge/src/telemetry.ts` - OpenTelemetry metrics/traces
- Single-user mode: rejects additional connections while one active
- Session resume: reconnects reattach to existing process (no restart)

## Build Commands

```fish
# Build everything for local dev (extension + darwin agent)
make

# Individual targets
make agent-darwin-aarch64    # macOS ARM binary
make agent-linux-amd64       # Linux x86_64 (cross-compile)
make docker-aarch64          # Bridge Docker image for ARM
make docker-amd64            # Bridge Docker image for x86_64

# Install in Zed
make install-ext             # Then use Zed's "Install Dev Extension"

# Bridge dev
cd bridge
npm run build                # TypeScript compile
npm run dev                  # Watch mode
npm run lint                 # ESLint
npm run typecheck            # tsc --noEmit
```

## Running the Bridge

```fish
# On remote VM
nerdctl run -v /home/mrw.linux/.claude:/mnt/claude-source:ro \
  --tmpfs /home/node/.claude \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --net host ook-bridge:aarch64 \
  sh -c 'cp -a /mnt/claude-source/. /home/node/.claude/ && exec node dist/index.js'
```

Bridge env vars:
- `OOK_PORT` (default: 8647)
- `OOK_COMMAND` (default: `claude-code-acp`)
- `OOK_COMMAND_ARGS` (space-separated)
- `LOG_LEVEL` (default: info)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (optional, enables telemetry)

## Protocol

NDJSON over WebSocket. Each message is a JSON-RPC object terminated by newline. The bridge forwards verbatim between WebSocket and child process stdio.

## Key Design Decisions

1. **Single-user mode** - One connection at a time, rejects others with `1013`
2. **Session resume** - Reconnects reattach to living `claude-code-acp` process
3. **No auth layer** - Tailscale provides encryption + identity
4. **Zero env inheritance** - Only `ANTHROPIC_API_KEY` passed to child (security)
5. **Process kill** - SIGTERM, 5s wait, SIGKILL

## File Layout

```
agent/
  src/main.rs          # Extension binary (WebSocket client)
  extension/           # extension.toml, icon.svg for Zed
  Cargo.toml
bridge/
  src/
    index.ts           # Entry point
    server.ts          # WebSocket server
    process.ts         # Child process management
    logger.ts          # Pino JSON logging
    telemetry.ts       # OpenTelemetry setup
  Dockerfile
  package.json
docs/
  IMPLEMENTATION_PLAN.md
```

## Current State

- Bridge: Feature-complete with observability
- Extension: Functional, may need adjustment as Zed's agent API evolves
- Tests: Manual only (wscat for bridge, end-to-end via Zed)

## Gotchas

- Extension logs go to stderr (Zed captures), stdout is ACP-only
- Bridge expects `claude-code-acp` in PATH (installed via npm in Dockerfile)
- Default remote host assumes Lima VM naming convention (`lima-<hostname>-sandbox`)
- Makefile uses `cross` for Linux cross-compilation from macOS
