/**
 * WebSocket protocol types for the live task-stream endpoint
 * (ws://<host>/tasks/:id/stream).
 *
 * Handshake:
 *   1. Client connects and sends an {@link AuthMessage} as its FIRST message.
 *   2. Server validates ownership of the task; on mismatch it closes the
 *      socket with {@link WS_CLOSE.FORBIDDEN} (a 403-equivalent close frame).
 *   3. Server replays all past {@link DAGEvent}s from the store, then streams
 *      live events as they are emitted.
 *
 * Heartbeat:
 *   Server sends a {@link ServerPingMessage} every 30s and closes the socket
 *   with {@link WS_CLOSE.STALE} if the client does not reply with a
 *   {@link ClientPongMessage} within 10s.
 */

/** First message a client must send: proves which wallet owns the task. */
export interface AuthMessage {
  walletPublicKey: string;
}

/** Client's reply to a server heartbeat ping. */
export interface ClientPongMessage {
  type: 'pong';
}

/** Any message a client may send after the socket opens. */
export type ClientMessage = AuthMessage | ClientPongMessage;

/** Server heartbeat ping; the client must answer with a {@link ClientPongMessage}. */
export interface ServerPingMessage {
  type: 'ping';
}

/**
 * Application-defined WebSocket close codes (range 4000–4999 is reserved for
 * application use per RFC 6455). They mirror the HTTP status they represent so
 * clients can map a close frame back to a familiar meaning.
 */
export const WS_CLOSE = {
  /** Malformed handshake — first message was not a valid {@link AuthMessage}. */
  BAD_REQUEST: 4400,
  /** No auth message arrived before the handshake deadline. */
  AUTH_TIMEOUT: 4401,
  /** walletPublicKey does not own the task — HTTP 403 equivalent. */
  FORBIDDEN: 4403,
  /** Unknown taskId — HTTP 404 equivalent. */
  TASK_NOT_FOUND: 4404,
  /** Heartbeat pong not received in time; connection considered stale. */
  STALE: 4408,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];
