import { WebSocketServer, WebSocket } from 'ws';

/**
 * `TaskDetailPage` opens a raw WebSocket to `ws://localhost:3001/tasks/:id/stream`
 * (see `useTaskWebSocket`) and shows a connection-status chip that cycles
 * connecting → error → disconnected → (backoff) → connecting when nothing is
 * listening on that port. That cycle lands the chip in a different state on
 * every run, so the task-detail snapshot needs a real listener to settle on
 * "connected" and stay there — the same approach `tests/e2e/task-monitoring.spec.ts`
 * uses for the same reason.
 */
export async function startMockTaskSocket(): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port: 3001 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  return wss;
}

export async function stopMockTaskSocket(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.close();
  }
  await new Promise<void>((resolve, reject) => {
    wss.close((err) => (err ? reject(err) : resolve()));
  });
}
