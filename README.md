# OOK

Glue layer connecting Zed's local agent model to a remote, containerized coding agent.

## Problem

Zed expects coding agents to run as local subprocesses. I want my agent running in a Docker container on a remote VM for isolation and flexibility.

## Solution

Implement the [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction) across two components that bridge this gap.

## Architecture

```
┌─────────────────┐         WebSocket/Tailscale         ┌──────────────────────────┐
│   Local Mac     │                                     │   Lima VM (sandbox)      │
│                 │                                     │                          │
│  ┌───────────┐  │                                     │  ┌────────────────────┐  │
│  │    Zed    │  │                                     │  │  Docker Container  │  │
│  │           │  │                                     │  │                    │  │
│  │  ┌─────┐  │  │         ACP over WebSocket          │  │  ┌──────────────┐  │  │
│  │  │ Ook │◄─┼──┼─────────────────────────────────────┼──┼─►│  Ook Bridge  │  │  │
│  │  │ Ext │  │  │                                     │  │  │      │       │  │  │
│  │  └─────┘  │  │                                     │  │  │      │ stdio │  │  │
│  │           │  │                                     │  │  │      ▼       │  │  │
│  └───────────┘  │                                     │  │  │ claude-code  │  │  │
│                 │                                     │  │  │    -acp      │  │  │
└─────────────────┘                                     │  │  └──────────────┘  │  │
                                                        │  │                    │  │
                                                        │  └────────────────────┘  │
                                                        │                          │
                                                        └──────────────────────────┘
```

## Components

### 1. Local Agent Extension (Ook Extension)

A Zed agent extension written in Rust that proxies ACP messages to the remote agent.

**Responsibilities:**
- Implement the Zed Agent Extension interface
- Establish WebSocket connection to remote agent
- Proxy ACP JSON-RPC messages bidirectionally
- Handle connection lifecycle (reconnect on drop, attempt session resume)

**Configuration:**
- Remote host: defaults to `lima-<hostname>-sandbox` (Tailscale hostname)
- Remote port: defaults to `8647`
- Configurable via Zed extension settings

**Transport:**
- WebSocket over Tailscale network
- Tailscale handles authentication/encryption
- No additional auth layer needed

**Connection Behavior:**
- Single-user (one connection at a time)
- On disconnect: attempt reconnect and resume session
- Fail fast if remote is unreachable on initial connect

### 2. Remote Agent (Ook Bridge + Container)

A wrapper process that bridges WebSocket to stdio, running `claude-code-acp` in a Docker container.

**Components:**
- **Ook Bridge**: WebSocket server (port 8647) that manages `claude-code-acp`, translating WebSocket frames to stdio JSON-RPC
- **claude-code-acp**: Anthropic's [reference implementation](https://github.com/zed-industries/claude-code-acp), unmodified, communicating via stdio

**Lifecycle:**
- Bridge and container managed externally (systemd, manual, etc.)
- Bridge listens on WebSocket port, waits for connection
- `claude-code-acp` spawned and kept running by the bridge
- Single-user: one active session at a time

**Container:**
- Base image: Distroless Node.js
- Additional tooling via devcontainers mounted as needed
- Runs on Lima VM, reachable only via Tailscale

**Observability (OpenTelemetry):**
- Export: OTLP collector endpoint
- Logging: JSON structured, all traffic logged by default
- Metrics: Golden signals (latency, traffic, errors, saturation)
- Tracing: Request spans through the bridge

**TODO:**
- Health/readiness endpoints

### Authentication

- **Network**: Tailscale provides encrypted transport and identity
- **Claude API**: Manual login (interactive auth flow)

## Infrastructure (Out of Scope)

The following are managed separately:
- Lima VM provisioning
- Tailscale setup
- Devcontainer tooling
- CI/CD

## Protocol Notes

ACP uses JSON-RPC over various transports:
- Local agents: stdio (what `claude-code-acp` expects)
- Remote agents: HTTP or WebSocket (work in progress in spec)

We use WebSocket for the remote transport because:
- Bidirectional streaming fits the interactive agent model
- Built-in framing for JSON-RPC messages
- Connection keepalives
- Aligns with ACP's direction for remote agents

## Development

TBD - Implementation plan to follow.
