# ADR-005: Server-Sent Events over WebSockets

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** @Epta-Node/core

## Context

The frontend needs real-time updates for task status, agent heartbeat state,
and log streaming. The two main browser push-notification technologies are
WebSockets (full-duplex) and Server-Sent Events (SSE, unidirectional
server-to-client).

Key constraints:
- Updates flow from server to client (task status changes, log lines); the
  client never needs to send data on the same connection.
- Browser compatibility across modern Chromium, Firefox, and Safari.
- Simplicity: the streaming endpoint should be easy to implement, test, and
  proxy behind a CDN or load balancer.
- Reconnection handling: clients behind unstable mobile connections should
  reconnect automatically.

## Decision

Use **Server-Sent Events (SSE)** for all server-to-client streaming. The SSE
endpoint is at `GET /api/tasks/:id/stream` and emits `text/event-stream`
responses. The frontend uses the browser's native `EventSource` API.

SSE was chosen over WebSockets because:
1. **Unidirectional sufficiency**: all real-time data flows server → client;
   WebSockets' full-duplex capability is unused overhead.
2. **HTTP/1.1 compatibility**: SSE works over standard HTTP without the upgrade
   handshake, making it transparent to most proxies, CDNs, and load balancers.
3. **Built-in reconnection**: `EventSource` reconnects automatically with
   `Last-Event-ID` support; implementing the same for WebSockets requires
   application-level logic.
4. **Simpler server implementation**: an SSE endpoint is a plain HTTP handler
   that keeps the response stream open; no WebSocket library is required.
5. **Browser support**: `EventSource` is supported in all modern browsers
   without a polyfill.

## Consequences

**Positive:**
- No WebSocket library dependency in either frontend or backend.
- Automatic reconnection with event-ID replay simplifies client error handling.
- SSE streams pass through HTTP infrastructure (nginx, Vercel edge) without
  special WebSocket-upgrade configuration.

**Negative / trade-offs:**
- SSE connections are limited to ~6 per origin in HTTP/1.1 (resolved in HTTP/2
  with multiplexing); the frontend must manage open stream counts.
- If the product ever needs client-to-server streaming (e.g. streaming user
  input to a long-running task), a separate WebSocket or HTTP POST stream will
  be required.
- Some enterprise proxies buffer SSE responses; `X-Accel-Buffering: no` headers
  are required for Nginx deployments.
